// levels.js — the journey. Each "level" is a planet on a space map.
//
// Sequencing follows fact-fluency research: teach the EASY ANCHOR facts first
// (×0, ×1, ×2, ×5, ×10), then derived/strategy facts (×3, ×4, ×9), then the
// genuinely hard handful (×6, ×7, ×8), then optional ×11/×12, then a mixed
// "boss" review. Commutativity means we only ever track the canonical pair
// (e.g. 3×7 and 7×3 are the same fact), which roughly halves what must be learned.

// A fact "family" is the set of canonical facts introduced at a level.
// We express each planet by the new multiplier(s) it introduces; the actual
// facts are generated against the full 0..12 range but de-duplicated by the
// canonical key so a child never has to learn both 3×7 and 7×3 separately.

export const PLANETS = [
  {
    id: 'L1', name: 'Mercury', emoji: '🌑', color: '#9ca3af',
    title: 'Easy Orbit', multipliers: [0, 1],
    hint: 'Anything times 0 is 0. Anything times 1 stays the same!',
  },
  {
    id: 'L2', name: 'Venus', emoji: '🌕', color: '#f5b971',
    title: 'Doubles', multipliers: [2],
    hint: '×2 means double it — add the number to itself.',
  },
  {
    id: 'L3', name: 'Earth', emoji: '🌎', color: '#4f9dde',
    title: 'Hand Counts', multipliers: [10, 5],
    hint: '×10 just adds a zero. ×5 ends in 5 or 0 — count by fives!',
  },
  {
    id: 'L4', name: 'Mars', emoji: '🔴', color: '#e06b4f',
    title: 'Threes', multipliers: [3],
    hint: '×3 is a double plus one more group.',
  },
  {
    id: 'L5', name: 'Jupiter', emoji: '🟠', color: '#d9a066',
    title: 'Fours', multipliers: [4],
    hint: '×4 is double, then double again.',
  },
  {
    id: 'L6', name: 'Saturn', emoji: '🪐', color: '#e8d27a',
    title: 'Nines', multipliers: [9],
    hint: 'Finger trick: the digits of a ×9 answer add up to 9!',
  },
  {
    id: 'L7', name: 'Uranus', emoji: '🔵', color: '#7fd4e0',
    title: 'Sixes', multipliers: [6],
    hint: '×6 is ×5 plus one more group of the number.',
  },
  {
    id: 'L8', name: 'Neptune', emoji: '🔷', color: '#5b6ee0',
    title: 'Sevens & Eights', multipliers: [7, 8],
    hint: 'The trickiest ones — 6×7, 7×8, 8×8. Practice makes them automatic.',
  },
  {
    id: 'L9', name: 'Pluto', emoji: '🌙', color: '#c0a0d0',
    title: 'Big Twelves', multipliers: [11, 12],
    hint: '×11 (up to 9) just doubles the digit. ×12 is ×10 plus ×2.',
  },
  {
    id: 'L10', name: 'The Sun', emoji: '☀️', color: '#ffcc33',
    title: 'Grand Mix', multipliers: 'ALL',
    hint: 'Everything mixed together. Show what you know, space pilot!',
  },
];

// Reward buddies collected for clearing planets.
export const BUDDIES = ['🐙', '🦊', '🐢', '🦉', '🐸', '🦄', '🐲', '🦖', '🐳', '🦜', '🐝', '🦋'];

const MAX_FACTOR = 12;

// Canonical key so 3×7 and 7×3 are one fact.
export function factKey(a, b) {
  const lo = Math.min(a, b);
  const hi = Math.max(a, b);
  return `${lo}x${hi}`;
}

// Build the list of canonical facts a planet covers.
// Each planet "owns" the facts that its multipliers introduce and that haven't
// appeared on an earlier planet — so progression doesn't re-test old facts.
export function factsForPlanet(planetId) {
  const idx = PLANETS.findIndex((p) => p.id === planetId);
  if (idx < 0) return [];

  const seen = new Set();
  for (let i = 0; i < idx; i++) collectInto(PLANETS[i], seen);

  const here = new Set();
  collectInto(PLANETS[idx], here);

  // Facts new to this planet (not seen on earlier planets).
  const fresh = [...here].filter((k) => !seen.has(k));

  // The Sun reviews everything.
  if (PLANETS[idx].multipliers === 'ALL') return [...here];

  return fresh.length ? fresh : [...here];
}

function collectInto(planet, set) {
  const mults = planet.multipliers === 'ALL'
    ? range(0, MAX_FACTOR)
    : planet.multipliers;
  for (const m of mults) {
    for (let other = 0; other <= MAX_FACTOR; other++) {
      set.add(factKey(m, other));
    }
  }
}

function range(a, b) {
  const out = [];
  for (let i = a; i <= b; i++) out.push(i);
  return out;
}

export function parseFactKey(key) {
  const [a, b] = key.split('x').map(Number);
  return { a, b, answer: a * b };
}
