// facts.test.js — the fact engine across all three operations (×, +, −).
import { describe, it, expect } from 'vitest';
import {
  OPERATIONS, GALAXIES, factKey, parseFactKey, factsForPlanet, planetsOfGalaxy,
} from '../js/levels.js';
import { makeQuestion } from '../js/engine.js';
import { buildQuestions } from '../js/multiplayer.js';

describe('factKey / parseFactKey round-trips', () => {
  it('multiplication keeps its original canonical form (backward compatible)', () => {
    expect(factKey('mul', 3, 7)).toBe('3x7');
    expect(factKey('mul', 7, 3)).toBe('3x7'); // commutative → canonical
    expect(parseFactKey('3x7')).toEqual({ op: 'mul', a: 3, b: 7, answer: 21 });
  });

  it('addition uses + and is canonical', () => {
    expect(factKey('add', 3, 7)).toBe('3+7');
    expect(factKey('add', 7, 3)).toBe('3+7');
    expect(parseFactKey('3+7')).toEqual({ op: 'add', a: 3, b: 7, answer: 10 });
  });

  it('subtraction uses - and PRESERVES order (non-commutative)', () => {
    expect(factKey('sub', 18, 9)).toBe('18-9');
    expect(factKey('sub', 9, 18)).toBe('9-18');
    expect(parseFactKey('18-9')).toEqual({ op: 'sub', a: 18, b: 9, answer: 9 });
  });

  it('every op computes the right answer', () => {
    expect(OPERATIONS.mul.compute(6, 7)).toBe(42);
    expect(OPERATIONS.add.compute(6, 7)).toBe(13);
    expect(OPERATIONS.sub.compute(15, 7)).toBe(8);
  });
});

describe('makeQuestion orientation', () => {
  it('never flips subtraction (order is meaningful)', () => {
    for (let i = 0; i < 50; i++) {
      const q = makeQuestion('18-9');
      expect(q.a).toBe(18);
      expect(q.b).toBe(9);
      expect(q.answer).toBe(9);
      expect(q.symbol).toBe('−');
      expect(q.word).toBe('minus');
    }
  });

  it('may flip commutative ops but keeps the operands and answer', () => {
    const seen = new Set();
    for (let i = 0; i < 50; i++) {
      const q = makeQuestion('3x7');
      expect(new Set([q.a, q.b])).toEqual(new Set([3, 7]));
      expect(q.answer).toBe(21);
      seen.add(`${q.a},${q.b}`);
    }
    // over 50 tries we should have seen both orientations
    expect(seen.size).toBe(2);
  });
});

describe('subtraction facts stay in the valid (inverse-family) range', () => {
  it('no negative differences, difference 0..10, minuend ≤ 20', () => {
    for (const planet of planetsOfGalaxy('sub')) {
      for (const key of factsForPlanet(planet.id)) {
        const { a: m, b: s, answer } = parseFactKey(key);
        expect(answer).toBeGreaterThanOrEqual(0);
        expect(answer).toBeLessThanOrEqual(10);
        expect(m).toBeLessThanOrEqual(20);
        expect(s).toBeLessThanOrEqual(10);
      }
    }
  });
});

describe('each galaxy partitions its facts across strategy planets', () => {
  for (const g of GALAXIES) {
    it(`${g.name}: every fact is owned by exactly one non-review planet`, () => {
      const domain = new Set(OPERATIONS[g.op].domain().map(([a, b]) => factKey(g.op, a, b)));
      const owners = new Map(); // key -> count of planets that "own" it as fresh

      for (const planet of g.planets) {
        if (planet.review) continue; // review planets re-cover everything by design
        for (const key of factsForPlanet(planet.id)) {
          owners.set(key, (owners.get(key) || 0) + 1);
        }
      }

      // no double-ownership
      for (const [key, count] of owners) {
        expect(count, `${key} owned by ${count} planets`).toBe(1);
      }
      // no gaps: the owned set equals the full domain
      expect(new Set(owners.keys())).toEqual(domain);
    });

    it(`${g.name}: the review planet covers the whole galaxy`, () => {
      const review = g.planets.find((p) => p.review);
      const domain = new Set(OPERATIONS[g.op].domain().map(([a, b]) => factKey(g.op, a, b)));
      expect(new Set(factsForPlanet(review.id))).toEqual(domain);
    });
  }
});

describe('multiplayer buildQuestions per operation', () => {
  it('addition: answers are correct sums', () => {
    const qs = buildQuestions([2, 3], 12, 99, 'add');
    expect(qs).toHaveLength(12);
    for (const q of qs) {
      expect(q.op).toBe('add');
      expect(q.answer).toBe(q.a + q.b);
      expect(q.symbol).toBe('+');
    }
  });

  it('subtraction: correct, ordered, never negative', () => {
    const qs = buildQuestions([2, 5, 10], 20, 7, 'sub');
    expect(qs).toHaveLength(20);
    for (const q of qs) {
      expect(q.op).toBe('sub');
      expect(q.answer).toBe(q.a - q.b);
      expect(q.answer).toBeGreaterThanOrEqual(0);
      expect(q.a).toBeLessThanOrEqual(20); // minuend in range
    }
  });

  it('is deterministic for a given seed (peers derive identical sets)', () => {
    expect(buildQuestions([2, 3], 10, 12345, 'add'))
      .toEqual(buildQuestions([2, 3], 10, 12345, 'add'));
  });

  it('defaults to multiplication for legacy 3-arg callers', () => {
    const qs = buildQuestions([2], 5, 1);
    for (const q of qs) {
      expect(q.op).toBe('mul');
      expect(q.answer).toBe(q.a * q.b);
    }
  });
});
