// engine.js — the brain: per-fact mastery, spaced repetition, level gating, XP.
//
// Persistence is a single localStorage blob per profile. Everything is plain
// JSON so it survives across sessions and devices (if the child uses the same
// browser). No backend, no accounts — perfect for a static GitHub Page.

import {
  PLANETS, GALAXIES, OPERATIONS, factsForPlanet, parseFactKey, factKey,
  galaxyOfPlanet, buddyForPlanet,
} from './levels.js';

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
  maxStars: 5,
  xpPerCorrect: 10,
  xpPerFast: 5,         // bonus for a fast answer
  xpStreakBonus: 2,     // per streak step

  // --- practice weighting (see pickPracticeFact) ---
  missMemory: 3,        // how many recent misses a fact can "remember"
  missDecayFast: 0.5,   // a fast correct answer forgives this much of a miss
  missDecaySlow: 0.25,  // a slow correct answer forgives less
  maxSlowFactor: 2.5,   // ceiling on the slowness multiplier
  maxShare: 0.25,       // no single fact may exceed this share of practice draws
  starveAfter: 3,       // force a fact in if unseen for (pool size x this) trials

  // --- fluency run: stars 4 and 5 ---
  // One bar for every operation. 21/min is the ~3s-per-fact retrieval boundary;
  // 30/min is the ~2s-per-fact automaticity criterion. The run window is shorter
  // for the +/- galaxies (younger kids) - the per-minute bar is identical, only
  // the sampling window changes, so fatigue doesn't masquerade as slowness.
  fluency: {
    rate4: 21,            // correct facts per minute for the 4th star
    rate5: 30,            // ...and the 5th
    accuracyFloor: 0.9,   // speed without accuracy earns nothing
    durationMs: { mul: 180000, add: 120000, sub: 120000 },
    currentShare: 0.6,    // share of questions drawn from THIS planet's facts
    smallPlanet: 8,       // planets with fewer facts than this...
    smallShare: 0.4,      // ...lean on review instead, so it isn't a 3-fact loop
    // Lean run: no spoken prompt and a clipped pause, or 30/min is unreachable.
    goodMs: 250,          // pause after a correct answer
    badMs: 900,           // pause after a miss (long enough to read the answer)
    autoSubmit: true,     // submit as soon as the answer's digit count is typed
  },
};

export function fluencyDurationMs(op) {
  return CONFIG.fluency.durationMs[op] ?? 180000;
}

function blankFact() {
  return { att: 0, correct: 0, box: 1, streak: 0, ema: null, best: null, lastIdx: -1, miss: 0 };
}

export function loadSave() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return migrate(JSON.parse(raw));
  } catch (e) { /* corrupt save — start fresh */ }
  return null;
}

// The first planet of every galaxy starts unlocked.
const STARTERS = new Set(GALAXIES.map((g) => g.planets[0].id));

export function newSave(name) {
  const save = {
    name: name || 'Space Pilot',
    createdAt: Date.now(),
    facts: {},
    planets: {},
    buddies: [],
    xp: 0,
    streakBest: 0,
    trialCounter: 0,
    settings: { useMic: true, voicePrompts: true, sound: true },
    history: [],
  };
  seedPlanets(save);
  return save;
}

function migrate(save) {
  if (!save.settings) save.settings = { useMic: true, voicePrompts: true, sound: true };
  delete save.settings.engine; // legacy: speech engine choice is gone (Vosk only)
  if (!save.buddies) save.buddies = [];
  if (!save.history) save.history = [];
  if (!save.planets) save.planets = {};
  seedPlanets(save); // backfill records for any planets/galaxies the save predates
  return save;
}

// Ensure every planet (across all galaxies) has a record, without disturbing
// existing progress. Each galaxy's first planet is unlocked.
function seedPlanets(save) {
  for (const p of PLANETS) {
    if (save.planets[p.id] && save.planets[p.id].bestRate == null) save.planets[p.id].bestRate = 0;
    if (!save.planets[p.id]) {
      save.planets[p.id] = { unlocked: STARTERS.has(p.id), cleared: false, bestAcc: 0, bestAvgMs: null, bestRate: 0, stars: 0 };
    }
  }
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
// Weighted random over the planet's facts. A fact is drawn more often when it
// is in a low Leitner box, has been MISSED recently, is answered SLOWLY, or
// hasn't been seen in a while. Three rules keep that from turning practice into
// a grind on the same three facts:
//
//   1. no immediate repeats, so it interleaves rather than drills;
//   2. a share cap - no fact may exceed CONFIG.maxShare of the draws;
//   3. a starvation rule - any fact unseen for (pool x starveAfter) trials is
//      forced in, so the easy ones keep getting rehearsed too.
// ---------------------------------------------------------------------------
export function pickPracticeFact(save, planetId, avoidKey) {
  const keys = factsForPlanet(planetId);
  save.trialCounter++;
  const now = save.trialCounter;

  let pool = keys.filter((k) => k !== avoidKey);
  if (!pool.length) pool = keys;

  // Coverage guarantee: facts ignored for too long jump the queue. Coming back
  // to a big planet after a break can starve many at once, so they're still
  // ordered by need rather than picked uniformly — coverage without throwing
  // the weighting away.
  const starved = pool.filter((k) => {
    const f = save.facts[k];
    return f && f.lastIdx >= 0 && (now - f.lastIdx) > keys.length * CONFIG.starveAfter;
  });
  if (starved.length) {
    return makeQuestion(weightedPick(starved, capWeights(starved.map((k) => practiceWeight(save, k, now)))));
  }

  const weights = capWeights(pool.map((k) => practiceWeight(save, k, now)));
  return makeQuestion(weightedPick(pool, weights));
}

// How badly does this fact need practice right now? Higher = shown more often.
export function practiceWeight(save, key, now) {
  const f = save.facts[key] || blankFact();
  const boxWeight = (CONFIG.masteryBox + 1 - f.box);          // box1 -> 5, box5 -> 1
  const staleness = f.lastIdx < 0 ? 6 : Math.min(6, (now - f.lastIdx));
  const neverSeen = f.att === 0 ? 3 : 1;
  return boxWeight * (1 + staleness * 0.5) * slowFactor(f) * missFactor(f) * neverSeen + 0.1;
}

// Slowness is continuous, not a cliff: a fact answered in 8s outranks one that
// takes 3.1s, where the old binary "over 3 seconds?" test treated them alike.
function slowFactor(f) {
  if (f.ema == null) return 1;
  return Math.max(0.8, Math.min(CONFIG.maxSlowFactor, f.ema / CONFIG.fastMs));
}

// Memory of recent misses. A wrong answer already drops the fact to box 1, but
// that evaporates the moment it's answered right once. This decays gradually,
// so a fact that was missed keeps getting extra reps while it re-settles.
function missFactor(f) {
  return 1 + Math.min(CONFIG.missMemory, f.miss || 0);
}

// Clamp every weight so no single fact can dominate a session — struggling
// facts should come up more often, not turn practice into a grind on the worst
// three. The cap is on the FINAL share, so it has to be solved rather than just
// multiplied out: capping one weight shrinks the total, which lifts everyone
// else's share. Each pass pulls the current worst offender down to exactly the
// cap; a pool can hold at most 1/maxShare offenders, so this settles quickly.
// The cap never falls below an equal share, leaving small pools (2-4 facts)
// untouched.
function capWeights(weights) {
  if (weights.length <= 1) return weights;
  const share = Math.max(CONFIG.maxShare, 1 / weights.length);
  const out = [...weights];

  for (let pass = 0; pass < weights.length; pass++) {
    const total = out.reduce((s, w) => s + w, 0);
    if (!total) break;
    let worst = -1;
    for (let i = 0; i < out.length; i++) {
      if (out[i] / total > share + 1e-9 && (worst < 0 || out[i] > out[worst])) worst = i;
    }
    if (worst < 0) break;
    // Solve c / (c + rest) = share for the capped weight.
    const rest = total - out[worst];
    out[worst] = (rest * share) / (1 - share);
  }
  return out;
}

// Build a question from a fact key. For commutative operations we randomize the
// orientation so the child sees both 3×7 and 7×3; subtraction keeps its order.
export function makeQuestion(key) {
  const { op, a, b, answer } = parseFactKey(key);
  const O = OPERATIONS[op];
  let x = a, y = b;
  // Show both orientations of a commutative fact (3x7 and 7x3). This used to be
  // derived from Date.now(), which is constant within a millisecond — so a burst
  // of questions all flipped the same way.
  if (O.commutative && Math.random() < 0.5) [x, y] = [b, a];
  return { key, a: x, b: y, answer, op, symbol: O.symbol, word: O.word };
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
    f.streak++; // per-fact streak (feeds XP bonus); the visible session streak lives in app.js
    // EMA of response time (only for correct answers).
    f.ema = f.ema == null ? elapsedMs : Math.round(f.ema * 0.7 + elapsedMs * 0.3);
    f.best = f.best == null ? elapsedMs : Math.min(f.best, elapsedMs);
    if (fast && f.box < CONFIG.masteryBox) { f.box++; leveledUpBox = true; }
    // Forgive the miss memory gradually — fast recall forgives twice as much.
    f.miss = Math.max(0, (f.miss || 0) - (fast ? CONFIG.missDecayFast : CONFIG.missDecaySlow));
    xp = CONFIG.xpPerCorrect + (fast ? CONFIG.xpPerFast : 0) + Math.min(20, f.streak * CONFIG.xpStreakBonus);
  } else {
    f.streak = 0;
    f.box = 1; // demote to box 1 on a miss so it re-presents soon (research-backed)
    f.miss = Math.min(CONFIG.missMemory, (f.miss || 0) + 1);
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

  // Star rating, 1-3 of 5: 1 for passing accuracy, +1 for speed, +1 for
  // near-perfect. Stars 4 and 5 come only from a Fluency Run (see below), and
  // a star already earned is never taken away by a weaker re-test.
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
    // Award a buddy (one distinct buddy per planet).
    buddy = buddyForPlanet(planetId);
    if (!save.buddies.includes(buddy)) save.buddies.push(buddy);
    // Unlock the next planet IN THE SAME GALAXY.
    const planets = galaxyOfPlanet(planetId)?.planets || [];
    const idx = planets.findIndex((p) => p.id === planetId);
    if (idx >= 0 && idx + 1 < planets.length) {
      const next = planets[idx + 1].id;
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
// FLUENCY RUN — the 4th and 5th stars.
//
// A fixed-length timed run (3 min for x, 2 min for + and -) scored as CORRECT
// FACTS PER MINUTE against a wall clock, which is what "sustained fluency"
// means and what a teacher's timed fact sheet measures. Speed alone earns
// nothing: both the run as a whole and the current planet's own facts must
// clear the accuracy floor, so a child can't coast on easy review facts while
// missing the new ones.
//
// Questions mix this planet's facts with everything taught earlier in the
// galaxy. The current planet's facts are drawn from a bag (every fact appears
// before any repeats); review facts are drawn by the same struggle-weighting
// practice uses, so old shaky facts resurface and old solid ones don't eat the
// clock.
//
// Callers own the timer: build a run, pull questions with next(), push each
// answer into run.results, then call gradeFluency() when the clock expires.
// ---------------------------------------------------------------------------
export function createFluencyRun(save, planetId) {
  const galaxy = galaxyOfPlanet(planetId);
  const op = galaxy ? galaxy.op : 'mul';
  const current = factsForPlanet(planetId);

  // Everything introduced EARLIER in this galaxy. A review planet already owns
  // the whole galaxy, so its review pool is empty and the run is all "current".
  const owned = new Set(current);
  const review = [];
  for (const p of (galaxy ? galaxy.planets : [])) {
    if (p.id === planetId) break;
    for (const k of factsForPlanet(p.id)) {
      if (!owned.has(k)) { owned.add(k); review.push(k); }
    }
  }

  // A planet with only a handful of facts would otherwise become the same three
  // questions on a loop — which measures keypad rhythm, not fluency. Those lean
  // on review instead.
  const share = !review.length ? 1
    : current.length < CONFIG.fluency.smallPlanet ? CONFIG.fluency.smallShare
    : CONFIG.fluency.currentShare;

  let bag = [];
  return {
    planetId, op, current, review,
    currentShare: share,
    durationMs: fluencyDurationMs(op),
    results: [],
    lastKey: null,

    next() {
      save.trialCounter++;
      const fromCurrent = !this.review.length || Math.random() < this.currentShare;
      let key;

      if (fromCurrent) {
        if (!bag.length) bag = shuffle([...this.current]);
        key = bag.pop();
        // Don't ask the same fact twice in a row — put it back, take the next.
        if (key === this.lastKey && bag.length) {
          const alt = bag.pop();
          bag.unshift(key);
          key = alt;
        }
      } else {
        const now = save.trialCounter;
        const pool = this.review.length > 1
          ? this.review.filter((k) => k !== this.lastKey)
          : this.review;
        key = weightedPick(pool, capWeights(pool.map((k) => practiceWeight(save, k, now))));
      }

      this.lastKey = key;
      return { ...makeQuestion(key), fromCurrent };
    },
  };
}

// Score a completed run. `run.results` entries are
// { key, correct, elapsedMs, fromCurrent }.
export function gradeFluency(save, planetId, run) {
  const F = CONFIG.fluency;
  const results = run.results;
  const total = results.length;
  const correct = results.filter((r) => r.correct).length;
  const acc = total ? correct / total : 0;

  // Fixed window, so the denominator is the clock — not how many they attempted.
  const rate = Math.round((correct / (run.durationMs / 60000)) * 10) / 10;

  const cur = results.filter((r) => r.fromCurrent);
  const curAcc = cur.length ? cur.filter((r) => r.correct).length / cur.length : acc;
  const accurate = acc >= F.accuracyFloor && curAcc >= F.accuracyFloor;

  // The fluency stars sit ON TOP of clearing the planet — never instead of it.
  // The UI only offers a run on a cleared planet; this is the backstop.
  const rec = save.planets[planetId];
  let earned = 0;
  if (rec.cleared && accurate && rate >= F.rate5) earned = 5;
  else if (rec.cleared && accurate && rate >= F.rate4) earned = 4;

  const before = rec.stars;
  rec.bestRate = Math.max(rec.bestRate || 0, rate);
  if (earned > rec.stars) rec.stars = earned;

  save.history.push({ at: Date.now(), planetId, mode: 'fluency', total, correct, acc, rate, stars: rec.stars });
  if (save.history.length > 100) save.history.shift();

  return {
    rate, acc, curAcc, correct, total, accurate,
    earned, stars: rec.stars, newStar: rec.stars > before,
    // What the next star would take (null once both are earned).
    nextRate: rec.stars >= 5 ? null : rec.stars >= 4 ? F.rate5 : F.rate4,
  };
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

// Mastery grid for the stats heatmap, per operation. Rows/cols and validity vary
// by operation (subtraction is a minuend×subtrahend triangle).
const GRID_SPEC = {
  mul: { rows: [0, 12], cols: [0, 12], valid: () => true },
  add: { rows: [0, 10], cols: [0, 10], valid: () => true },
  sub: { rows: [0, 20], cols: [0, 10], valid: (m, s) => m - s >= 0 && m - s <= 10 },
};

export function masteryGrid(save, op = 'mul') {
  const O = OPERATIONS[op];
  const spec = GRID_SPEC[op];
  const rows = rangeArr(spec.rows[0], spec.rows[1]);
  const cols = rangeArr(spec.cols[0], spec.cols[1]);
  const cells = rows.map((r) => cols.map((c) => {
    if (!spec.valid(r, c)) return { r, c, valid: false };
    const f = save.facts[factKey(op, r, c)];
    return {
      r, c, valid: true, answer: O.compute(r, c),
      box: f ? f.box : 0, ema: f?.ema ?? null, att: f?.att ?? 0,
    };
  }));
  return { op, symbol: O.symbol, rows, cols, cells };
}

function rangeArr(lo, hi) {
  const out = [];
  for (let i = lo; i <= hi; i++) out.push(i);
  return out;
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
