// fluency.test.js — the 4th and 5th stars: the timed run, its question mix,
// and the accuracy floor that stops speed-without-thinking from scoring.
import { describe, it, expect } from 'vitest';
import * as E from '../js/engine.js';
import { factsForPlanet } from '../js/levels.js';

const F = E.CONFIG.fluency;

// Build `n` results, `wrong` of which are misses, all from the current planet.
function results(n, wrong = 0, fromCurrent = true) {
  return Array.from({ length: n }, (_, i) => ({
    key: '3x7', correct: i >= wrong, elapsedMs: 1500, fromCurrent,
  }));
}

function runFor(save, planetId, res) {
  const run = E.createFluencyRun(save, planetId);
  run.results = res;
  return run;
}

// A fluency run is only ever offered on a planet that's already cleared.
function cleared(name = 't', planetId = 'L10') {
  const save = E.newSave(name);
  save.planets[planetId].cleared = true;
  save.planets[planetId].stars = 3;
  return save;
}

describe('fluency run: duration', () => {
  it('gives multiplication 3 minutes and +/- 2 minutes', () => {
    expect(E.fluencyDurationMs('mul')).toBe(180000);
    expect(E.fluencyDurationMs('add')).toBe(120000);
    expect(E.fluencyDurationMs('sub')).toBe(120000);
  });

  it('measures rate against the fixed window, not the attempted count', () => {
    const save = cleared();
    // 63 correct in a 3-minute window is exactly 21/min.
    const g = E.gradeFluency(save, 'L10', runFor(save, 'L10', results(63)));
    expect(g.rate).toBe(21);
  });
});

describe('fluency run: star thresholds', () => {
  it('awards the 4th star at the 4-star rate', () => {
    const save = cleared('t', 'L10');
    const g = E.gradeFluency(save, 'L10', runFor(save, 'L10', results(F.rate4 * 3)));
    expect(g.earned).toBe(4);
    expect(save.planets.L10.stars).toBe(4);
  });

  it('awards the 5th star at the 5-star rate', () => {
    const save = cleared('t', 'L10');
    const g = E.gradeFluency(save, 'L10', runFor(save, 'L10', results(F.rate5 * 3)));
    expect(g.earned).toBe(5);
    expect(g.nextRate).toBeNull();
  });

  it('awards nothing below the 4-star rate', () => {
    const save = cleared('t', 'L10');
    const g = E.gradeFluency(save, 'L10', runFor(save, 'L10', results(F.rate4 * 3 - 3)));
    expect(g.earned).toBe(0);
    expect(g.nextRate).toBe(F.rate4);
  });

  it('uses the same bar for every operation', () => {
    const save = cleared('t', 'A8');
    // 2-minute window for addition: rate5 * 2 correct answers hits the same
    // per-minute bar as rate5 * 3 does over multiplication's 3 minutes.
    const g = E.gradeFluency(save, 'A8', runFor(save, 'A8', results(F.rate5 * 2)));
    expect(g.rate).toBe(F.rate5);
    expect(g.earned).toBe(5);
  });

  it('never takes away a star a weaker run would not have earned', () => {
    const save = cleared();
    E.gradeFluency(save, 'L10', runFor(save, 'L10', results(F.rate5 * 3)));
    const g = E.gradeFluency(save, 'L10', runFor(save, 'L10', results(10)));
    expect(save.planets.L10.stars).toBe(5);
    expect(g.newStar).toBe(false);
  });

  it('keeps the best rate across runs', () => {
    const save = cleared();
    E.gradeFluency(save, 'L10', runFor(save, 'L10', results(90)));
    E.gradeFluency(save, 'L10', runFor(save, 'L10', results(30)));
    expect(save.planets.L10.bestRate).toBe(30);
  });
});

describe('fluency run: accuracy floor', () => {
  it('blocks a star when overall accuracy is under the floor', () => {
    const save = cleared();
    // Fast enough for 5 stars, but a quarter of them wrong.
    const res = results(120, 30);
    const g = E.gradeFluency(save, 'L10', runFor(save, 'L10', res));
    expect(g.rate).toBeGreaterThanOrEqual(F.rate5);
    expect(g.accurate).toBe(false);
    expect(g.earned).toBe(0);
  });

  it('blocks a star when the CURRENT planet is weak but review props up the total', () => {
    const save = cleared('t', 'L4');
    // 80 review facts perfect, 20 current-planet facts with 3 missed: 97%
    // overall, but only 85% on the facts this planet is actually teaching.
    const res = [...results(80, 0, false), ...results(20, 3, true)];
    const g = E.gradeFluency(save, 'L4', runFor(save, 'L4', res));
    expect(g.acc).toBeGreaterThanOrEqual(F.accuracyFloor); // overall looks fine...
    expect(g.curAcc).toBeLessThan(F.accuracyFloor);        // ...but the new facts don't
    expect(g.earned).toBe(0);
  });
});

describe('fluency stars sit on top of clearing the planet', () => {
  it('awards nothing on a planet that has not been cleared yet', () => {
    const save = E.newSave('t'); // L10 not cleared
    const g = E.gradeFluency(save, 'L10', runFor(save, 'L10', results(F.rate5 * 3)));
    expect(g.rate).toBeGreaterThanOrEqual(F.rate5);
    expect(g.earned).toBe(0);
    expect(save.planets.L10.stars).toBe(0);
  });

  it('still records the rate, so the effort is not lost', () => {
    const save = E.newSave('t');
    E.gradeFluency(save, 'L10', runFor(save, 'L10', results(90)));
    expect(save.planets.L10.bestRate).toBe(30);
  });
});

describe('end-of-run review: what went wrong', () => {
  const miss = (key, given, a, b, symbol) => ({ key, correct: false, elapsedMs: 4000, fromCurrent: true, a, b, symbol, given });
  const hit = (key) => ({ key, correct: true, elapsedMs: 1200, fromCurrent: true });

  it('lists each missed fact with the answer given and the right one', () => {
    const save = cleared();
    const res = [hit('2x3'), miss('7x8', 54, 7, 8, '×'), hit('4x4'), miss('6x9', 56, 6, 9, '×')];
    const { missed } = E.gradeFluency(save, 'L10', runFor(save, 'L10', res));

    expect(missed).toHaveLength(2);
    expect(missed[0]).toMatchObject({ key: '7x8', a: 7, b: 8, symbol: '×', answer: 56, given: 54, times: 1 });
    expect(missed[1]).toMatchObject({ key: '6x9', answer: 54, given: 56, times: 1 });
  });

  it('lists a fact once however many times it was missed', () => {
    const save = cleared();
    const res = [miss('7x8', 54, 7, 8, '×'), miss('7x8', 49, 7, 8, '×'), miss('7x8', null, 7, 8, '×')];
    const { missed } = E.gradeFluency(save, 'L10', runFor(save, 'L10', res));
    expect(missed).toHaveLength(1);
    expect(missed[0].times).toBe(3);
    expect(missed[0].given).toBe(54); // the first answer they tried
  });

  it('marks a skipped question as skipped rather than as a wrong number', () => {
    const save = cleared();
    const { missed } = E.gradeFluency(save, 'L10', runFor(save, 'L10', [miss('7x8', null, 7, 8, '×')]));
    expect(missed[0].given).toBeNull();
  });

  it('is empty on a clean run', () => {
    const save = cleared();
    const { missed } = E.gradeFluency(save, 'L10', runFor(save, 'L10', results(60)));
    expect(missed).toEqual([]);
  });

  it('falls back to the canonical fact when a result carries no display info', () => {
    const save = cleared();
    const res = [{ key: '6x7', correct: false, elapsedMs: 4000, fromCurrent: true }];
    const { missed } = E.gradeFluency(save, 'L10', runFor(save, 'L10', res));
    expect(missed[0]).toMatchObject({ a: 6, b: 7, symbol: '×', answer: 42, given: null });
  });

  it('reviews the regular planet test too', () => {
    const save = E.newSave('t');
    const res = [
      { key: '2x3', correct: true, elapsedMs: 1000 },
      { key: '18-9', correct: false, elapsedMs: 5000, a: 18, b: 9, symbol: '−', given: 8 },
    ];
    const grade = E.gradeTest(save, 'S8', res);
    expect(grade.missed).toHaveLength(1);
    expect(grade.missed[0]).toMatchObject({ a: 18, b: 9, symbol: '−', answer: 9, given: 8 });
  });
});

describe('fluency run: question mix', () => {
  it('mixes the current planet with earlier facts from the same galaxy', () => {
    const save = E.newSave('t');
    const run = E.createFluencyRun(save, 'L4');
    expect(run.currentShare).toBe(F.currentShare);
    expect(new Set(run.current)).toEqual(new Set(factsForPlanet('L4')));
    // Everything from L1-L3, and nothing the current planet already owns.
    expect(run.review.length).toBe(55);
    expect(run.review.some((k) => run.current.includes(k))).toBe(false);
  });

  it('leans on review for planets too small to fill a run', () => {
    const save = E.newSave('t');
    expect(factsForPlanet('L9').length).toBeLessThan(F.smallPlanet);
    expect(E.createFluencyRun(save, 'L9').currentShare).toBe(F.smallShare);
  });

  it('is all-current on a first planet and on a review planet', () => {
    const save = E.newSave('t');
    expect(E.createFluencyRun(save, 'L1').review).toHaveLength(0);
    expect(E.createFluencyRun(save, 'L1').currentShare).toBe(1);
    // The Grand Mix already owns the whole galaxy.
    const sun = E.createFluencyRun(save, 'L10');
    expect(sun.review).toHaveLength(0);
    expect(sun.current.length).toBe(91);
  });

  it('covers every current-planet fact before repeating any', () => {
    const save = E.newSave('t');
    const run = E.createFluencyRun(save, 'L1'); // share = 1, so every draw is current
    const seen = run.current.map(() => run.next().key);
    expect(new Set(seen).size).toBe(run.current.length);
  });

  it('never asks the same fact twice in a row', () => {
    const save = E.newSave('t');
    for (const id of ['L1', 'L4', 'L10', 'A8', 'S6']) {
      const run = E.createFluencyRun(save, id);
      let prev = null;
      for (let i = 0; i < 400; i++) {
        const q = run.next();
        expect(q.key, `${id} repeated ${q.key} back to back`).not.toBe(prev);
        prev = q.key;
      }
    }
  });

  it('holds roughly to the current/review split over a long run', () => {
    const save = E.newSave('t');
    const run = E.createFluencyRun(save, 'L4');
    let current = 0;
    const N = 3000;
    for (let i = 0; i < N; i++) if (run.next().fromCurrent) current++;
    expect(current / N).toBeGreaterThan(F.currentShare - 0.06);
    expect(current / N).toBeLessThan(F.currentShare + 0.06);
  });

  it('tags each question so grading can tell current from review', () => {
    const save = E.newSave('t');
    const run = E.createFluencyRun(save, 'L4');
    for (let i = 0; i < 200; i++) {
      const q = run.next();
      expect(q.fromCurrent).toBe(run.current.includes(q.key));
      expect(q.answer).toBe(q.op === 'mul' ? q.a * q.b : q.answer);
    }
  });
});
