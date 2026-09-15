// app.js — UI controller. Ties the engine, speech, and DOM together.

import {
  PLANETS, GALAXIES, OPERATIONS, factsForPlanet,
  planetById, planetsOfGalaxy, galaxyOf, galaxyOfPlanet, buddyForPlanet,
} from './levels.js';
import * as E from './engine.js';
import { ttsSupported, hasVoices, speak } from './tts.js';
import { VoskMic, prefetchModel, buildModel } from './vosk-engine.js';

// Voice recognition is on-device (Vosk) and needs a secure context with mic
// access. Where that's unavailable (e.g. plain http:// LAN), the app is
// keypad-only — everything still works, just without the mic.
const voskSupported = !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

// ---- voice debug log (enable with ?debug in the URL) ----
const DEBUG = /[?&]debug\b/.test(location.search);
function dbg(tag, msg) {
  if (!DEBUG) return;
  const line = `[${tag}] ${msg}`;
  console.log('%c[voice]', 'color:#6ce5c8', line);
  const log = document.querySelector('#dbg-log');
  if (log) {
    const d = document.createElement('div');
    d.textContent = new Date().toLocaleTimeString().split(' ')[0] + ' ' + line;
    log.prepend(d);
    while (log.childElementCount > 40) log.lastChild.remove();
  }
}
function initDebug() {
  if (!DEBUG) return;
  const p = document.createElement('div');
  p.id = 'dbg-panel';
  p.innerHTML = '<div class="dbg-head">🛠 voice debug <span id="dbg-eng"></span></div><div id="dbg-log"></div>';
  document.body.appendChild(p);
  dbg('init', 'debug log on');
}

const state = {
  save: null,
  mic: null,        // the on-device Vosk recognizer (null where unsupported)
  screen: 'home',
  play: null,
  currentGalaxy: 'mul', // which operation's map we're in
  currentPlanet: null,
  statsGalaxy: 'mul',   // which galaxy's heatmap the stats screen is showing
  audioCtx: null,
  wakeLock: null,
  lastMicCommitAt: 0,   // suppress trailing recognizer results after a voice answer
};

// ===========================================================================
// Boot
// ===========================================================================
async function boot() {
  startStarfield();
  state.save = E.loadSave();

  bindGlobal();
  bindHome();
  bindPlay();
  bindStatsAndSettings();
  bindChallenge();
  initPWA();
  initDebug();

  // Eagerly download + warm up the on-device voice behind a loading screen —
  // but ONLY if this pilot wants the mic. Switched off, the ~40 MB model is
  // never fetched and there's no loading screen to sit through.
  if (micWanted()) {
    ensureMic();
    await runBootLoad();
  } else {
    hideBootLoader(true);
  }
  syncMicUi();

  if (state.save) renderHome(true);
  else renderHome(false);
}

// Does this pilot want to answer by voice? A brand-new pilot has no saved
// preference yet, and the app is voice-first by default.
function micWanted() {
  if (!voskSupported) return false;
  return !state.save || state.save.settings.useMic !== false;
}

// Build the recognizer on demand. Cheap — it holds no audio and downloads
// nothing until loadVoice() runs.
function ensureMic() {
  if (!voskSupported) return null;
  if (!state.mic) { state.mic = new VoskMic(); wireMic(state.mic); }
  return state.mic;
}

// Fetch + warm the voice model, at most once per page load. Shared by the boot
// screen and by switching the mic on in settings, which report progress
// differently — hence the callbacks rather than a fixed UI.
let voiceLoad = null;

function loadVoice({ status = () => {}, progress = () => {} } = {}) {
  if (voiceLoad) return voiceLoad;
  const mic = ensureMic();
  if (!mic) return Promise.reject(new Error('voice not supported here'));

  voiceLoad = (async () => {
    status('Downloading the voice model…');
    await prefetchModel((frac, received, total) => progress(frac, received, total));
    status('Warming up the voice…');
    await buildModel();     // load vosk-browser + instantiate (from cache)
    await mic.preload();    // bind the ready model to our recognizer
  })();
  // A failed download must stay retryable — one flaky attempt shouldn't wedge
  // the mic until the page is reloaded.
  voiceLoad.catch(() => { voiceLoad = null; });
  return voiceLoad;
}

// Hide the mic affordances outright when the mic is off, so "off" doesn't leave
// a big tappable microphone sitting on the play screen.
function syncMicUi() {
  const on = micEnabled();
  for (const id of ['#mic-btn', '#versus-mic-btn']) {
    const el = $(id);
    if (!el) continue;
    el.hidden = !on;
    if (!on) el.classList.remove('listening');
  }
}

const mbOf = (n) => (n / (1024 * 1024)).toFixed(0);

// ---- Boot loading screen: download the voice model up front ----
// Resolves when the model is ready, fails gracefully, or the user taps "skip".
// Either way the download keeps going in the background so the mic works ASAP.
function runBootLoad() {
  return new Promise((resolve) => {
    let closed = false;
    const close = () => { if (closed) return; closed = true; hideBootLoader(); resolve(); };

    // Offer an escape hatch if the download is slow, so a kid is never stuck.
    const skip = $('#boot-skip');
    const skipTimer = setTimeout(() => skip && skip.classList.remove('hidden'), 6000);
    if (skip) skip.onclick = () => { clearTimeout(skipTimer); close(); };

    loadVoice({
      status: (txt) => {
        setBootStatus(txt);
        if (txt.startsWith('Warming')) setBootBarIndeterminate(true);
      },
      progress: (frac, received, total) => updateBootProgress(frac, received, total),
    })
      .then(() => dbg('boot', 'voice model ready'))
      .catch((e) => {
        dbg('boot', 'voice preload failed: ' + e);
        setBootSub('⚠️ Couldn\'t load the voice — you can still tap your answers. 👇');
      })
      .finally(() => { clearTimeout(skipTimer); close(); });
  });
}

function setBootStatus(txt) { const el = $('#boot-status'); if (el) el.textContent = txt; }
function setBootSub(txt) { const el = $('#boot-sub'); if (el) el.textContent = txt; }
function setBootBarIndeterminate(on) {
  const bar = $('#boot-bar-track');
  if (bar) bar.classList.toggle('indeterminate', on);
}
function updateBootProgress(frac, received, total) {
  setBootBarIndeterminate(frac == null);
  const fill = $('#boot-bar');
  if (fill && frac != null) fill.style.width = `${Math.round(frac * 100)}%`;
  if (total) setBootSub(`${mbOf(received)} of ${mbOf(total)} MB — one time, then it works offline.`);
}
function hideBootLoader(instant = false) {
  const el = $('#boot-loader');
  if (!el) return;
  // With the mic off there is no download, so don't even flash "Loading the
  // voice…" on the way past — drop the screen outright.
  if (instant) { el.remove(); return; }
  el.classList.add('done');
  setTimeout(() => el.remove(), 450); // let the fade-out finish, then drop it
}

// ---- PWA: install the app + register the offline service worker ----
function initPWA() {
  // Register the service worker (makes the app installable + work offline).
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('sw.js').catch(() => { /* offline-only is fine */ });
    });
  }
  // Show our own "Install app" button when the browser says it's installable.
  let deferred = null;
  const btn = $('#btn-install');
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferred = e;
    if (btn) btn.classList.remove('hidden');
  });
  if (btn) btn.addEventListener('click', async () => {
    if (!deferred) return;
    deferred.prompt();
    await deferred.userChoice;
    deferred = null;
    btn.classList.add('hidden');
  });
  window.addEventListener('appinstalled', () => { if (btn) btn.classList.add('hidden'); });
}

function bindGlobal() {
  $$('[data-nav]').forEach((b) => b.addEventListener('click', () => navTo(b.dataset.nav)));
}

function navTo(screen) {
  // hop screens, refreshing whatever the destination needs
  if (screen === 'galaxy') renderGalaxySelect();
  if (screen === 'map') renderMap();
  if (screen === 'stats') renderStats();
  if (screen === 'settings') renderSettings();
  if (screen === 'home') renderHome(!!state.save);
  showScreen(screen);
}

function showScreen(name) {
  state.screen = name;
  $$('.screen').forEach((s) => s.classList.remove('active'));
  $(`#screen-${name}`).classList.add('active');
  window.scrollTo(0, 0);
}

// ===========================================================================
// Home
// ===========================================================================
function bindHome() {
  $('#btn-start').addEventListener('click', () => {
    const name = $('#pilot-name').value.trim() || 'Space Pilot';
    state.save = E.newSave(name);
    E.persist(state.save);
    renderHome(true);
    navTo('galaxy');
  });
  $('#btn-continue').addEventListener('click', () => navTo('galaxy'));
  $('#link-map').addEventListener('click', () => navTo('galaxy'));
  $('#link-stats').addEventListener('click', () => navTo('stats'));
  $('#link-settings').addEventListener('click', () => navTo('settings'));
}

function renderHome(returning) {
  $('#home-newpilot').classList.toggle('hidden', returning);
  $('#home-returning').classList.toggle('hidden', !returning);
  if (returning && state.save) {
    $('#pilot-greeting').textContent = state.save.name;
    const lvl = E.xpLevel(state.save.xp);
    $('#home-rank').textContent = `Rank ${lvl.rank}`;
    $('#home-buddies').textContent = state.save.buddies.join(' ') || '✨';
  }
}

// ===========================================================================
// Galaxy select — choose which operation to practice
// ===========================================================================
function renderGalaxySelect() {
  const wrap = $('#galaxy-cards');
  wrap.innerHTML = '';
  for (const g of GALAXIES) {
    const planets = g.planets;
    const cleared = planets.filter((p) => state.save.planets[p.id]?.cleared).length;
    const pct = Math.round((cleared / planets.length) * 100);
    const node = document.createElement('button');
    node.type = 'button';
    node.className = 'galaxy-card';
    node.style.setProperty('--gx', g.color);
    node.innerHTML = `
      <span class="gx-emoji">${g.emoji}</span>
      <div class="gx-body">
        <div class="gx-name">${g.name}</div>
        <div class="gx-sub">${g.tagline}</div>
        <div class="bar-track"><div class="bar-fill" style="width:${pct}%"></div></div>
        <div class="gx-prog">${cleared} / ${planets.length} planets cleared</div>
      </div>`;
    node.addEventListener('click', () => { state.currentGalaxy = g.op; navTo('map'); });
    wrap.appendChild(node);
  }
}

// ===========================================================================
// Map
// ===========================================================================
function renderMap() {
  const galaxy = galaxyOf(state.currentGalaxy) || GALAXIES[0];
  const planets = galaxy.planets;
  $('#map-title').textContent = `${galaxy.name} Map`;
  const track = $('#planet-track');
  track.innerHTML = '';
  const currentId = firstUncleared(planets);
  for (const p of planets) {
    const rec = state.save.planets[p.id];
    const node = document.createElement('div');
    node.className = 'planet-node';
    if (!rec.unlocked) node.classList.add('locked');
    if (rec.cleared) node.classList.add('cleared');
    if (p.id === currentId) node.classList.add('current');
    const stars = rec.cleared ? starStr(rec.stars) : (rec.unlocked ? '' : '');
    node.innerHTML = `
      <span class="pn-emoji">${rec.unlocked ? p.emoji : '🔒'}</span>
      <div class="pn-body">
        <div class="pn-name">${p.name}</div>
        <div class="pn-sub">${p.title}</div>
        <div class="pn-stars">${stars}</div>
      </div>
      ${rec.unlocked ? '' : '<span class="pn-lock">🔒</span>'}`;
    if (rec.unlocked) node.addEventListener('click', () => openPlanet(p.id));
    track.appendChild(node);
  }
}

function firstUncleared(planets) {
  const p = planets.find((p) => !state.save.planets[p.id].cleared && state.save.planets[p.id].unlocked);
  return p ? p.id : planets[planets.length - 1].id;
}

function starStr(n) {
  const max = E.CONFIG.maxStars;
  const filled = Math.max(0, Math.min(max, n || 0));
  return '★'.repeat(filled) + '☆'.repeat(max - filled);
}

// ===========================================================================
// Planet detail
// ===========================================================================
function openPlanet(planetId) {
  const p = planetById(planetId);
  const galaxy = galaxyOfPlanet(planetId);
  if (galaxy) state.currentGalaxy = galaxy.op;
  const rec = state.save.planets[planetId];
  state.currentPlanet = planetId;
  $('#planet-title').textContent = p.name;
  $('#planet-big').textContent = p.emoji;
  $('#planet-stars').textContent = rec.cleared ? starStr(rec.stars) : starStr(0);
  $('#planet-hint').textContent = p.hint;
  const prog = E.planetProgress(state.save, planetId);
  $('#planet-bar').style.width = `${prog.pct}%`;
  $('#planet-progress-label').textContent = `${prog.learned} / ${prog.total} facts mastered`;
  renderFluencyButton(rec, galaxy);
  showScreen('planet');
}

// The Fluency Run (stars 4-5) opens only once the planet is cleared — the
// unlock path stays on the regular test, so nobody is gated behind it.
function renderFluencyButton(rec, galaxy) {
  const btn = $('#btn-fluency');
  btn.hidden = !rec.cleared;
  if (!rec.cleared) return;

  const F = E.CONFIG.fluency;
  const mins = Math.round(E.fluencyDurationMs(galaxy ? galaxy.op : 'mul') / 60000) || 1;
  const best = rec.bestRate || 0;
  const need = rec.stars >= 4 ? F.rate5 : F.rate4;

  $('#fluency-sub').textContent = rec.stars >= E.CONFIG.maxStars
    ? `${mins} min · your best ${best}/min`
    : best
      ? `best ${best}/min · ${need}/min for ★${rec.stars >= 4 ? 5 : 4}`
      : `${mins} min · ${F.rate4}/min earns ★4`;
}

// ===========================================================================
// Play loop
// ===========================================================================
function bindPlay() {
  $('#btn-practice').addEventListener('click', () => startPlay('practice'));
  $('#btn-test').addEventListener('click', () => startPlay('test'));
  $('#btn-fluency').addEventListener('click', () => startPlay('fluency'));
  $('#btn-quit-play').addEventListener('click', () => endPlay());
  $('#btn-skip').addEventListener('click', () => commit(null)); // skip = reveal + wrong
  $('#btn-hint').addEventListener('click', showHint);
  $('#btn-finish-practice').addEventListener('click', () => finishPractice());
  $('#mic-btn').addEventListener('click', toggleMic);

  $$('#keypad button').forEach((b) => b.addEventListener('click', () => onKey(b.dataset.k)));
  // physical keyboard for parents/older kids
  window.addEventListener('keydown', (e) => {
    if (state.screen !== 'play') return;
    if (/[0-9]/.test(e.key)) onKey(e.key);
    else if (e.key === 'Enter') onKey('enter');
    else if (e.key === 'Backspace') onKey('back');
  });
}

async function startPlay(mode) {
  const planetId = state.currentPlanet;
  state.play = {
    mode, planetId,
    expected: null, question: null, startedAt: 0, locked: true, lockReason: null,
    promptCut: false, qToken: 0, advanceTimer: null,
    answerStr: '', micMisfires: 0, streak: 0,
    practice: { count: 0, correct: 0 },
    test: mode === 'test' ? { queue: E.buildTest(state.save, planetId), idx: 0, results: [] } : null,
    fluency: mode === 'fluency'
      ? { run: E.createFluencyRun(state.save, planetId), endsAt: 0, done: false }
      : null,
  };

  $('#play-mode-pill').textContent =
    mode === 'test' ? '🏅 Test' : mode === 'fluency' ? '⚡ Fluency' : '🎈 Practice';
  $('#streak-pill').textContent = '🔥 0';
  $('#btn-hint').hidden = mode !== 'practice';        // no hints once you're being timed
  $('#btn-finish-practice').hidden = mode !== 'practice';
  $('#test-dots').hidden = mode !== 'test';
  $('#clock-pill').hidden = mode !== 'fluency';
  $('#clock-pill').classList.remove('urgent');
  if (mode === 'test') buildDots(state.play.test.queue.length);
  if (mode === 'fluency') $('#clock-pill').textContent = `⏱ ${fmtClock(state.play.fluency.run.durationMs)}`;
  updateXpBar();

  syncMicUi();
  showScreen('play');
  requestWakeLock(); // keep the screen on while playing (kids pause to think)
  const dbgEng = $('#dbg-eng'); if (dbgEng) dbgEng.textContent = `· vosk · mic ${micEnabled() ? 'on' : 'off'}`;
  dbg('start', `micEnabled=${micEnabled()}`);
  if (micEnabled()) state.mic.start();
  nextQuestion();
}

function micEnabled() { return !!(state.mic && voskSupported && state.save?.settings.useMic); }

// ---- Screen Wake Lock: stop the device dimming/sleeping mid-problem ----
async function requestWakeLock() {
  if (!('wakeLock' in navigator) || state.wakeLock) return;
  try {
    state.wakeLock = await navigator.wakeLock.request('screen');
    // The lock is auto-dropped if it gets released (e.g. tab hidden); track that.
    state.wakeLock.addEventListener('release', () => { state.wakeLock = null; });
  } catch (_) { /* not allowed / unsupported — harmless */ }
}
async function releaseWakeLock() {
  try { await state.wakeLock?.release(); } catch (_) {}
  state.wakeLock = null;
}
// The OS releases the lock when the page is backgrounded; re-acquire on return
// if we're still in the middle of playing.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && state.screen === 'play') requestWakeLock();
});

function buildDots(n) {
  const dots = $('#test-dots');
  dots.innerHTML = '';
  for (let i = 0; i < n; i++) {
    const d = document.createElement('span');
    d.className = 'dot';
    dots.appendChild(d);
  }
}

async function nextQuestion() {
  const play = state.play;

  if (play.mode === 'test') {
    if (play.test.idx >= play.test.queue.length) return finishTest();
    play.question = play.test.queue[play.test.idx];
    markDot(play.test.idx, 'cur');
  } else if (play.mode === 'fluency') {
    if (play.fluency.done) return;
    play.question = play.fluency.run.next();
  } else {
    play.question = E.pickPracticeFact(state.save, play.planetId, play.question?.key);
  }

  play.expected = play.question.answer;
  play.answerStr = '';
  play.micMisfires = 0;
  play.locked = true;             // stays locked until the prompt finishes
  play.lockReason = 'prompt';     // ...but a tap can cut the prompt short
  play.promptCut = false;
  const token = ++play.qToken;

  $('#q-a').textContent = play.question.a;
  $('#q-op').textContent = play.question.symbol;
  $('#q-b').textContent = play.question.b;
  setSlot('?');
  $('#answer-slot').classList.remove('filled');
  setFeedback('');
  $('#keypad').classList.remove('nudge');
  $('#heard').innerHTML = micEnabled()
    ? 'Listening… say your answer! 🎤'
    : 'Tap your answer below 👇';

  // Optional spoken prompt (mutes mic while talking). A fluency run skips it:
  // reading the question aloud costs 1.5-2s of a 2s-per-fact budget.
  if (play.mode !== 'fluency' && state.save.settings.voicePrompts && hasVoices()) {
    await speak(`What is ${play.question.a} ${play.question.word} ${play.question.b}?`, { mic: state.mic });
  }

  // While we were talking the child may have tapped in (which unlocks and
  // starts the clock itself), or moved on to another question entirely. Either
  // way this continuation is stale — don't re-lock or restart their timer.
  if (state.play !== play || play.qToken !== token || play.promptCut) return;

  play.startedAt = performance.now(); // silent timer — never shown as a clock
  play.locked = false;
  play.lockReason = null;
  if (micEnabled() && !state.mic.listening) state.mic.start();
  // The countdown starts with the first question, not when the screen opens.
  if (play.mode === 'fluency' && !play.fluency.endsAt) startFluencyClock();
}

// A child tapping while the question is still being read aloud already knows
// the answer. Stop talking, start their timer, and take the keystroke — rather
// than swallowing the first digit they press. Taps during answer FEEDBACK are
// still ignored, so a fast double-tap can't skip the next question.
function cutPrompt(play) {
  if (play.lockReason !== 'prompt') return false;
  play.promptCut = true;
  play.locked = false;
  play.lockReason = null;
  play.startedAt = performance.now();
  try { speechSynthesis.cancel(); } catch (_) {}
  if (state.mic) state.mic.unmute();
  return true;
}

function setSlot(txt) { $('#answer-slot').textContent = txt; }
function setFeedback(txt, cls = '') {
  const el = $('#feedback');
  el.textContent = txt;
  el.className = 'feedback' + (cls ? ' ' + cls : '');
}

// ---- input: keypad ----
function onKey(k) {
  const play = state.play;
  if (!play) return;
  if (play.locked && !cutPrompt(play)) return;
  if (k === 'enter') { if (play.answerStr !== '') commit(parseInt(play.answerStr, 10)); return; }
  if (k === 'back') { play.answerStr = play.answerStr.slice(0, -1); }
  else if (/^[0-9]$/.test(k)) { if (play.answerStr.length < 3) play.answerStr += k; }
  const slot = play.answerStr === '' ? '?' : play.answerStr;
  setSlot(slot);
  $('#answer-slot').classList.toggle('filled', play.answerStr !== '');
}

// ---- input: mic ---- (wires the on-device Vosk recognizer)
function wireMic(mic) {
  mic.onDebug = (tag, info) => dbg(tag, info); // Vosk diagnostics (audio flow, raw text)
  mic.onHeard = (candidates, transcript, isFinal) => {
    // In a multiplayer race the mic feeds the versus screen instead.
    if (state.screen === 'versus') { versusHeard(candidates, transcript, isFinal); return; }
    const play = state.play;
    dbg('heard', `"${transcript}" → [${candidates.join(',')}] ${isFinal ? 'final' : 'partial'} expect=${play ? play.expected : '-'}${play && candidates.includes(play.expected) ? ' ✓MATCH' : ''}`);
    if (!play || play.locked || state.screen !== 'play') return;

    // Ignore the trailing tail of the utterance we just answered with — its late
    // 'final' result must not auto-answer the NEXT question.
    if (performance.now() - state.lastMicCommitAt < 1200) return;

    // Delightful path: heard the correct answer -> instant win.
    if (candidates.includes(play.expected)) { commit(play.expected, true); return; }

    // Show what we heard so the child can self-correct. Prefer a clean number;
    // never surface the recognizer's raw "[unk]" / empty unknown token.
    if (candidates.length) {
      $('#heard').innerHTML = `I heard <b>${candidates[0]}</b> 🤔`;
    } else if (transcript) {
      $('#heard').innerHTML = `I heard: <b>${escapeHtml(transcript)}</b> 🤔`;
    } else if (isFinal) {
      $('#heard').innerHTML = 'Hmm, I didn\'t catch that 🤔 — say it again or tap below 👇';
    }

    // Any non-matching FINAL counts as a miss; nudge the keypad after two.
    if (isFinal) {
      play.micMisfires++;
      if (play.micMisfires >= 2) {
        $('#heard').innerHTML = 'The mic isn\'t sure — tap your answer below 👇';
        $('#keypad').classList.add('nudge');
      }
    }
  };
  mic.onState = (st, detail) => {
    dbg('state', st + (detail ? ' ' + detail : ''));
    if (st === 'loading') {
      $('#mic-btn').classList.remove('listening');
      // Don't nag about the voice model if the mic is switched off in settings.
      if (micEnabled()) {
        $('#heard').innerHTML = '🛰️ Loading the smart voice model… <small>(one-time, may take a bit)</small>';
      }
    }
    if (st === 'listening') { $('#mic-btn').classList.remove('off'); $('#mic-btn').classList.add('listening'); }
    if (st === 'idle' || st === 'error') $('#mic-btn').classList.remove('listening');
    if (st === 'error' && detail === 'denied') {
      state.save.settings.useMic = false; E.persist(state.save);
      $('#mic-btn').classList.add('off');
      $('#heard').textContent = 'Mic is off — just tap your answers! 👇';
    }
    if (st === 'error' && detail === 'load' && micEnabled()) {
      // The on-device voice model couldn't load — the keypad still works.
      $('#heard').innerHTML = '⚠️ Couldn\'t load the voice — tap your answers any time 👇';
    }
  };
}

function toggleMic() {
  if (!micEnabled()) return; // switched off in settings — the button is hidden too
  if (!state.mic.listening) { state.mic.start(); $('#mic-btn').classList.remove('off'); }
  else { state.mic.stop(); }
}

// ---- commit an answer (value === null means "skip/reveal") ----
function commit(value, viaMic = false) {
  const play = state.play;
  if (!play || play.locked) return;
  play.locked = true;
  play.lockReason = 'feedback';
  if (viaMic) state.lastMicCommitAt = performance.now(); // start the suppression window

  const elapsed = performance.now() - play.startedAt;
  const isCorrect = value !== null && value === play.expected;
  const result = E.recordAnswer(state.save, play.question, isCorrect, elapsed);
  E.persist(state.save);

  // tallies
  if (play.mode === 'practice') {
    play.practice.count++;
    if (isCorrect) play.practice.correct++;
  } else if (play.mode === 'fluency') {
    play.fluency.run.results.push({
      key: play.question.key, correct: isCorrect, elapsedMs: elapsed,
      fromCurrent: !!play.question.fromCurrent,
      a: play.question.a, b: play.question.b, symbol: play.question.symbol, given: value,
    });
  } else {
    play.test.results.push({
      key: play.question.key, correct: isCorrect, elapsedMs: elapsed,
      a: play.question.a, b: play.question.b, symbol: play.question.symbol, given: value,
    });
    markDot(play.test.idx, isCorrect ? 'right' : 'wrong');
    play.test.idx++;
  }

  // feedback + FX
  setSlot(play.expected);
  $('#answer-slot').classList.add('filled');
  updateXpBar();

  // A fluency run is deliberately lean: short pauses, no spoken correction, no
  // confetti. The rate is measured against a wall clock, so every celebration
  // is time the child doesn't get back.
  const lean = play.mode === 'fluency';
  const F = E.CONFIG.fluency;

  if (isCorrect) {
    play.streak++; // running count of correct answers in a row THIS session
    if (play.streak > state.save.streakBest) { state.save.streakBest = play.streak; E.persist(state.save); }
    $('#streak-pill').textContent = `🔥 ${play.streak}`;
    const msg = result.fast ? pick(['Lightning fast! ⚡', 'Zoom! 🚀', 'Wow! ⭐', 'Boom! 💥'])
                            : pick(['Nice! 🎉', 'You got it! ✅', 'Great! 🌟', 'Correct! 👏']);
    setFeedback(lean ? '✅' : msg, 'good');
    cheer(result.fast ? '🌟' : '⭐', result.mastered);
    beep(true, result.fast);
    if (result.fast && !lean) confettiBurst(result.mastered ? 60 : 24);
    if (!lean && state.save.settings.voicePrompts && hasVoices() && result.mastered) speak('Mastered!', { mic: state.mic });
    scheduleAdvance(play, lean ? F.goodMs : 750);
  } else {
    play.streak = 0;
    $('#streak-pill').textContent = '🔥 0';
    setFeedback(lean ? `${play.expected}` : `It's ${play.expected}. You'll get it next time! 💪`, 'soft shake');
    beep(false);
    if (!lean && state.save.settings.voicePrompts && hasVoices()) {
      speak(`${play.question.a} ${play.question.word} ${play.question.b} is ${play.expected}`, { mic: state.mic });
    }
    scheduleAdvance(play, lean ? F.badMs : 1700);
  }
}

// Move on after the feedback pause — but only if this is still the SAME session.
// Quitting mid-pause used to leave the timer running: it would fire into the
// next session and silently swap out its first question, wiping whatever the
// child had already typed.
function scheduleAdvance(play, ms) {
  clearTimeout(play.advanceTimer);
  play.advanceTimer = setTimeout(() => {
    if (state.play === play) advance();
  }, ms);
}

function advance() {
  const play = state.play;
  if (!play) return;
  if (play.mode === 'fluency') {
    if (play.fluency.done) return;
    if (Date.now() >= play.fluency.endsAt) return finishFluency();
    return nextQuestion();
  }
  if (play.mode === 'test' && play.test.idx >= play.test.queue.length) {
    finishTest();
  } else {
    nextQuestion();
  }
}

function showHint() {
  const play = state.play;
  if (!play) return;
  const p = planetById(play.planetId);
  setFeedback('💡 ' + p.hint, '');
}

function markDot(i, cls) {
  const dots = $$('#test-dots .dot');
  dots.forEach((d) => d.classList.remove('cur'));
  if (dots[i]) { dots[i].classList.add(cls); }
}

function endPlay() {
  if (state.play) clearTimeout(state.play.advanceTimer);
  stopFluencyClock();
  if (state.mic) state.mic.stop();
  releaseWakeLock();
  try { speechSynthesis.cancel(); } catch (_) {}
  state.play = null;
  navTo('map');
}

// ---- finishing ----
function finishTest() {
  const play = state.play;
  clearTimeout(play.advanceTimer);
  if (state.mic) state.mic.stop();
  releaseWakeLock();
  const grade = E.gradeTest(state.save, play.planetId, play.test.results);
  E.persist(state.save);
  showResult(grade, play.planetId);
  state.play = null;
}

// ---- fluency run: the countdown ----
let fluencyTimer = null;

function startFluencyClock() {
  const play = state.play;
  play.fluency.endsAt = Date.now() + play.fluency.run.durationMs;
  stopFluencyClock();
  fluencyTimer = setInterval(() => {
    const p = state.play;
    if (!p || p.mode !== 'fluency') return stopFluencyClock();
    const left = Math.max(0, p.fluency.endsAt - Date.now());
    $('#clock-pill').textContent = `⏱ ${fmtClock(left)}`;
    $('#clock-pill').classList.toggle('urgent', left <= 15000);
    if (left <= 0) finishFluency();
  }, 200);
}

function stopFluencyClock() {
  if (fluencyTimer) { clearInterval(fluencyTimer); fluencyTimer = null; }
}

function fmtClock(ms) {
  const t = Math.ceil(ms / 1000);
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`;
}

// Time's up — pencils down. A question in flight when the clock runs out simply
// doesn't count, exactly like a paper fact sheet.
function finishFluency() {
  const play = state.play;
  if (!play || !play.fluency || play.fluency.done) return;
  play.fluency.done = true;
  clearTimeout(play.advanceTimer);
  stopFluencyClock();
  if (state.mic) state.mic.stop();
  releaseWakeLock();
  try { speechSynthesis.cancel(); } catch (_) {}
  $('#clock-pill').textContent = '⏱ 0:00';

  const grade = E.gradeFluency(state.save, play.planetId, play.fluency.run);
  E.persist(state.save);
  showFluencyResult(grade, play.planetId);
  state.play = null;
}

// End-of-run review: which facts went wrong, what the child answered, and what
// the answer actually is. Framed as "practice these", not as a tally of errors —
// a long list is capped so a rough run never turns into a wall of red.
const REVIEW_LIMIT = 12;

function renderReview(missed) {
  const el = $('#result-review');
  if (!missed || !missed.length) { el.hidden = true; el.innerHTML = ''; return; }

  const shown = missed.slice(0, REVIEW_LIMIT);
  const rest = missed.length - shown.length;
  el.hidden = false;
  el.innerHTML =
    '<h3>📝 Facts to practice</h3><ul>' +
    shown.map((m) => {
      const said = m.given == null ? 'skipped' : `you said ${m.given}`;
      const again = m.times > 1 ? ` <span class="rv-times">×${m.times}</span>` : '';
      return `<li><span class="rv-fact">${m.a} ${m.symbol} ${m.b} = <b>${m.answer}</b></span>` +
             `<span class="rv-said">${said}${again}</span></li>`;
    }).join('') +
    '</ul>' +
    (rest > 0 ? `<p class="rv-more">…and ${rest} more to work on 💪</p>` : '');
}

function showFluencyResult(grade, planetId) {
  const F = E.CONFIG.fluency;
  $('#result-burst').textContent = grade.newStar ? '🏆' : grade.accurate ? '⚡' : '🎯';
  $('#result-title').textContent = grade.newStar
    ? `${grade.stars} stars! 🌟`
    : grade.accurate ? 'Strong run!' : 'Careful counts too!';
  $('#result-stars').textContent = starStr(grade.stars);

  const accPct = Math.round(grade.acc * 100);
  const floorPct = Math.round(F.accuracyFloor * 100);

  // Speed and accuracy are one result, not two numbers — a star needs both.
  const tail = !grade.accurate
    ? `<small>Fast! But a star needs <b>${floorPct}%</b> right — a little slower is a lot surer 🎯</small>`
    : grade.nextRate
      ? `<small><b>${grade.nextRate}</b> per minute at ${floorPct}%+ earns your next star ⭐</small>`
      : '<small>Top speed — the only record left to beat is your own! 🚀</small>';

  $('#result-stats').innerHTML =
    `<b>${grade.rate}</b> facts per minute at <b>${accPct}%</b> accuracy<br>` +
    `<b>${grade.correct}</b> right out of <b>${grade.total}</b> answered<br>` +
    tail;

  renderReview(grade.missed);

  const reward = $('#result-reward');
  if (grade.newStar) {
    reward.classList.remove('hidden');
    reward.innerHTML = `<span class="big-buddy">⚡</span>You earned star <b>${grade.stars}</b> — fast <i>and</i> accurate!`;
    confettiBurst(140);
    beep(true, true);
    if (state.save.settings.voicePrompts && hasVoices()) speak('Fluency star! Amazing speed!', {});
  } else {
    reward.classList.add('hidden');
  }

  $('#btn-result-again').textContent = 'Run Again ⚡';
  $('#btn-result-again').onclick = () => { openPlanet(planetId); startPlay('fluency'); };
  $('#btn-result-map').onclick = () => navTo('map');
  showScreen('result');
}

function finishPractice() {
  const play = state.play;
  clearTimeout(play.advanceTimer);
  if (state.mic) state.mic.stop();
  releaseWakeLock();
  const { count, correct } = play.practice;
  const acc = count ? Math.round((correct / count) * 100) : 0;
  state.play = null;

  $('#result-burst').textContent = '🎈';
  $('#result-title').textContent = 'Good practice!';
  $('#result-stars').textContent = '';
  renderReview(null);
  $('#result-stats').innerHTML =
    `You tried <b>${count}</b> facts and got <b>${correct}</b> right (<b>${acc}%</b>).<br>Every try makes your brain stronger! 🧠`;
  $('#result-reward').classList.add('hidden');
  $('#btn-result-again').textContent = 'Practice More';
  $('#btn-result-again').onclick = () => { openPlanet(play.planetId); startPlay('practice'); };
  $('#btn-result-map').onclick = () => navTo('map');
  showScreen('result');
}

function showResult(grade, planetId) {
  const cleared = grade.cleared;
  $('#result-burst').textContent = cleared ? '🏆' : '🌟';
  $('#result-title').textContent = cleared
    ? (grade.newlyCleared ? 'Planet Cleared! 🚀' : 'Cleared again! 🌟')
    : 'So close — try again!';
  // Show the planet's running total, so a re-test never appears to *remove* a
  // fluency star the child already earned.
  $('#result-stars').textContent = starStr(state.save.planets[planetId].stars);

  const avgSec = grade.avgMs ? (grade.avgMs / 1000).toFixed(1) : '—';
  $('#result-stats').innerHTML =
    `Accuracy: <b>${Math.round(grade.acc * 100)}%</b> (${grade.correct}/${grade.total})<br>` +
    `Your speed: <b>${avgSec}s</b> per fact ${grade.avgMs && grade.avgMs <= E.CONFIG.fastMs ? '⚡' : ''}<br>` +
    (cleared ? '' : `<small>Reach ${Math.round(E.CONFIG.testAccuracy * 100)}% to clear this planet — you're almost there!</small>`);

  renderReview(grade.missed);

  const reward = $('#result-reward');
  if (grade.newlyCleared) {
    const nextName = grade.unlockedNext ? PLANETS.find((p) => p.id === grade.unlockedNext)?.name : null;
    reward.classList.remove('hidden');
    reward.innerHTML =
      `<span class="big-buddy">${grade.buddy || '⭐'}</span>` +
      `You earned a new buddy!` +
      (nextName ? `<br>🔓 <b>${nextName}</b> is now unlocked!` : '<br>You finished the whole galaxy! 🌌');
    confettiBurst(140);
    beep(true, true);
    if (state.save.settings.voicePrompts && hasVoices()) speak('Planet cleared! Awesome work!', {});
  } else {
    reward.classList.add('hidden');
    if (cleared) confettiBurst(80);
  }

  $('#btn-result-again').textContent = 'Try Again';
  $('#btn-result-again').onclick = () => { openPlanet(planetId); startPlay('test'); };
  $('#btn-result-map').onclick = () => navTo('map');
  showScreen('result');
}

// ===========================================================================
// XP / streak chrome
// ===========================================================================
function updateXpBar() {
  const lvl = E.xpLevel(state.save.xp);
  $('#xp-rank').textContent = `R${lvl.rank}`;
  $('#xp-bar').style.width = `${lvl.pct}%`;
}

function cheer(glyph, big) {
  const el = $('#buddy-cheer');
  el.textContent = big ? '🏅' : glyph;
  el.classList.remove('pop'); void el.offsetWidth; el.classList.add('pop');
}

// ===========================================================================
// Stats
// ===========================================================================
function bindStatsAndSettings() {
  $('#btn-result-again'); // bound dynamically
}

function renderStats() {
  const s = state.save;
  const lvl = E.xpLevel(s.xp);
  const cleared = PLANETS.filter((p) => s.planets[p.id].cleared).length;
  const mastered = Object.values(s.facts).filter((f) => f.box >= E.CONFIG.masteryBox).length;

  $('#stat-tiles').innerHTML = [
    tile(`Rank ${lvl.rank}`, 'pilot rank'),
    tile(`${s.xp}`, 'total XP'),
    tile(`${mastered}`, 'facts mastered'),
    tile(`${cleared}/${PLANETS.length}`, 'planets cleared'),
    tile(`🔥 ${s.streakBest}`, 'best streak'),
    tile(`${s.buddies.length}`, 'buddies'),
  ].join('');

  // buddy collection (locked silhouettes for not-yet-earned), one per planet
  const bc = $('#buddy-collection');
  bc.innerHTML = PLANETS.map((p) => {
    const b = buddyForPlanet(p.id);
    const have = s.buddies.includes(b) && s.planets[p.id].cleared;
    return `<span class="${have ? '' : 'locked-buddy'}" title="${p.name}">${have ? b : '❔'}</span>`;
  }).join('');

  state.statsGalaxy = state.currentGalaxy;
  renderStatsGalaxyTabs();
  renderHeatmap(state.statsGalaxy);
}

function tile(big, lbl) {
  return `<div class="stat-tile"><div class="big">${big}</div><div class="lbl">${lbl}</div></div>`;
}

function renderStatsGalaxyTabs() {
  const wrap = $('#stats-gal-tabs');
  if (!wrap) return;
  wrap.innerHTML = '';
  for (const g of GALAXIES) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'op-chip' + (g.op === state.statsGalaxy ? ' on' : '');
    b.textContent = `${g.emoji} ${g.name}`;
    b.addEventListener('click', () => {
      state.statsGalaxy = g.op;
      renderStatsGalaxyTabs();
      renderHeatmap(g.op);
    });
    wrap.appendChild(b);
  }
}

function setMicNote(txt) { $('#mic-support-note').textContent = txt; }

function renderMicNote() {
  if (!voskSupported) {
    setMicNote('⚠️ This browser can\'t use the mic here (it needs https or localhost). Tap answers instead — everything still works!');
  } else if (!state.save.settings.useMic) {
    setMicNote('Off — the microphone is never opened and the ~40 MB voice model is never downloaded. Switch it on to fetch it once; after that it works offline.');
  } else if (voiceLoad) {
    setMicNote('Hears spoken numbers on-device — accurate and private, and works offline. Tapping always works too.');
  } else {
    setMicNote('On — the ~40 MB voice model downloads the next time you play. Tapping always works too.');
  }
}

// Switching the mic off has to MEAN something: let go of the microphone now
// (so the browser's recording indicator goes out), hide the mic controls, and
// never fetch the voice model. Switching it on fetches the model there and
// then, rather than leaving a dead mic button until the next reload.
async function setMicEnabled(on) {
  state.save.settings.useMic = on;
  E.persist(state.save);

  if (!on) {
    if (state.mic) state.mic.stop();
    syncMicUi();
    renderMicNote();
    dbg('settings', 'mic off — microphone released, no model fetch');
    return;
  }

  ensureMic();
  syncMicUi();
  if (voiceLoad) { renderMicNote(); return; } // already downloaded this session

  try {
    await loadVoice({
      status: (txt) => setMicNote(txt),
      progress: (frac, received, total) => {
        if (total) setMicNote(`Downloading the voice… ${mbOf(received)} of ${mbOf(total)} MB — one time, then it works offline.`);
      },
    });
    renderMicNote();
  } catch (_) {
    setMicNote('⚠️ Couldn\'t download the voice model — check your connection. Tapping still works.');
  }
}

function renderHeatmap(op = 'mul') {
  const g = E.masteryGrid(state.save, op);
  const hm = $('#heatmap');
  hm.style.gridTemplateColumns = `repeat(${g.cols.length + 1}, 1fr)`;
  let html = `<div class="hc head">${g.symbol}</div>`;
  for (const c of g.cols) html += `<div class="hc head">${c}</div>`;
  g.cells.forEach((row, i) => {
    html += `<div class="hc head">${g.rows[i]}</div>`;
    for (const cell of row) {
      if (!cell.valid) { html += '<div class="hc empty"></div>'; continue; }
      const box = Math.max(0, Math.min(5, cell.box));
      html += `<div class="hc b${box}" title="${cell.r}${g.symbol}${cell.c}=${cell.answer}">${cell.answer}</div>`;
    }
  });
  hm.innerHTML = html;
}

// ===========================================================================
// Settings
// ===========================================================================
function renderSettings() {
  const s = state.save.settings;
  $('#set-mic').checked = s.useMic && voskSupported;
  $('#set-mic').disabled = !voskSupported;
  const voiceOk = hasVoices();
  $('#set-voice').checked = s.voicePrompts && voiceOk;
  $('#set-voice').disabled = !voiceOk;
  $('#set-sound').checked = s.sound;
  $('#set-name').value = state.save.name;
  renderMicNote();
  $('#voice-support-note').textContent = voiceOk
    ? 'Reads each question aloud.'
    : (!ttsSupported
        ? '⚠️ This browser can\'t speak. Sound effects still work.'
        : '⚠️ No speech voices are installed on this computer, so questions can\'t be read aloud. On Linux, install a voice engine (e.g. "sudo apt install speech-dispatcher espeak-ng") and restart your browser. Sound effects still work.');

  $('#set-mic').onchange = (e) => setMicEnabled(e.target.checked);
  $('#set-voice').onchange = (e) => { state.save.settings.voicePrompts = e.target.checked; E.persist(state.save); };
  $('#set-sound').onchange = (e) => { state.save.settings.sound = e.target.checked; E.persist(state.save); };
  $('#set-name').onchange = (e) => { state.save.name = e.target.value.trim() || 'Space Pilot'; E.persist(state.save); };
  $('#btn-reset').onclick = () => {
    if (confirm('Reset ALL progress? This cannot be undone.')) {
      E.resetSave(); state.save = null; renderHome(false); navTo('home');
    }
  };
}

// ===========================================================================
// Sound effects (synth — no asset files needed)
// ===========================================================================
function audio() {
  if (!state.save?.settings.sound) return null;
  if (!state.audioCtx) {
    try { state.audioCtx = new (window.AudioContext || window.webkitAudioContext)(); } catch (_) { return null; }
  }
  return state.audioCtx;
}
function beep(good, fast) {
  const ctx = audio();
  if (!ctx) return;
  const now = ctx.currentTime;
  const notes = good ? (fast ? [523, 659, 784, 1047] : [523, 784]) : [330, 247];
  notes.forEach((f, i) => {
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = good ? 'triangle' : 'sine';
    o.frequency.value = f;
    g.gain.setValueAtTime(0.0001, now + i * 0.08);
    g.gain.exponentialRampToValueAtTime(0.18, now + i * 0.08 + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, now + i * 0.08 + 0.18);
    o.connect(g); g.connect(ctx.destination);
    o.start(now + i * 0.08); o.stop(now + i * 0.08 + 0.2);
  });
}

// ===========================================================================
// Visual FX: starfield + confetti
// ===========================================================================
function startStarfield() {
  const c = $('#stars');
  const ctx = c.getContext('2d');
  let stars = [];
  function resize() {
    c.width = innerWidth; c.height = innerHeight;
    stars = Array.from({ length: Math.min(120, Math.floor(innerWidth * innerHeight / 9000)) }, () => ({
      x: Math.random() * c.width, y: Math.random() * c.height,
      r: Math.random() * 1.6 + 0.3, s: Math.random() * 0.4 + 0.05,
      t: Math.random() * Math.PI * 2,
    }));
  }
  resize();
  addEventListener('resize', resize);
  (function tick() {
    ctx.clearRect(0, 0, c.width, c.height);
    for (const st of stars) {
      st.y += st.s; if (st.y > c.height) { st.y = 0; st.x = Math.random() * c.width; }
      st.t += 0.05;
      const tw = 0.6 + Math.sin(st.t) * 0.4;
      ctx.globalAlpha = tw;
      ctx.fillStyle = '#fff';
      ctx.beginPath(); ctx.arc(st.x, st.y, st.r, 0, Math.PI * 2); ctx.fill();
    }
    ctx.globalAlpha = 1;
    requestAnimationFrame(tick);
  })();
}

function confettiBurst(count = 40) {
  const c = $('#confetti');
  const ctx = c.getContext('2d');
  c.width = innerWidth; c.height = innerHeight;
  const colors = ['#ffd24a', '#6ce5c8', '#ff7fb3', '#5be58a', '#8ab4ff', '#ffffff'];
  const parts = Array.from({ length: count }, () => ({
    x: c.width / 2 + (Math.random() - 0.5) * 120,
    y: c.height / 2 - 40,
    vx: (Math.random() - 0.5) * 9,
    vy: Math.random() * -9 - 4,
    g: 0.32 + Math.random() * 0.18,
    s: Math.random() * 8 + 5,
    rot: Math.random() * Math.PI, vr: (Math.random() - 0.5) * 0.4,
    col: colors[Math.floor(Math.random() * colors.length)],
    life: 80 + Math.random() * 40,
  }));
  let frame = 0;
  (function run() {
    ctx.clearRect(0, 0, c.width, c.height);
    let alive = false;
    for (const p of parts) {
      if (p.life <= 0) continue;
      alive = true;
      p.vy += p.g; p.x += p.vx; p.y += p.vy; p.rot += p.vr; p.life--;
      ctx.save();
      ctx.translate(p.x, p.y); ctx.rotate(p.rot);
      ctx.fillStyle = p.col; ctx.globalAlpha = Math.max(0, p.life / 60);
      ctx.fillRect(-p.s / 2, -p.s / 2, p.s, p.s * 0.6);
      ctx.restore();
    }
    frame++;
    if (alive && frame < 200) requestAnimationFrame(run);
    else ctx.clearRect(0, 0, c.width, c.height);
  })();
}

// ===========================================================================
// Multiplayer "Challenge" mode (WebRTC, serverless — see js/multiplayer.js)
// ===========================================================================
// All P2P + match logic lives in js/multiplayer.js (lazy-loaded so solo/offline
// play never pulls in the networking library). This controller just renders the
// host-authoritative state it emits and bridges keypad/voice input into it.
const mp = {
  mod: null,        // the lazily-imported multiplayer module
  session: null,    // active Session (host or guest)
  mode: null,       // 'host' | 'guest'
  op: 'mul',        // host's chosen operation
  numbers: new Set(),// host's chosen numbers (multiplicands / addends / subtrahends)
  phase: 'lobby',
  qIndex: -1,
  tShown: 0,        // performance.now() when the current question painted (fairness clock)
  answerStr: '',
  answered: false,  // submitted an answer this question
  locked: false,    // answered wrong → locked out this question
  count: 0,
};

async function ensureMp() {
  if (!mp.mod) mp.mod = await import('./multiplayer.js');
  return mp.mod;
}

function bindChallenge() {
  const onBtn = (id, fn) => { const el = $(id); if (el) el.addEventListener('click', fn); };

  onBtn('#btn-challenge', openLobby);
  onBtn('#btn-challenge-back', leaveChallenge);

  onBtn('#btn-make-room', hostCreate);
  onBtn('#btn-join-room', () => showLobbyView('join'));
  onBtn('#btn-join-cancel', () => showLobbyView('choose'));
  onBtn('#btn-join-go', guestJoin);
  onBtn('#btn-start-match', startMatch);

  onBtn('#btn-quit-versus', leaveChallenge);
  onBtn('#btn-versus-home', leaveChallenge);
  onBtn('#btn-rematch', () => { if (mp.session) mp.session.requestRematch(); });

  // versus keypad
  $$('#versus-keypad button').forEach((b) => b.addEventListener('click', () => onVersusKey(b.dataset.vk)));
  $('#versus-mic-btn')?.addEventListener('click', toggleMic);
  // physical keyboard
  window.addEventListener('keydown', (e) => {
    if (state.screen !== 'versus') return;
    if (/[0-9]/.test(e.key)) onVersusKey(e.key);
    else if (e.key === 'Enter') onVersusKey('enter');
    else if (e.key === 'Backspace') onVersusKey('back');
  });
}

function openLobby() {
  showLobbyView('choose');
  showScreen('challenge-lobby');
}

function showLobbyView(which) {
  $('#lobby-choose').classList.toggle('hidden', which !== 'choose');
  $('#lobby-join').classList.toggle('hidden', which !== 'join');
  $('#lobby-room').classList.toggle('hidden', which !== 'room');
}

const challengeCallbacks = () => ({
  onRoster: renderRoster,
  onState: onVersusState,
  onError: (msg) => { alert(msg); leaveChallenge(); },
  onConnected: () => { $('#lobby-status').textContent = 'Connected! Share your code.'; },
});

async function hostCreate() {
  try {
    const M = await ensureMp();
    const code = M.genCode();
    mp.mode = 'host';
    $('#lobby-status').textContent = 'Setting up…';
    mp.session = await M.createRoom(code, { name: playerName(), callbacks: challengeCallbacks() });
    $('#room-code').textContent = code;
    $('#host-setup').classList.remove('hidden');
    $('#guest-wait').classList.add('hidden');
    mp.op = 'mul';
    buildOpChips();
    buildNumberChips(mp.op);
    showLobbyView('room');
  } catch (e) {
    alert(connectErr(e));
    leaveChallenge();
  }
}

async function guestJoin() {
  const M = await ensureMp();
  const code = M.normalizeCode($('#join-code').value);
  if (code.length < 3) { $('#join-code').focus(); return; }
  try {
    mp.mode = 'guest';
    $('#lobby-status').textContent = 'Connecting…';
    mp.session = await M.joinRoom(code, { name: playerName(), callbacks: challengeCallbacks() });
    $('#room-code').textContent = code;
    $('#host-setup').classList.add('hidden');
    $('#guest-wait').classList.remove('hidden');
    showLobbyView('room');
  } catch (e) {
    alert(connectErr(e));
    leaveChallenge();
  }
}

function connectErr(e) {
  return (e && e.message === 'offline')
    ? 'Couldn’t reach the matchmaking service — multiplayer needs an internet connection.'
    : 'Couldn’t connect. Check the code and your connection, then try again.';
}

function playerName() {
  return (state.save && state.save.name) || $('#pilot-name')?.value.trim() || 'Player';
}

function renderRoster(list) {
  const ul = $('#roster');
  if (ul) {
    ul.innerHTML = list.map((p) =>
      `<li class="${p.isSelf ? 'me' : ''}">${p.isHost ? '👑 ' : ''}${escapeHtml(p.name)}${p.isSelf ? ' (you)' : ''}</li>`
    ).join('');
  }
  // host: need at least one other player to start
  if (mp.mode === 'host') {
    const others = list.filter((p) => !p.isSelf).length;
    const btn = $('#btn-start-match');
    if (btn) btn.disabled = others < 1 || mp.numbers.size === 0;
    $('#start-hint').textContent = others < 1
      ? 'Waiting for at least one friend to join…'
      : (mp.numbers.size === 0 ? 'Pick at least one number.' : `${others + 1} players ready!`);
  }
}

// Lobby number selection per operation.
const MP_NUMBER_RANGE = { mul: [1, 12], add: [0, 10], sub: [0, 10] };
const MP_DEFAULT = { mul: [2, 5, 10], add: [2, 5, 10], sub: [2, 5, 10] };
const MP_CHIPS_LABEL = {
  mul: 'Pick the times tables',
  add: 'Pick the addition numbers',
  sub: 'Pick the subtraction numbers',
};

function buildOpChips() {
  const wrap = $('#op-chips');
  if (!wrap) return;
  wrap.innerHTML = '';
  for (const g of GALAXIES) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'op-chip' + (g.op === mp.op ? ' on' : '');
    b.textContent = `${g.emoji} ${g.name}`;
    b.addEventListener('click', () => {
      if (mp.op === g.op) return;
      mp.op = g.op;
      buildOpChips();
      buildNumberChips(mp.op);
      renderRoster(mp.session ? mp.session.players() : []);
    });
    wrap.appendChild(b);
  }
}

function buildNumberChips(op) {
  const wrap = $('#table-chips');
  wrap.innerHTML = '';
  const label = $('#chips-label');
  if (label) label.textContent = MP_CHIPS_LABEL[op];
  const sym = OPERATIONS[op].symbol;
  const [lo, hi] = MP_NUMBER_RANGE[op];
  mp.numbers = new Set(MP_DEFAULT[op].filter((n) => n >= lo && n <= hi)); // a friendly default
  for (let n = lo; n <= hi; n++) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'table-chip' + (mp.numbers.has(n) ? ' on' : '');
    b.textContent = `${sym}${n}`;
    b.addEventListener('click', () => {
      if (mp.numbers.has(n)) mp.numbers.delete(n); else mp.numbers.add(n);
      b.classList.toggle('on');
      // re-evaluate the start button
      renderRoster(mp.session ? mp.session.players() : []);
    });
    wrap.appendChild(b);
  }
}

function startMatch() {
  if (!mp.session || mp.mode !== 'host' || !mp.numbers.size) return;
  mp.session.start([...mp.numbers].sort((a, b) => a - b), undefined, mp.op);
}

// ---- render host-authoritative match snapshots ----
function onVersusState(snap) {
  mp.phase = snap.phase;
  mp.count = snap.count || mp.count;

  if (state.screen !== 'versus' && snap.phase !== 'ended') {
    showScreen('versus');
    requestWakeLock();
  }

  if (snap.phase === 'countdown') { runVersusCountdown(); return; }
  if (snap.phase === 'question') { renderVersusQuestion(snap); return; }
  if (snap.phase === 'reveal') { renderVersusReveal(snap); return; }
  if (snap.phase === 'ended') { showVersusResult(snap); return; }
}

function runVersusCountdown() {
  mp.qIndex = -1; // force the first question to register as new
  if (mp._countdownTimer) clearInterval(mp._countdownTimer);
  const tf = $('#versus-timer');
  if (tf) { tf.style.transition = 'none'; tf.style.width = '100%'; }
  $('#versus-countdown').classList.remove('hidden');
  $('#versus-banner').textContent = '';
  $('#versus-feedback').textContent = '';
  $('#scoreboard').innerHTML = '';
  let n = 3;
  const el = $('#versus-countdown').firstElementChild;
  el.textContent = n;
  const tick = setInterval(() => {
    n--;
    if (n <= 0) { clearInterval(tick); el.textContent = 'Go!'; }
    else el.textContent = n;
  }, 1000);
  mp._countdownTimer = tick;
}

function renderVersusQuestion(snap) {
  $('#versus-countdown').classList.add('hidden');
  renderScoreboard(snap);
  $('#versus-progress').textContent = `Q ${snap.qIndex + 1} / ${snap.count}`;

  // only reset local input state when a NEW question starts
  if (snap.qIndex !== mp.qIndex) {
    mp.qIndex = snap.qIndex;
    mp.answerStr = '';
    mp.answered = false;
    mp.locked = false;
    const q = mp.session.currentQuestion();
    if (q) {
      $('#vq-a').textContent = q.a;
      $('#vq-op').textContent = q.symbol || '×';
      $('#vq-b').textContent = q.b;
    }
    $('#versus-slot').textContent = '?';
    $('#versus-slot').classList.remove('filled');
    $('#versus-feedback').textContent = '';
    $('#versus-feedback').className = 'feedback';
    $('#versus-banner').textContent = '';
    setVersusInputEnabled(true);

    // voice: each player may use their own mic if they have it on
    const useMic = micEnabled();
    $('#versus-mic-zone').style.display = useMic ? '' : 'none';
    $('#versus-heard').textContent = useMic ? 'Say it or tap it!' : 'Tap your answer!';
    if (useMic && !state.mic.listening) state.mic.start();

    // FAIRNESS: stamp the clock at real paint, not at message receipt.
    requestAnimationFrame(() => { mp.tShown = performance.now(); });
    startVersusTimer();
  }
}

// Skinny top bar that drains over the question's time limit (matches the host's
// authoritative per-question timeout in multiplayer.js).
function startVersusTimer() {
  const fill = $('#versus-timer');
  if (!fill) return;
  const ms = (mp.mod && mp.mod.QUESTION_MS) || 15000;
  fill.style.transition = 'none';
  fill.style.width = '100%';
  void fill.offsetWidth; // force reflow so the next change animates
  fill.style.transition = `width ${ms}ms linear`;
  fill.style.width = '0%';
}
function stopVersusTimer() {
  const fill = $('#versus-timer');
  if (!fill) return;
  const w = getComputedStyle(fill).width;
  fill.style.transition = 'none';
  fill.style.width = w; // freeze wherever it is
}

function renderVersusReveal(snap) {
  stopVersusTimer();
  renderScoreboard(snap);
  setVersusInputEnabled(false);
  const r = snap.lastResult || {};
  $('#versus-slot').textContent = r.answer != null ? r.answer : '?';
  $('#versus-slot').classList.add('filled');
  if (r.winnerId) {
    const who = r.winnerId === mp.session.selfId ? 'You' : escapeHtml(mp.session.nameOf(r.winnerId));
    $('#versus-banner').textContent = `🏅 ${who} got it first!`;
  } else {
    $('#versus-banner').textContent = `Nobody got it — it was ${r.answer}.`;
  }
}

function renderScoreboard(snap) {
  const board = $('#scoreboard');
  if (!board || !snap.players) return;
  const answered = new Set(snap.answered || []);
  const locked = new Set(snap.locked || []);
  const winner = snap.lastResult && snap.lastResult.winnerId;
  board.classList.toggle('compact', snap.players.length > 4);
  board.innerHTML = snap.players.map((p) => {
    const tag = locked.has(p.id) ? '🔒' : (answered.has(p.id) ? '⚡' : '');
    const me = p.id === mp.session.selfId ? ' me' : '';
    const win = p.id === winner ? ' winner' : '';
    return `<li class="${me}${win}"><span class="sb-name">${escapeHtml(p.name)}</span>` +
           `<span class="sb-tag">${tag}</span><span class="sb-score">${p.score}</span></li>`;
  }).join('');
}

// ---- versus input (keypad + voice) ----
function setVersusInputEnabled(on) {
  $('#versus-keypad').classList.toggle('disabled', !on);
}

function onVersusKey(k) {
  if (mp.phase !== 'question' || mp.answered || mp.locked) return;
  if (k === 'enter') { if (mp.answerStr !== '') submitVersus(parseInt(mp.answerStr, 10)); return; }
  if (k === 'back') mp.answerStr = mp.answerStr.slice(0, -1);
  else if (/^[0-9]$/.test(k)) { if (mp.answerStr.length < 3) mp.answerStr += k; }
  $('#versus-slot').textContent = mp.answerStr === '' ? '?' : mp.answerStr;
  $('#versus-slot').classList.toggle('filled', mp.answerStr !== '');
}

// Voice in a race mirrors solo: it only auto-submits a CORRECT answer (a mishear
// never locks you out). A definite wrong answer only happens via the keypad ✓.
function versusHeard(candidates) {
  if (mp.phase !== 'question' || mp.answered || mp.locked) return;
  const q = mp.session && mp.session.currentQuestion();
  if (!q) return;
  if (candidates.includes(q.answer)) submitVersus(q.answer);
  else if (candidates.length) $('#versus-heard').innerHTML = `I heard <b>${candidates[0]}</b> 🤔`;
}

function submitVersus(value) {
  if (mp.answered || mp.locked) return;
  const q = mp.session.currentQuestion();
  const correct = q && value === q.answer;
  const reactionMs = performance.now() - mp.tShown;
  mp.answered = true;
  mp.session.submitAnswer(value, reactionMs);

  $('#versus-slot').textContent = value;
  $('#versus-slot').classList.add('filled');
  if (correct) {
    setFeedbackEl('#versus-feedback', pick(['Got it! ✅', 'Yes! ⚡', 'Boom! 💥']), 'good');
    beep(true, true);
    confettiBurst(18);
  } else {
    mp.locked = true;
    setVersusInputEnabled(false);
    setFeedbackEl('#versus-feedback', '❌ Locked out — wait for the answer.', 'soft shake');
    beep(false);
  }
}

function setFeedbackEl(sel, txt, cls = '') {
  const el = $(sel);
  if (!el) return;
  el.textContent = txt;
  el.className = 'feedback' + (cls ? ' ' + cls : '');
}

function showVersusResult(snap) {
  if (mp._countdownTimer) clearInterval(mp._countdownTimer);
  if (state.mic) state.mic.stop();
  releaseWakeLock();
  const standings = (snap.players || []).slice().sort((a, b) => b.score - a.score);
  const top = standings[0] ? standings[0].score : 0;
  const winners = standings.filter((p) => p.score === top);
  const iWon = winners.some((p) => p.id === mp.session.selfId);
  const tie = winners.length > 1;

  $('#versus-result-burst').textContent = iWon ? '🏆' : (tie ? '🤝' : '🌟');
  $('#versus-result-title').textContent = tie
    ? "It's a tie!"
    : (iWon ? 'You win! 🎉' : `${escapeHtml(standings[0].name)} wins!`);

  $('#final-standings').innerHTML = standings.map((p, i) => {
    const medal = ['🥇', '🥈', '🥉'][i] || `${i + 1}.`;
    const me = p.id === mp.session.selfId ? ' me' : '';
    return `<li class="${me}"><span class="fs-rank">${medal}</span>` +
           `<span class="fs-name">${escapeHtml(p.name)}${p.id === mp.session.selfId ? ' (you)' : ''}</span>` +
           `<span class="fs-score">${p.score}</span></li>`;
  }).join('');

  // anyone can ask for a rematch; the host runs it
  $('#btn-rematch').textContent = mp.mode === 'host' ? 'Rematch 🔁' : 'Ask for Rematch 🔁';
  if (iWon) confettiBurst(120);
  showScreen('versus-result');
}

function leaveChallenge() {
  if (mp._countdownTimer) clearInterval(mp._countdownTimer);
  if (state.mic) state.mic.stop();
  releaseWakeLock();
  if (mp.session) { try { mp.session.leave(); } catch (_) {} }
  mp.session = null; mp.mode = null; mp.phase = 'lobby'; mp.qIndex = -1;
  navTo('home');
}

// ===========================================================================
// utils
// ===========================================================================
function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
function escapeHtml(s) { return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

boot();
