// levels.js — the journey. Each "level" is a planet; planets are grouped into
// GALAXIES, one per operation (multiplication, addition, subtraction).
//
// Sequencing follows fact-fluency research: teach the EASY ANCHOR facts first,
// then derived/strategy facts, then the genuinely hard handful, then a mixed
// "boss" review. For the commutative operations (× and +) we only ever track the
// canonical pair (e.g. 3×7 and 7×3 are the same fact), which roughly halves what
// must be learned. Subtraction is NOT commutative, so order is preserved.
//
// A planet's fact set is defined either by `operands` (facts where one operand is
// in a set — e.g. the "×3" planet, or "+0/+1") or by a `match(a,b)` predicate
// (strategy clusters that cut across operands — doubles `a===b`, make-10
// `a+b===10`, near-doubles `|a-b|===1`). A `review` planet covers the whole galaxy.

// ---------------------------------------------------------------------------
// Operations. The operator character in a fact key IS the operation, so most of
// the engine stays operation-agnostic — parseFactKey is the single choke point.
// ---------------------------------------------------------------------------
export const OPERATIONS = {
  mul: {
    id: 'mul', symbol: '×', word: 'times', commutative: true,
    compute: (a, b) => a * b,
    domain: () => canonPairs(0, 12),
    hasOperand: (a, b, n) => a === n || b === n,
  },
  add: {
    id: 'add', symbol: '+', word: 'plus', commutative: true,
    compute: (a, b) => a + b,
    domain: () => canonPairs(0, 10),
    hasOperand: (a, b, n) => a === n || b === n,
  },
  sub: {
    // Display symbol is U+2212 MINUS; the fact-key separator is ASCII '-'.
    id: 'sub', symbol: '−', word: 'minus', commutative: false,
    compute: (m, s) => m - s,
    domain: () => subPairs(),
    hasOperand: (m, s, n) => s === n, // subtraction planets are organized by subtrahend
  },
};

// ---------------------------------------------------------------------------
// Multiplication galaxy — the original 10-planet journey (ids L1..L10 preserved
// so existing saves keep their progress).
// ---------------------------------------------------------------------------
const MUL_PLANETS = [
  { id: 'L1', name: 'Mercury', emoji: '🌑', color: '#9ca3af',
    title: 'Easy Orbit', operands: [0, 1],
    hint: 'Anything times 0 is 0. Anything times 1 stays the same!' },
  { id: 'L2', name: 'Venus', emoji: '🌕', color: '#f5b971',
    title: 'Doubles', operands: [2],
    hint: '×2 means double it — add the number to itself.' },
  { id: 'L3', name: 'Earth', emoji: '🌎', color: '#4f9dde',
    title: 'Hand Counts', operands: [10, 5],
    hint: '×10 just adds a zero. ×5 ends in 5 or 0 — count by fives!' },
  { id: 'L4', name: 'Mars', emoji: '🔴', color: '#e06b4f',
    title: 'Threes', operands: [3],
    hint: '×3 is a double plus one more group.' },
  { id: 'L5', name: 'Jupiter', emoji: '🟠', color: '#d9a066',
    title: 'Fours', operands: [4],
    hint: '×4 is double, then double again.' },
  { id: 'L6', name: 'Saturn', emoji: '🪐', color: '#e8d27a',
    title: 'Nines', operands: [9],
    hint: 'Finger trick: the digits of a ×9 answer add up to 9!' },
  { id: 'L7', name: 'Uranus', emoji: '🔵', color: '#7fd4e0',
    title: 'Sixes', operands: [6],
    hint: '×6 is ×5 plus one more group of the number.' },
  { id: 'L8', name: 'Neptune', emoji: '🔷', color: '#5b6ee0',
    title: 'Sevens & Eights', operands: [7, 8],
    hint: 'The trickiest ones — 6×7, 7×8, 8×8. Practice makes them automatic.' },
  { id: 'L9', name: 'Pluto', emoji: '🌙', color: '#c0a0d0',
    title: 'Big Twelves', operands: [11, 12],
    hint: '×11 (up to 9) just doubles the digit. ×12 is ×10 plus ×2.' },
  { id: 'L10', name: 'The Sun', emoji: '☀️', color: '#ffcc33',
    title: 'Grand Mix', review: true,
    hint: 'Everything mixed together. Show what you know, space pilot!' },
];

// ---------------------------------------------------------------------------
// Addition galaxy — addends 0..10 (sums to 20), ordered by strategy.
// ---------------------------------------------------------------------------
const ADD_PLANETS = [
  { id: 'A1', name: 'Sirius', emoji: '⭐', color: '#bcd4ff',
    title: 'Plus 0 & 1', operands: [0, 1],
    hint: 'Adding 0 changes nothing. Adding 1 is just the next number!' },
  { id: 'A2', name: 'Vega', emoji: '✨', color: '#a7e0ff',
    title: 'Plus 2', operands: [2],
    hint: '+2 — count up two, or jump to the next even or odd number.' },
  { id: 'A3', name: 'Rigel', emoji: '🌟', color: '#9ad0ff',
    title: 'Doubles', match: (a, b) => a === b,
    hint: 'Doubles like 6+6 — learn these by heart, they unlock everything.' },
  { id: 'A4', name: 'Polaris', emoji: '💫', color: '#8ab4ff',
    title: 'Make Ten', match: (a, b) => a + b === 10,
    hint: 'Pairs that make 10: 1+9, 2+8, 3+7… super useful!' },
  { id: 'A5', name: 'Antares', emoji: '🌠', color: '#ffb4a7',
    title: 'Plus 10', operands: [10],
    hint: 'Adding 10 just puts a 1 in front — 3 becomes 13!' },
  { id: 'A6', name: 'Altair', emoji: '🔆', color: '#ffd86b',
    title: 'Near Doubles', match: (a, b) => Math.abs(a - b) === 1,
    hint: 'Next to a double? 6+7 is 6+6 plus 1 more.' },
  { id: 'A7', name: 'Deneb', emoji: '🌌', color: '#b69aff',
    title: 'Bridging Ten', all: true,
    hint: 'The trickier sums — use make-10: 8+5 = 8+2+3.' },
  { id: 'A8', name: 'Nova', emoji: '💥', color: '#ff9f4a',
    title: 'Grand Mix', review: true,
    hint: 'Every addition fact mixed together. Show what you know!' },
];

// ---------------------------------------------------------------------------
// Subtraction galaxy — minuend 0..20, subtrahend 0..10, difference 0..10
// (the inverse families of the addition facts). Taught as "think addition".
// Predicates receive (m, s) = (minuend, subtrahend).
// ---------------------------------------------------------------------------
const SUB_PLANETS = [
  { id: 'S1', name: 'Titan', emoji: '🌑', color: '#9ca3af',
    title: 'Minus 0 & 1', operands: [0, 1],
    hint: 'Subtract 0 changes nothing. Subtract 1 is the number before.' },
  { id: 'S2', name: 'Phobos', emoji: '🌒', color: '#b0a892',
    title: 'Minus 2', operands: [2],
    hint: '−2 — count back two.' },
  { id: 'S3', name: 'Callisto', emoji: '🌓', color: '#c4b58a',
    title: 'Halving Doubles', match: (m, s) => m === 2 * s,
    hint: '12−6, 14−7… the doubles, undone.' },
  { id: 'S4', name: 'Ganymede', emoji: '🌔', color: '#a7c8e0',
    title: 'Around Ten', match: (m, s) => m === 10 || m - s === 10,
    hint: 'Lean on 10: 10−4, and teens stepping back down to 10.' },
  { id: 'S5', name: 'Io', emoji: '🌕', color: '#e8d27a',
    title: 'Minus 10', operands: [10],
    hint: 'Subtract 10 — drop the ten: 13−10 = 3.' },
  { id: 'S6', name: 'Rhea', emoji: '🌖', color: '#d9a066',
    title: 'Down Through Ten', match: (m, s) => m > 10 && m - s < 10,
    hint: 'Cross back over 10: 13−5 = 13−3−2.' },
  { id: 'S7', name: 'Oberon', emoji: '🌗', color: '#c0a0d0',
    title: 'The Rest', all: true,
    hint: 'The last tricky ones — think addition: 11−4 → 4 plus what makes 11?' },
  { id: 'S8', name: 'Eclipse', emoji: '🌘', color: '#7a6fd0',
    title: 'Grand Mix', review: true,
    hint: 'Every subtraction fact mixed together. You’ve got this!' },
];

export const GALAXIES = [
  { id: 'add', op: 'add', name: 'Addition', emoji: '➕', color: '#8ab4ff',
    tagline: 'Build lightning-fast sums.', planets: ADD_PLANETS },
  { id: 'sub', op: 'sub', name: 'Subtraction', emoji: '➖', color: '#ff9f7a',
    tagline: 'Take away without breaking a sweat.', planets: SUB_PLANETS },
  { id: 'mul', op: 'mul', name: 'Multiplication', emoji: '✖️', color: '#ffcc33',
    tagline: 'Times tables, one planet at a time.', planets: MUL_PLANETS },
];

// Flat list of every planet across galaxies — used for save-record seeding,
// buddy assignment, and back-compat with code that iterates all planets.
export const PLANETS = GALAXIES.flatMap((g) => g.planets);

// Reward buddies collected for clearing planets — one distinct buddy per planet.
export const BUDDIES = [
  '🐙', '🦊', '🐢', '🦉', '🐸', '🦄', '🐲', '🦖', '🐳', '🦜', '🐝', '🦋',
  '🐬', '🦓', '🦒', '🐧', '🦩', '🐨', '🐼', '🦥', '🦦', '🐰', '🐹', '🦔',
  '🐺', '🦇', '🦅', '🐡',
];

// ---------------------------------------------------------------------------
// Fact keys. The operator char encodes the operation; multiplication keeps its
// original `aXb` form so existing saves need no migration.
// ---------------------------------------------------------------------------
export function factKey(op, a, b) {
  if (op === 'sub') return `${a}-${b}`;              // order preserved (non-commutative)
  const lo = Math.min(a, b);
  const hi = Math.max(a, b);
  return op === 'add' ? `${lo}+${hi}` : `${lo}x${hi}`;
}

export function parseFactKey(key) {
  let op, sep;
  if (key.includes('x')) { op = 'mul'; sep = 'x'; }
  else if (key.includes('+')) { op = 'add'; sep = '+'; }
  else { op = 'sub'; sep = '-'; }
  const [a, b] = key.split(sep).map(Number);
  return { op, a, b, answer: OPERATIONS[op].compute(a, b) };
}

// ---------------------------------------------------------------------------
// Galaxy / planet lookups.
// ---------------------------------------------------------------------------
export function galaxyOf(op) { return GALAXIES.find((g) => g.op === op) || null; }
export function galaxyOfPlanet(planetId) {
  return GALAXIES.find((g) => g.planets.some((p) => p.id === planetId)) || null;
}
export function planetsOfGalaxy(op) { const g = galaxyOf(op); return g ? g.planets : []; }
export function planetById(id) {
  for (const g of GALAXIES) { const p = g.planets.find((x) => x.id === id); if (p) return p; }
  return null;
}
export function buddyForPlanet(planetId) {
  const idx = PLANETS.findIndex((p) => p.id === planetId);
  return BUDDIES[(idx < 0 ? 0 : idx) % BUDDIES.length];
}

// ---------------------------------------------------------------------------
// Build the canonical facts a planet covers. A planet "owns" the facts it
// introduces that haven't appeared on an EARLIER planet IN THE SAME GALAXY — so
// progression doesn't re-test old facts. A `review` planet covers everything.
// ---------------------------------------------------------------------------
export function factsForPlanet(planetId) {
  const galaxy = galaxyOfPlanet(planetId);
  if (!galaxy) return [];
  const planets = galaxy.planets;
  const idx = planets.findIndex((p) => p.id === planetId);
  if (idx < 0) return [];

  const here = new Set();
  collectInto(galaxy, planets[idx], here);

  // Review planet reviews the whole galaxy.
  if (planets[idx].review) return [...here];

  const seen = new Set();
  for (let i = 0; i < idx; i++) collectInto(galaxy, planets[i], seen);

  const fresh = [...here].filter((k) => !seen.has(k));
  return fresh.length ? fresh : [...here];
}

function collectInto(galaxy, planet, set) {
  const op = galaxy.op;
  const O = OPERATIONS[op];
  for (const [a, b] of O.domain()) {
    let hit;
    if (planet.review || planet.all) hit = true;
    else if (planet.match) hit = planet.match(a, b);
    else hit = planet.operands.some((n) => O.hasOperand(a, b, n));
    if (hit) set.add(factKey(op, a, b));
  }
}

// --- operand-domain generators ---
function canonPairs(lo, hi) {
  const out = [];
  for (let a = lo; a <= hi; a++) for (let b = a; b <= hi; b++) out.push([a, b]);
  return out;
}

// Inverse-of-addition subtraction facts: minuend 0..20, subtrahend 0..10, with a
// non-negative single-digit difference (0..10). Never produces a negative answer.
function subPairs() {
  const out = [];
  for (let m = 0; m <= 20; m++) {
    for (let s = 0; s <= 10; s++) {
      const d = m - s;
      if (d >= 0 && d <= 10) out.push([m, s]);
    }
  }
  return out;
}
