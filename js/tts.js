// tts.js — spoken prompts + feedback (text-to-speech).
//
// This module ONLY speaks; it never listens. Speech *recognition* (hearing the
// child's answer) is handled entirely by the on-device Vosk engine in
// js/vosk-engine.js. We keep TTS here because it's a separate concern (output,
// not input) and uses the browser's built-in SpeechSynthesis, which has nothing
// to do with how we recognize numbers.
//
// When speaking, we mute the active mic so it never transcribes our own voice.

export const ttsSupported = 'speechSynthesis' in window;

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

// TTS can be "supported" yet have ZERO installed voices (common on Linux/Chrome
// without speech-dispatcher). In that case every utterance fails with
// 'synthesis-failed' and nothing is heard. Treat no-voices as not-really-available.
export function hasVoices() {
  return ttsSupported && speechSynthesis.getVoices().length > 0;
}

/**
 * Speak text. If a mic is passed, it is muted during speech and unmuted after,
 * so we never transcribe our own audio. Returns a Promise that resolves when done.
 */
export function speak(text, { mic = null, rate = 1, pitch = 1.05 } = {}) {
  return new Promise((resolve) => {
    // Bail quietly if speech is unsupported OR there are no installed voices —
    // otherwise we'd fire a doomed utterance and just delay the game.
    if (!ttsSupported || speechSynthesis.getVoices().length === 0) { resolve(); return; }
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
