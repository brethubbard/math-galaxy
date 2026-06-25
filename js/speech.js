// speech.js — microphone answer capture + spoken prompts.
//
// Honest constraints (this drove the whole input design):
//  • Web Speech API (SpeechRecognition) works in Chrome, Edge, and Safari, but
//    NOT Firefox. It streams audio to a cloud recognizer, so it needs internet
//    and adds a little latency.
//  • It mishears kids constantly ("thirteen"/"thirty", "four"/"for"). So the mic
//    is a *bonus* input — there is ALWAYS a tap keypad as the reliable fallback,
//    and we forgive near-misses by checking every candidate number it heard.
//
// This module never decides correctness; it just reports the numbers it heard
// and lets engine/app compare. It also speaks prompts/feedback via TTS, pausing
// recognition while it talks so the mic doesn't transcribe our own voice.

import { extractCandidates } from './numbers.js';

const SR = window.SpeechRecognition || window.webkitSpeechRecognition;

export const micSupported = !!SR;
export const ttsSupported = 'speechSynthesis' in window;

export class Mic {
  constructor() {
    this.rec = null;
    this.listening = false;
    this.paused = false;
    this.onHeard = null;     // (candidates:number[], transcript:string, isFinal:bool) => void
    this.onState = null;     // (state:'listening'|'idle'|'error', detail?) => void
    this.muted = false;      // true while TTS is speaking
    if (micSupported) this._build();
  }

  _build() {
    const rec = new SR();
    rec.lang = 'en-US';
    rec.continuous = true;
    rec.interimResults = true;
    rec.maxAlternatives = 3;

    rec.onresult = (e) => {
      if (this.muted) return;
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const res = e.results[i];
        // Gather candidates across all alternatives for a forgiving match.
        const cand = [];
        let transcript = '';
        for (let a = 0; a < res.length; a++) {
          transcript = transcript || res[a].transcript;
          for (const n of extractCandidates(res[a].transcript)) {
            if (!cand.includes(n)) cand.push(n);
          }
        }
        if (this.onHeard) this.onHeard(cand, transcript.trim(), res.isFinal);
      }
    };

    rec.onerror = (e) => {
      // 'no-speech' and 'aborted' are normal; surface the rest.
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
        this.listening = false;
        if (this.onState) this.onState('error', 'denied');
      } else if (e.error === 'no-speech' || e.error === 'aborted') {
        // benign
      } else if (this.onState) {
        this.onState('error', e.error);
      }
    };

    rec.onend = () => {
      // Auto-restart so listening feels continuous, unless we deliberately stopped.
      if (this.listening && !this.paused) {
        try { rec.start(); } catch (_) { /* already starting */ }
      }
    };

    this.rec = rec;
  }

  start() {
    if (!this.rec || this.listening) return;
    this.listening = true;
    this.paused = false;
    try { this.rec.start(); if (this.onState) this.onState('listening'); }
    catch (_) { /* start() throws if already running — fine */ }
  }

  stop() {
    if (!this.rec) return;
    this.listening = false;
    try { this.rec.stop(); } catch (_) {}
    if (this.onState) this.onState('idle');
  }

  // Temporarily stop hearing (e.g. while we speak) without ending the session.
  mute() { this.muted = true; }
  unmute() { this.muted = false; }
}

// --- Text to speech (prompts + celebration) ---
let voice = null;
function pickVoice() {
  if (!ttsSupported) return null;
  const voices = speechSynthesis.getVoices();
  // Prefer a friendly en-US voice; fall back to anything English.
  voice = voices.find((v) => /en-US/i.test(v.lang) && /female|samantha|zira|google us/i.test(v.name))
    || voices.find((v) => /^en/i.test(v.lang))
    || voices[0] || null;
}
if (ttsSupported) {
  pickVoice();
  speechSynthesis.onvoiceschanged = pickVoice;
}

/**
 * Speak text. If a Mic is passed, it is muted during speech and unmuted after,
 * so we never transcribe our own audio. Returns a Promise that resolves when done.
 */
export function speak(text, { mic = null, rate = 1, pitch = 1.05 } = {}) {
  return new Promise((resolve) => {
    if (!ttsSupported) { resolve(); return; }
    try { speechSynthesis.cancel(); } catch (_) {}
    if (mic) mic.mute();
    const u = new SpeechSynthesisUtterance(text);
    if (voice) u.voice = voice;
    u.rate = rate; u.pitch = pitch; u.lang = 'en-US';
    const done = () => { if (mic) mic.unmute(); resolve(); };
    u.onend = done;
    u.onerror = done;
    speechSynthesis.speak(u);
    // Safety: some browsers never fire onend.
    setTimeout(done, Math.max(1500, text.length * 90));
  });
}
