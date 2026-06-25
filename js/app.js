// app.js — UI controller. Ties the engine, speech, and DOM together.

import { PLANETS, BUDDIES, factsForPlanet } from './levels.js';
import * as E from './engine.js';
import { Mic, micSupported, ttsSupported, speak } from './speech.js';

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

const state = {
  save: null,
  mic: null,
  screen: 'home',
  play: null,
  audioCtx: null,
};

// ===========================================================================
// Boot
// ===========================================================================
function boot() {
  startStarfield();
  state.save = E.loadSave();
  state.mic = micSupported ? new Mic() : null;
  if (state.mic) wireMic();

  bindGlobal();
  bindHome();
  bindPlay();
  bindStatsAndSettings();

  if (state.save) renderHome(true);
  else renderHome(false);
}

function bindGlobal() {
  $$('[data-nav]').forEach((b) => b.addEventListener('click', () => navTo(b.dataset.nav)));
}

function navTo(screen) {
  // hop screens, refreshing whatever the destination needs
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
    navTo('map');
  });
  $('#btn-continue').addEventListener('click', () => navTo('map'));
  $('#link-map').addEventListener('click', () => navTo('map'));
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
// Map
// ===========================================================================
function renderMap() {
  const track = $('#planet-track');
  track.innerHTML = '';
  const currentId = firstUncleared();
  for (const p of PLANETS) {
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

function firstUncleared() {
  const p = PLANETS.find((p) => !state.save.planets[p.id].cleared && state.save.planets[p.id].unlocked);
  return p ? p.id : PLANETS[PLANETS.length - 1].id;
}

function starStr(n) { return '★★★☆☆☆'.slice(3 - n, 6 - n) || '☆☆☆'; }

// ===========================================================================
// Planet detail
// ===========================================================================
function openPlanet(planetId) {
  const p = PLANETS.find((x) => x.id === planetId);
  const rec = state.save.planets[planetId];
  state.currentPlanet = planetId;
  $('#planet-title').textContent = p.name;
  $('#planet-big').textContent = p.emoji;
  $('#planet-stars').textContent = rec.cleared ? starStr(rec.stars) : '☆☆☆';
  $('#planet-hint').textContent = p.hint;
  const prog = E.planetProgress(state.save, planetId);
  $('#planet-bar').style.width = `${prog.pct}%`;
  $('#planet-progress-label').textContent = `${prog.learned} / ${prog.total} facts mastered`;
  showScreen('planet');
}

// ===========================================================================
// Play loop
// ===========================================================================
function bindPlay() {
  $('#btn-practice').addEventListener('click', () => startPlay('practice'));
  $('#btn-test').addEventListener('click', () => startPlay('test'));
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

function startPlay(mode) {
  const planetId = state.currentPlanet;
  state.play = {
    mode, planetId,
    expected: null, question: null, startedAt: 0, locked: true,
    answerStr: '', micMisfires: 0, streak: 0,
    practice: { count: 0, correct: 0 },
    test: mode === 'test' ? { queue: E.buildTest(state.save, planetId), idx: 0, results: [] } : null,
  };

  $('#play-mode-pill').textContent = mode === 'test' ? '🏅 Test' : '🎈 Practice';
  $('#streak-pill').textContent = '🔥 0';
  $('#btn-hint').hidden = mode === 'test';            // no hints during a test
  $('#btn-finish-practice').hidden = mode !== 'practice';
  $('#test-dots').hidden = mode !== 'test';
  if (mode === 'test') buildDots(state.play.test.queue.length);
  updateXpBar();

  showScreen('play');
  if (micEnabled()) state.mic.start();
  nextQuestion();
}

function micEnabled() { return state.mic && state.save.settings.useMic && micSupported; }

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
  } else {
    play.question = E.pickPracticeFact(state.save, play.planetId, play.question?.key);
  }

  play.expected = play.question.answer;
  play.answerStr = '';
  play.micMisfires = 0;
  play.locked = true; // stays locked until prompt finished

  $('#q-a').textContent = play.question.a;
  $('#q-b').textContent = play.question.b;
  setSlot('?');
  $('#answer-slot').classList.remove('filled');
  setFeedback('');
  $('#keypad').classList.remove('nudge');
  $('#heard').innerHTML = micEnabled()
    ? 'Listening… say your answer! 🎤'
    : 'Tap your answer below 👇';

  // Optional spoken prompt (mutes mic while talking).
  if (state.save.settings.voicePrompts && ttsSupported) {
    await speak(`What is ${play.question.a} times ${play.question.b}?`, { mic: state.mic });
  }

  play.startedAt = performance.now(); // silent timer — never shown as a clock
  play.locked = false;
  if (micEnabled() && !state.mic.listening) state.mic.start();
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
  if (!play || play.locked) return;
  if (k === 'enter') { if (play.answerStr !== '') commit(parseInt(play.answerStr, 10)); return; }
  if (k === 'back') { play.answerStr = play.answerStr.slice(0, -1); }
  else if (/^[0-9]$/.test(k)) { if (play.answerStr.length < 3) play.answerStr += k; }
  const slot = play.answerStr === '' ? '?' : play.answerStr;
  setSlot(slot);
  $('#answer-slot').classList.toggle('filled', play.answerStr !== '');
}

// ---- input: mic ----
function wireMic() {
  state.mic.onHeard = (candidates, transcript, isFinal) => {
    const play = state.play;
    if (!play || play.locked || state.screen !== 'play') return;

    // Delightful path: heard the correct answer -> instant win.
    if (candidates.includes(play.expected)) { commit(play.expected, true); return; }

    // Otherwise show what we heard so the child can self-correct.
    if (transcript) $('#heard').innerHTML = `I heard: <b>${escapeHtml(transcript)}</b> 🤔`;

    // Count a clear miss only on a final result; nudge the keypad after two.
    if (isFinal && candidates.length) {
      play.micMisfires++;
      if (play.micMisfires >= 2) {
        $('#heard').innerHTML = 'Hmm, the mic isn\'t sure — tap your answer below 👇';
        $('#keypad').classList.add('nudge');
      }
    }
  };
  state.mic.onState = (st, detail) => {
    if (st === 'listening') $('#mic-btn').classList.add('listening');
    if (st === 'idle' || st === 'error') $('#mic-btn').classList.remove('listening');
    if (st === 'error' && detail === 'denied') {
      state.save.settings.useMic = false; E.persist(state.save);
      $('#mic-btn').classList.add('off');
      $('#heard').textContent = 'Mic is off — just tap your answers! 👇';
    }
  };
}

function toggleMic() {
  if (!micSupported) return;
  if (!state.mic.listening) { state.mic.start(); $('#mic-btn').classList.remove('off'); }
  else { state.mic.stop(); }
}

// ---- commit an answer (value === null means "skip/reveal") ----
function commit(value, viaMic = false) {
  const play = state.play;
  if (!play || play.locked) return;
  play.locked = true;

  const elapsed = performance.now() - play.startedAt;
  const isCorrect = value !== null && value === play.expected;
  const result = E.recordAnswer(state.save, play.question, isCorrect, elapsed);
  E.persist(state.save);

  // tallies
  if (play.mode === 'practice') {
    play.practice.count++;
    if (isCorrect) play.practice.correct++;
  } else {
    play.test.results.push({ key: play.question.key, correct: isCorrect, elapsedMs: elapsed });
    markDot(play.test.idx, isCorrect ? 'right' : 'wrong');
    play.test.idx++;
  }

  // feedback + FX
  setSlot(play.expected);
  $('#answer-slot').classList.add('filled');
  updateXpBar();

  if (isCorrect) {
    play.streak++; // running count of correct answers in a row THIS session
    if (play.streak > state.save.streakBest) { state.save.streakBest = play.streak; E.persist(state.save); }
    $('#streak-pill').textContent = `🔥 ${play.streak}`;
    const msg = result.fast ? pick(['Lightning fast! ⚡', 'Zoom! 🚀', 'Wow! ⭐', 'Boom! 💥'])
                            : pick(['Nice! 🎉', 'You got it! ✅', 'Great! 🌟', 'Correct! 👏']);
    setFeedback(msg + (viaMic ? '' : ''), 'good');
    cheer(result.fast ? '🌟' : '⭐', result.mastered);
    beep(true, result.fast);
    if (result.fast) confettiBurst(result.mastered ? 60 : 24);
    if (state.save.settings.voicePrompts && ttsSupported && result.mastered) speak('Mastered!', { mic: state.mic });
    setTimeout(advance, 750);
  } else {
    play.streak = 0;
    $('#streak-pill').textContent = '🔥 0';
    setFeedback(`It's ${play.expected}. You'll get it next time! 💪`, 'soft shake');
    beep(false);
    if (state.save.settings.voicePrompts && ttsSupported) {
      speak(`${play.question.a} times ${play.question.b} is ${play.expected}`, { mic: state.mic });
    }
    setTimeout(advance, 1700);
  }
}

function advance() {
  if (!state.play) return;
  if (state.play.mode === 'test' && state.play.test.idx >= state.play.test.queue.length) {
    finishTest();
  } else {
    nextQuestion();
  }
}

function showHint() {
  const play = state.play;
  if (!play) return;
  const p = PLANETS.find((x) => x.id === play.planetId);
  setFeedback('💡 ' + p.hint, '');
}

function markDot(i, cls) {
  const dots = $$('#test-dots .dot');
  dots.forEach((d) => d.classList.remove('cur'));
  if (dots[i]) { dots[i].classList.add(cls); }
}

function endPlay() {
  if (state.mic) state.mic.stop();
  try { speechSynthesis.cancel(); } catch (_) {}
  state.play = null;
  navTo('map');
}

// ---- finishing ----
function finishTest() {
  const play = state.play;
  if (state.mic) state.mic.stop();
  const grade = E.gradeTest(state.save, play.planetId, play.test.results);
  E.persist(state.save);
  showResult(grade, play.planetId);
  state.play = null;
}

function finishPractice() {
  const play = state.play;
  if (state.mic) state.mic.stop();
  const { count, correct } = play.practice;
  const acc = count ? Math.round((correct / count) * 100) : 0;
  state.play = null;

  $('#result-burst').textContent = '🎈';
  $('#result-title').textContent = 'Good practice!';
  $('#result-stars').textContent = '';
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
  $('#result-stars').textContent = '★★★☆☆☆'.slice(3 - grade.stars, 6 - grade.stars) || '☆☆☆';

  const avgSec = grade.avgMs ? (grade.avgMs / 1000).toFixed(1) : '—';
  $('#result-stats').innerHTML =
    `Accuracy: <b>${Math.round(grade.acc * 100)}%</b> (${grade.correct}/${grade.total})<br>` +
    `Your speed: <b>${avgSec}s</b> per fact ${grade.avgMs && grade.avgMs <= E.CONFIG.fastMs ? '⚡' : ''}<br>` +
    (cleared ? '' : `<small>Reach ${Math.round(E.CONFIG.testAccuracy * 100)}% to clear this planet — you're almost there!</small>`);

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
    if (state.save.settings.voicePrompts && ttsSupported) speak('Planet cleared! Awesome work!', {});
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

  // buddy collection (locked silhouettes for not-yet-earned)
  const bc = $('#buddy-collection');
  bc.innerHTML = PLANETS.map((p, i) => {
    const b = BUDDIES[i % BUDDIES.length];
    const have = s.buddies.includes(b) && s.planets[p.id].cleared;
    return `<span class="${have ? '' : 'locked-buddy'}" title="${p.name}">${have ? b : '❔'}</span>`;
  }).join('');

  renderHeatmap();
}

function tile(big, lbl) {
  return `<div class="stat-tile"><div class="big">${big}</div><div class="lbl">${lbl}</div></div>`;
}

function renderHeatmap() {
  const grid = E.masteryGrid(state.save);
  const hm = $('#heatmap');
  let html = '<div class="hc head">×</div>';
  for (let b = 0; b <= 12; b++) html += `<div class="hc head">${b}</div>`;
  for (let a = 0; a <= 12; a++) {
    html += `<div class="hc head">${a}</div>`;
    for (let b = 0; b <= 12; b++) {
      const cell = grid[a][b];
      const box = Math.max(0, Math.min(5, cell.box));
      html += `<div class="hc b${box}" title="${a}×${b}=${cell.answer}">${cell.answer}</div>`;
    }
  }
  hm.innerHTML = html;
}

// ===========================================================================
// Settings
// ===========================================================================
function renderSettings() {
  const s = state.save.settings;
  $('#set-mic').checked = s.useMic && micSupported;
  $('#set-mic').disabled = !micSupported;
  $('#set-voice').checked = s.voicePrompts && ttsSupported;
  $('#set-voice').disabled = !ttsSupported;
  $('#set-sound').checked = s.sound;
  $('#set-name').value = state.save.name;
  $('#mic-support-note').textContent = micSupported
    ? 'Works best in Chrome, Edge, or Safari with an internet connection.'
    : '⚠️ This browser can\'t use the mic (try Chrome or Safari). Tap answers instead — everything still works!';

  $('#set-mic').onchange = (e) => { state.save.settings.useMic = e.target.checked; E.persist(state.save); };
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
// utils
// ===========================================================================
function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
function escapeHtml(s) { return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

boot();
