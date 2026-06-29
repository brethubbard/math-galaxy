// vosk-engine.js — the app's only speech engine: on-device recognition via
// vosk-browser.
//
// It runs a small Vosk model in the browser (WebAssembly), constrained to a
// GRAMMAR of number words only — which is what makes it reliably tell "thirteen"
// from "thirty" where a general-purpose recognizer can't. It's fully on-device:
// private (audio never leaves the device) and, once the model is cached, it
// works offline.
//
// The model (~40 MB) is downloaded EAGERLY at app start behind a loading screen
// (see prefetchModel / buildModel below + the boot flow in app.js), then cached
// persistently so later launches are instant and offline-capable.

import { extractCandidates } from './numbers.js';

// The vosk-browser UMD bundle (exposes a global `Vosk`). Pin a known version.
const VOSK_CDN = 'https://cdn.jsdelivr.net/npm/vosk-browser@0.0.8/dist/vosk.js';

// Default model location: same-origin so it can be cached for offline use (and
// to avoid CORS). Run scripts/get-vosk-model.sh to populate it.
export const VOSK_MODEL_URL = './models/vosk-model-small-en-us-0.15.tar.gz';

// Dedicated, persistent Cache Storage bucket for the model. Kept SEPARATE from
// the versioned app-shell cache so bumping the service worker's shell version
// never forces a 40 MB re-download. The service worker's global caches.match()
// finds the model here and serves it to vosk-browser's worker (online or off);
// sw.js deliberately preserves this cache across activations.
export const MODEL_CACHE = 'math-galaxy-model';

// Restrict recognition to number words 0..“one hundred …”. Everything the parser
// in numbers.js understands is here; '[unk]' lets it gracefully ignore the rest.
const NUMBER_WORDS =
  'zero oh one two three four five six seven eight nine ten ' +
  'eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen ' +
  'twenty thirty forty fifty sixty seventy eighty ninety hundred';
const GRAMMAR = JSON.stringify([NUMBER_WORDS, '[unk]']);

// vosk-browser is heavy to init, so load the library + model once and share them.
let modelPromise = null;
function loadLibrary() {
  if (window.Vosk) return Promise.resolve(window.Vosk);
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = VOSK_CDN; s.async = true;
    s.onload = () => window.Vosk ? resolve(window.Vosk) : reject(new Error('Vosk global missing'));
    s.onerror = () => reject(new Error('Failed to load vosk-browser from CDN'));
    document.head.appendChild(s);
  });
}
function getModel(url) {
  if (!modelPromise) {
    // Resolve to an ABSOLUTE url: vosk-browser fetches the model from inside its
    // Web Worker, where a relative path would resolve against the worker/CDN, not
    // this page. Absolute keeps it pointed at our own origin.
    const absUrl = new URL(url, location.href).href;
    modelPromise = loadLibrary().then((V) => V.createModel(absUrl)).catch((e) => {
      modelPromise = null; // allow a retry next time
      throw e;
    });
  }
  return modelPromise;
}

// --- Eager boot-time loading (with a real download progress bar) ---------------
//
// We split the heavy work into two visible phases so the loading screen can show
// meaningful status:
//   1) prefetchModel() — stream the ~40 MB model down with byte-level progress and
//      stash it in the persistent MODEL_CACHE.
//   2) buildModel()    — load the vosk-browser library and instantiate the model
//      (reads the bytes back from cache; no second download).

/**
 * Stream the model file down, reporting progress, and store it in MODEL_CACHE so
 * vosk-browser's worker (and offline launches) can read it without re-downloading.
 *
 * @param {(frac:number|null, received:number, total:number) => void} [onProgress]
 *   frac is 0..1 (or null when the server doesn't send Content-Length).
 */
export async function prefetchModel(onProgress) {
  const absUrl = new URL(VOSK_MODEL_URL, location.href).href;
  const haveCaches = 'caches' in self;

  // Already cached from a previous visit? Then there's nothing to download.
  if (haveCaches) {
    try {
      const cache = await caches.open(MODEL_CACHE);
      if (await cache.match(absUrl)) { if (onProgress) onProgress(1, 0, 0); return; }
    } catch (_) { /* fall through to a normal fetch */ }
  }

  const res = await fetch(absUrl);
  if (!res || !res.ok) throw new Error('model fetch failed: ' + (res ? res.status : 'no response'));
  const total = Number(res.headers.get('Content-Length')) || 0;

  // Stream so we can report progress as bytes arrive.
  if (res.body && res.body.getReader) {
    const reader = res.body.getReader();
    const chunks = [];
    let received = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      received += value.length;
      if (onProgress) onProgress(total ? received / total : null, received, total);
    }
    const blob = new Blob(chunks, { type: 'application/gzip' });
    if (haveCaches) {
      try {
        const cache = await caches.open(MODEL_CACHE);
        await cache.put(absUrl, new Response(blob, {
          headers: { 'Content-Type': 'application/gzip', 'Content-Length': String(blob.size) },
        }));
      } catch (_) { /* cache is a nicety; the model is in memory regardless */ }
    }
  } else {
    // No streaming support — just buffer the whole thing, no progress.
    const blob = await res.blob();
    if (onProgress) onProgress(1, blob.size, blob.size);
    if (haveCaches) {
      try { (await caches.open(MODEL_CACHE)).put(absUrl, new Response(blob)); } catch (_) {}
    }
  }
}

/** Load the vosk-browser library and instantiate the model (from cache). */
export function buildModel() {
  return getModel(VOSK_MODEL_URL);
}

export class VoskMic {
  constructor({ modelUrl = VOSK_MODEL_URL } = {}) {
    this.modelUrl = modelUrl;
    this.listening = false;
    this.muted = false;
    this.onHeard = null;   // (candidates:number[], transcript:string, isFinal:bool)
    this.onState = null;   // (state:'loading'|'listening'|'idle'|'error', detail?)
    this.onDebug = null;   // (tag:string, info:string) — diagnostics only
    this._frames = 0;
    this._model = null;
    this._ctx = null; this._stream = null; this._source = null; this._node = null;
    this._sink = null; this._rec = null;
  }

  // Kick off the (one-time) model download early, e.g. when entering a level.
  async preload() {
    if (this._model) return true;
    if (this.onState) this.onState('loading');
    try { this._model = await getModel(this.modelUrl); return true; }
    catch (_) { if (this.onState) this.onState('error', 'load'); return false; }
  }

  async start() {
    if (this.listening) return;
    this.listening = true;
    try {
      if (!this._model) {
        if (this.onState) this.onState('loading');
        this._model = await getModel(this.modelUrl);
      }
      this._stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 }, video: false,
      });
      // If stop() was called while we awaited, bail cleanly.
      if (!this.listening) { this._teardown(); return; }

      this._ctx = new (window.AudioContext || window.webkitAudioContext)();
      try { await this._ctx.resume(); } catch (_) {}
      if (this.onDebug) this.onDebug('audio', `ctx ${this._ctx.state} @ ${this._ctx.sampleRate}Hz`);
      this._rec = new this._model.KaldiRecognizer(this._ctx.sampleRate, GRAMMAR);
      this._rec.setWords(true);
      this._rec.on('result', (m) => {
        const t = m && m.result && m.result.text;
        if (this.onDebug) this.onDebug('final', JSON.stringify(t || ''));
        this._emit(t, true);
      });
      this._rec.on('partialresult', (m) => {
        const t = m && m.result && m.result.partial;
        if (t && this.onDebug) this.onDebug('partial', JSON.stringify(t));
        this._emit(t, false);
      });

      this._source = this._ctx.createMediaStreamSource(this._stream);
      this._node = this._ctx.createScriptProcessor(4096, 1, 1);
      this._frames = 0;
      this._node.onaudioprocess = (e) => {
        if (this.muted || !this._rec) return;
        this._frames++;
        // heartbeat so we can confirm mic audio is actually flowing
        if (this.onDebug && this._frames % 20 === 0) {
          const ch = e.inputBuffer.getChannelData(0);
          let peak = 0; for (let i = 0; i < ch.length; i += 64) peak = Math.max(peak, Math.abs(ch[i]));
          this.onDebug('audio', `frames=${this._frames} peak=${peak.toFixed(3)}`);
        }
        try { this._rec.acceptWaveform(e.inputBuffer); } catch (err) { if (this.onDebug) this.onDebug('error', 'acceptWaveform: ' + err); }
      };
      // Route through a muted gain node so the processor runs without echoing the mic.
      this._sink = this._ctx.createGain();
      this._sink.gain.value = 0;
      this._source.connect(this._node);
      this._node.connect(this._sink);
      this._sink.connect(this._ctx.destination);

      if (this.onState) this.onState('listening');
    } catch (err) {
      this.listening = false;
      const denied = err && (err.name === 'NotAllowedError' || err.name === 'SecurityError');
      if (this.onState) this.onState('error', denied ? 'denied' : 'load');
      this._teardown();
    }
  }

  _emit(text, isFinal) {
    if (this.muted || !this.onHeard) return;
    const raw = String(text || '').trim();
    if (!raw) return; // pure silence — ignore so it can't trip the keypad nudge
    // Strip Vosk's "[unk]" unknown-token so it never reaches the UI or parser.
    const clean = raw.replace(/\[unk\]/g, ' ').replace(/\s+/g, ' ').trim();
    // Ignore "[unk]" partials, but DO emit an "[unk]" final (clean is empty) so the
    // app can show a friendly "didn't catch that" and count the missed attempt.
    if (!clean && !isFinal) return;
    this.onHeard(extractCandidates(clean), clean, isFinal);
  }

  mute() { this.muted = true; }
  unmute() { this.muted = false; }

  stop() {
    this.listening = false;
    this._teardown();
    if (this.onState) this.onState('idle');
  }

  _teardown() {
    try { if (this._node) { this._node.onaudioprocess = null; this._node.disconnect(); } } catch (_) {}
    try { this._sink && this._sink.disconnect(); } catch (_) {}
    try { this._source && this._source.disconnect(); } catch (_) {}
    try { this._stream && this._stream.getTracks().forEach((t) => t.stop()); } catch (_) {}
    try { this._rec && this._rec.remove(); } catch (_) {}
    try { this._ctx && this._ctx.state !== 'closed' && this._ctx.close(); } catch (_) {}
    this._node = this._sink = this._source = this._stream = this._rec = this._ctx = null;
  }
}
