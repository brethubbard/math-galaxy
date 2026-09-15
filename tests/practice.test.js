// practice.test.js — the weighted practice draw. Facts that were missed or are
// answered slowly must come up MORE often, without crowding out the rest.
import { describe, it, expect } from 'vitest';
import * as E from '../js/engine.js';
import { factsForPlanet } from '../js/levels.js';

const PLANET = 'L4'; // Mars, 8 facts — small enough to count, big enough to mix

// A fact the child knows cold: mastered box, fast, never missed.
const SOLID = { att: 12, correct: 12, box: 5, streak: 6, ema: 1200, best: 900, lastIdx: 0, miss: 0 };

function seed(planetId, overrides = {}) {
  const save = E.newSave('t');
  for (const k of factsForPlanet(planetId)) save.facts[k] = { ...SOLID };
  for (const [k, patch] of Object.entries(overrides)) {
    save.facts[k] = { ...save.facts[k], ...patch };
  }
  return save;
}

// Draw n practice questions, marking each as presented but otherwise leaving
// the fact state frozen, so we measure the WEIGHTING and not the learning.
function draw(save, planetId, n) {
  const counts = {};
  let prev;
  for (let i = 0; i < n; i++) {
    const q = E.pickPracticeFact(save, planetId, prev);
    counts[q.key] = (counts[q.key] || 0) + 1;
    save.facts[q.key].lastIdx = save.trialCounter;
    prev = q.key;
  }
  return counts;
}

describe('practice weighting: struggling facts come up more', () => {
  it('shows a recently missed fact more often than a solid one', () => {
    const keys = factsForPlanet(PLANET);
    const [missed, solid] = keys;
    const save = seed(PLANET, { [missed]: { miss: 3 } });
    const counts = draw(save, PLANET, 4000);
    expect(counts[missed]).toBeGreaterThan(counts[solid] * 1.5);
  });

  it('shows a slow fact more often than a fast one', () => {
    const keys = factsForPlanet(PLANET);
    const [slow, fast] = keys;
    const save = seed(PLANET, { [slow]: { ema: 9000 } });
    const counts = draw(save, PLANET, 4000);
    expect(counts[slow]).toBeGreaterThan(counts[fast] * 1.5);
  });

  it('treats slowness as a slope, not a cliff — 8s outranks 3.1s', () => {
    const keys = factsForPlanet(PLANET);
    const [verySlow, barelySlow] = keys;
    const save = seed(PLANET, { [verySlow]: { ema: 8000 }, [barelySlow]: { ema: 3100 } });
    const counts = draw(save, PLANET, 4000);
    expect(counts[verySlow]).toBeGreaterThan(counts[barelySlow] * 1.3);
  });

  it('shows a fact in a low Leitner box more often than a mastered one', () => {
    const keys = factsForPlanet(PLANET);
    const [weak, strong] = keys;
    const save = seed(PLANET, { [weak]: { box: 1 } });
    const counts = draw(save, PLANET, 4000);
    expect(counts[weak]).toBeGreaterThan(counts[strong] * 1.5);
  });
});

describe('practice weighting: everything still gets practiced', () => {
  it('draws every fact on the planet, even with three facts struggling', () => {
    const keys = factsForPlanet(PLANET);
    const save = seed(PLANET, {
      [keys[0]]: { box: 1, miss: 3, ema: 9000 },
      [keys[1]]: { box: 1, miss: 3, ema: 9000 },
      [keys[2]]: { box: 1, miss: 2, ema: 8000 },
    });
    const counts = draw(save, PLANET, 2000);
    for (const k of keys) {
      expect(counts[k], `${k} never came up`).toBeGreaterThan(0);
    }
  });

  it('caps how much of a session one struggling fact can eat', () => {
    const keys = factsForPlanet(PLANET);
    const hog = keys[0];
    const save = seed(PLANET, { [hog]: { att: 0, box: 1, miss: 3, ema: 12000 } });
    const N = 4000;
    const counts = draw(save, PLANET, N);
    // The cap is a share of the weight, and the no-repeat rule redistributes a
    // little on top, so allow headroom over the nominal cap.
    expect(counts[hog] / N).toBeLessThan(E.CONFIG.maxShare + 0.08);
  });

  it('rescues a fact that has gone unseen for too long', () => {
    const keys = factsForPlanet(PLANET);
    const forgotten = keys[0];
    const save = seed(PLANET);
    // Everything else was just seen; this one fell off the end of the queue.
    save.trialCounter = 100;
    for (const k of keys) save.facts[k].lastIdx = 99;
    save.facts[forgotten].lastIdx = 100 - keys.length * E.CONFIG.starveAfter - 5;

    // Past the starvation horizon it is forced in, whatever the weights say.
    expect(E.pickPracticeFact(save, PLANET, keys[1]).key).toBe(forgotten);
  });

  it('prefers a never-seen fact over a mastered one', () => {
    const keys = factsForPlanet(PLANET);
    const fresh = keys[0];
    const save = seed(PLANET, { [fresh]: { att: 0, correct: 0, box: 1, ema: null, lastIdx: -1 } });
    const counts = draw(save, PLANET, 2000);
    expect(counts[fresh]).toBeGreaterThan(counts[keys[1]]);
  });
});

describe('miss memory decays as a fact is relearned', () => {
  it('forgives faster on a fast correct answer than a slow one', () => {
    const save = E.newSave('t');
    const key = '4x6';
    save.facts[key] = { ...SOLID, miss: 3 };
    E.recordAnswer(save, E.makeQuestion(key), true, 1000); // fast
    const afterFast = save.facts[key].miss;

    save.facts[key] = { ...SOLID, miss: 3 };
    E.recordAnswer(save, E.makeQuestion(key), true, 5000); // slow
    expect(afterFast).toBeLessThan(save.facts[key].miss);
  });

  it('remembers a miss and never runs negative', () => {
    const save = E.newSave('t');
    const key = '4x6';
    E.recordAnswer(save, E.makeQuestion(key), false, 5000);
    expect(save.facts[key].miss).toBe(1);
    for (let i = 0; i < 20; i++) E.recordAnswer(save, E.makeQuestion(key), true, 900);
    expect(save.facts[key].miss).toBe(0);
  });

  it('caps how much history one fact can accumulate', () => {
    const save = E.newSave('t');
    const key = '4x6';
    for (let i = 0; i < 20; i++) E.recordAnswer(save, E.makeQuestion(key), false, 5000);
    expect(save.facts[key].miss).toBe(E.CONFIG.missMemory);
  });
});
