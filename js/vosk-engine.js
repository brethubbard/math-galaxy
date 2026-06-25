// vosk-engine.js — high-accuracy, on-device speech recognition via vosk-browser.
//
// This is the optional "Accuracy mode" engine. It runs a small Vosk model in the
// browser (WebAssembly), constrained to a GRAMMAR of number words only — which is
// what makes it so much better than the general-purpose Web Speech API at telling
// "thirteen" from "thirty". It's fully on-device: private, and (once the model is
// cached by the service worker) it works offline.
//
// It mirrors the Mic class interface from speech.js (onHeard / onState / start /
// stop / mute / unmute / listening) so the app can swap engines transparently.
//
// Lazy-loaded: this file (and the ~40 MB model) are only fetched when the user
// turns on Accuracy mode, so the default app stays tiny.

import { extractCandidates } from './numbers.js';

// The vosk-browser UMD bundle (exposes a global `Vosk`). Pin a known version.
const VOSK_CDN = 'https://cdn.jsdelivr.net/npm/vosk-browser@0.0.8/dist/vosk.js';

// Default model location: same-origin so the service worker can cache it for
// offline use (and to avoid CORS). Run scripts/get-vosk-model.sh to populate it.
export const VOSK_MODEL_URL = './models/vosk-model-small-en-us-0.15.tar.gz';

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

export class VoskMic {
  constructor({ modelUrl = VOSK_MODEL_URL } = {}) {
    this.modelUrl = modelUrl;
    this.listening = false;
    this.muted = false;
    this.onHeard = null;   // (candidates:number[], transcript:string, isFinal:bool)
    this.onState = null;   // (state:'loading'|'listening'|'idle'|'error', detail?)
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
      this._rec = new this._model.KaldiRecognizer(this._ctx.sampleRate, GRAMMAR);
      this._rec.setWords(true);
      this._rec.on('result', (m) => this._emit(m && m.result && m.result.text, true));
      this._rec.on('partialresult', (m) => this._emit(m && m.result && m.result.partial, false));

      this._source = this._ctx.createMediaStreamSource(this._stream);
      this._node = this._ctx.createScriptProcessor(4096, 1, 1);
      this._node.onaudioprocess = (e) => {
        if (!this.muted && this._rec) { try { this._rec.acceptWaveform(e.inputBuffer); } catch (_) {} }
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
    if (!text || this.muted || !this.onHeard) return;
    this.onHeard(extractCandidates(text), String(text).trim(), isFinal);
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
