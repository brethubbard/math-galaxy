// engine.js — the brain: per-fact mastery, spaced repetition, level gating, XP.
//
// Persistence is a single localStorage blob per profile. Everything is plain
// JSON so it survives across sessions and devices (if the child uses the same
// browser). No backend, no accounts — perfect for a static GitHub Page.

import { PLANETS, BUDDIES, factsForPlanet, parseFactKey, factKey } from './levels.js';

const STORAGE_KEY = 'mathgalaxy.save.v1';

// Tunable defaults (refined to match fluency research):
//  - A fact counts as "automatic" when answered correctly in under ~3s. Research
//    on retrieval vs. counting puts the automaticity boundary around 2–3 seconds.
//  - Leitner boxes 1..5; box 5 = mastered. Fast+correct promotes; wrong demotes.
//  - A planet is cleared (next unlocks) when a Test hits the accuracy AND speed bar.
export const CONFIG = {
  fastMs: 3000,         // answer under this = "automatic" (earns a promotion)
  masteryBox: 5,        // box that means a fact is fully learned
  testAccuracy: 0.9,    // % correct needed to clear a planet's test
  testAvgMs: 4000,      // average response time bar for clearing (gentle)
  testSize: 12,         // questions in a level test (capped at #facts)
  xpPerCorrect: 10,
  xpPerFast: 5,         // bonus for a fast answer
  xpStreakBonus: 2,     // per streak step
};

function blankFact() {
  return { att: 0, correct: 0, box: 1, streak: 0, ema: null, best: null, lastIdx: -1 };
}

export function loadSave() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return migrate(JSON.parse(raw));
  } catch (e) { /* corrupt save — start fresh */ }
  return null;
}

export function newSave(name) {
  const save = {
    name: name || 'Space Pilot',
    createdAt: Date.now(),
    facts: {},
    planets: { L1: { unlocked: true, cleared: false, bestAcc: 0, bestAvgMs: null, stars: 0 } },
    buddies: [],
    xp: 0,
    streakBest: 0,
    trialCounter: 0,
    settings: { useMic: true, voicePrompts: true, sound: true },
    history: [],
  };
  // Ensure every planet has a record.
  for (const p of PLANETS) {
    if (!save.planets[p.id]) {
      save.planets[p.id] = { unlocked: p.id === 'L1', cleared: false, bestAcc: 0, bestAvgMs: null, stars: 0 };
    }
  }
  return save;
}

function migrate(save) {
  if (!save.settings) save.settings = { useMic: true, voicePrompts: true, sound: true };
  if (!save.buddies) save.buddies = [];
  if (!save.history) save.history = [];
  for (const p of PLANETS) {
    if (!save.planets[p.id]) {
      save.planets[p.id] = { unlocked: p.id === 'L1', cleared: false, bestAcc: 0, bestAvgMs: null, stars: 0 };
    }
  }
  return save;
}

export function persist(save) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(save)); } catch (e) { /* quota — ignore */ }
}

export function resetSave() {
  try { localStorage.removeItem(STORAGE_KEY); } catch (e) { /* ignore */ }
}

function fact(save, key) {
  if (!save.facts[key]) save.facts[key] = blankFact();
  return save.facts[key];
}

// ---------------------------------------------------------------------------
// Spaced repetition: pick the next fact to show during PRACTICE.
//
// Weighted random over the planet's facts. Weight rewards: low Leitner box
// (needs work), staleness (not seen recently), and slowness. We also forbid
// immediate repeats so it feels like interleaving, not drilling one fact.
// ---------------------------------------------------------------------------
export function pickPracticeFact(save, planetId, avoidKey) {
  const keys = factsForPlanet(planetId);
  save.trialCounter++;
  const now = save.trialCounter;

  let pool = keys.filter((k) => k !== avoidKey);
  if (!pool.length) pool = keys;

  const weights = pool.map((k) => {
    const f = save.facts[k] || blankFact();
    const boxWeight = (CONFIG.masteryBox + 1 - f.box); // box1 -> 5, box5 -> 1
    const staleness = f.lastIdx < 0 ? 6 : Math.min(6, (now - f.lastIdx));
    const slow = f.ema && f.ema > CONFIG.fastMs ? 2 : 1;
    const neverSeen = f.att === 0 ? 3 : 1;
    return boxWeight * (1 + staleness * 0.5) * slow * neverSeen + 0.1;
  });

  const key = weightedPick(pool, weights);
  return makeQuestion(key);
}

// Build a randomized-orientation question from a canonical key.
export function makeQuestion(key) {
  const { a, b, answer } = parseFactKey(key);
  // Randomly flip orientation so the child sees both 3×7 and 7×3.
  const flip = Math.floor(Math.abs(Math.sin(a * 99 + b * 17 + Date.now())) * 2) % 2 === 0;
  const [x, y] = flip ? [a, b] : [b, a];
  return { key, a: x, b: y, answer };
}

// Build a fixed, shuffled test set for a planet.
export function buildTest(save, planetId) {
  const keys = shuffle([...factsForPlanet(planetId)]);
  const n = Math.min(CONFIG.testSize, keys.length);
  // Bias the test toward not-yet-mastered facts, but always cover variety.
  keys.sort((k1, k2) => boxOf(save, k1) - boxOf(save, k2));
  const chosen = shuffle(keys.slice(0, Math.max(n, Math.min(keys.length, n))));
  return chosen.slice(0, n).map(makeQuestion);
}

function boxOf(save, key) { return (save.facts[key] || blankFact()).box; }

// ---------------------------------------------------------------------------
// Record an answer. Returns a result describing what happened (for the UI/FX).
// ---------------------------------------------------------------------------
export function recordAnswer(save, question, isCorrect, elapsedMs) {
  const f = fact(save, question.key);
  f.att++;
  f.lastIdx = save.trialCounter;
  const fast = isCorrect && elapsedMs <= CONFIG.fastMs;

  let xp = 0;
  let leveledUpBox = false;

  if (isCorrect) {
    f.correct++;
    f.streak++;
    save.streakBest = Math.max(save.streakBest, f.streak);
    // EMA of response time (only for correct answers).
    f.ema = f.ema == null ? elapsedMs : Math.round(f.ema * 0.7 + elapsedMs * 0.3);
    f.best = f.best == null ? elapsedMs : Math.min(f.best, elapsedMs);
    if (fast && f.box < CONFIG.masteryBox) { f.box++; leveledUpBox = true; }
    xp = CONFIG.xpPerCorrect + (fast ? CONFIG.xpPerFast : 0) + Math.min(20, f.streak * CONFIG.xpStreakBonus);
  } else {
    f.streak = 0;
    f.box = 1; // demote to box 1 on a miss so it re-presents soon (research-backed)
  }

  save.xp += xp;
  return { isCorrect, fast, xp, box: f.box, mastered: f.box >= CONFIG.masteryBox, leveledUpBox };
}

// Score a completed test and unlock the next planet if it cleared.
export function gradeTest(save, planetId, results) {
  const total = results.length;
  const correct = results.filter((r) => r.correct).length;
  const acc = total ? correct / total : 0;
  const times = results.filter((r) => r.correct).map((r) => r.elapsedMs);
  const avgMs = times.length ? Math.round(times.reduce((s, t) => s + t, 0) / times.length) : null;

  const speedOk = avgMs == null ? false : avgMs <= CONFIG.testAvgMs;
  const cleared = acc >= CONFIG.testAccuracy && speedOk;

  // Star rating: 1 for passing accuracy, +1 for speed, +1 for near-perfect.
  let stars = 0;
  if (acc >= CONFIG.testAccuracy) stars++;
  if (speedOk) stars++;
  if (acc >= 0.98 && avgMs != null && avgMs <= CONFIG.fastMs) stars++;

  const rec = save.planets[planetId];
  rec.bestAcc = Math.max(rec.bestAcc, acc);
  if (avgMs != null) rec.bestAvgMs = rec.bestAvgMs == null ? avgMs : Math.min(rec.bestAvgMs, avgMs);
  rec.stars = Math.max(rec.stars, stars);

  let newlyCleared = false;
  let unlockedNext = null;
  let buddy = null;

  if (cleared && !rec.cleared) {
    rec.cleared = true;
    newlyCleared = true;
    // Award a buddy.
    const idx = PLANETS.findIndex((p) => p.id === planetId);
    buddy = BUDDIES[idx % BUDDIES.length];
    if (!save.buddies.includes(buddy)) save.buddies.push(buddy);
    // Unlock next planet.
    if (idx + 1 < PLANETS.length) {
      const next = PLANETS[idx + 1].id;
      save.planets[next].unlocked = true;
      unlockedNext = next;
    }
  } else if (cleared) {
    rec.cleared = true;
  }

  save.history.push({ at: Date.now(), planetId, mode: 'test', total, correct, acc, avgMs, cleared });
  if (save.history.length > 100) save.history.shift();

  return { acc, avgMs, stars, cleared, newlyCleared, unlockedNext, buddy, correct, total };
}

// ---------------------------------------------------------------------------
// Read-only helpers for the UI.
// ---------------------------------------------------------------------------
export function planetProgress(save, planetId) {
  const keys = factsForPlanet(planetId);
  if (!keys.length) return { learned: 0, total: 0, pct: 0 };
  const learned = keys.filter((k) => (save.facts[k]?.box || 1) >= CONFIG.masteryBox).length;
  return { learned, total: keys.length, pct: Math.round((learned / keys.length) * 100) };
}

export function xpLevel(xp) {
  // Gentle curve: rank up every ~150 xp.
  const rank = Math.floor(xp / 150) + 1;
  const into = xp % 150;
  return { rank, into, need: 150, pct: Math.round((into / 150) * 100) };
}

// Full 13×13 mastery grid (0..12) for the stats heatmap.
export function masteryGrid(save) {
  const grid = [];
  for (let a = 0; a <= 12; a++) {
    const row = [];
    for (let b = 0; b <= 12; b++) {
      const f = save.facts[factKey(a, b)];
      row.push({ a, b, answer: a * b, box: f ? f.box : 0, ema: f?.ema ?? null, att: f?.att ?? 0 });
    }
    grid.push(row);
  }
  return grid;
}

// --- small utilities ---
function weightedPick(items, weights) {
  const sum = weights.reduce((s, w) => s + w, 0);
  let r = Math.random() * sum;
  for (let i = 0; i < items.length; i++) {
    r -= weights[i];
    if (r <= 0) return items[i];
  }
  return items[items.length - 1];
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}
