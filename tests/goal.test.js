// goal.test.js — the daily goal: what counts as practice time, when the clock
// pauses, and the "due" flag the UI uses to pick a stopping point.
//
// Every test drives the clock with an explicit `now`, so none of this waits on
// real time.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import * as E from '../js/engine.js';

// The engine persists through localStorage; vitest runs in node, which has none.
if (typeof globalThis.localStorage === 'undefined') {
  const mem = new Map();
  globalThis.localStorage = {
    getItem: (k) => (mem.has(k) ? mem.get(k) : null),
    setItem: (k, v) => mem.set(k, String(v)),
    removeItem: (k) => mem.delete(k),
    clear: () => mem.clear(),
  };
}
const app = fs.readFileSync(new URL('../js/app.js', import.meta.url), 'utf8');

const G = E.CONFIG.dailyGoal;
const T0 = new Date(2026, 8, 17, 9, 0, 0).getTime(); // a fixed local morning

// Tick the timer forward in `step` slices, marking the child as active on each
// one unless `idle` — i.e. simulating answering vs. walking away.
function run(timer, ms, { step = 1000, idle = false, from = T0 } = {}) {
  let t = from;
  const end = from + ms;
  while (t < end) {
    t = Math.min(t + step, end);
    if (!idle) timer.touch(t);
    timer.tick(t);
  }
  return t;
}

describe('daily goal: the setting', () => {
  it('defaults to 10 minutes for a new pilot', () => {
    const save = E.newSave('t');
    expect(save.settings.dailyGoalMin).toBe(10);
    expect(E.goalMs(save)).toBe(10 * 60000);
    expect(E.goalProgress(save, T0).goalMinutes).toBe(10);
  });

  it('is configurable, and 0 switches the goal off', () => {
    const save = E.newSave('t');
    save.settings.dailyGoalMin = 20;
    expect(E.goalMs(save)).toBe(20 * 60000);

    save.settings.dailyGoalMin = 0;
    expect(E.goalMs(save)).toBe(0);
    expect(E.goalProgress(save, T0).on).toBe(false);
  });

  it('survives a save that predates the feature', () => {
    const old = E.newSave('t');
    delete old.settings.dailyGoalMin;
    delete old.daily;
    // migrate() runs on load; reach it the way loadSave would.
    const revived = JSON.parse(JSON.stringify(old));
    localStorage.setItem('mathgalaxy.save.v1', JSON.stringify(revived));
    const loaded = E.loadSave();
    expect(loaded.settings.dailyGoalMin).toBe(G.defaultMin);
    expect(loaded.daily.ms).toBe(0);
    localStorage.clear();
  });
});

describe('daily goal: banking time', () => {
  it('counts time while the child is answering', () => {
    const save = E.newSave('t');
    const timer = E.createDailyTimer(save, T0);
    timer.start(T0);
    run(timer, 60000);
    expect(save.daily.ms).toBe(60000);
    expect(E.goalProgress(save, T0).minutes).toBe(1);
  });

  it('banks nothing before it is started, or after it is stopped', () => {
    const save = E.newSave('t');
    const timer = E.createDailyTimer(save, T0);
    run(timer, 30000);                       // never started
    expect(save.daily.ms).toBe(0);

    timer.start(T0);
    const t = run(timer, 10000);
    timer.stop(t);
    run(timer, 30000, { from: t });
    expect(save.daily.ms).toBe(10000);       // only the 10s it was running
  });

  it('pauses after the idle grace, however long the tab is left open', () => {
    const save = E.newSave('t');
    const timer = E.createDailyTimer(save, T0);
    timer.start(T0);
    run(timer, 10 * 60000, { idle: true });  // ten minutes of nobody home
    // A walk-away costs the grace and not one second more.
    expect(save.daily.ms).toBe(G.idleMs);
  });

  it('picks straight back up when the child answers again', () => {
    const save = E.newSave('t');
    const timer = E.createDailyTimer(save, T0);
    timer.start(T0);
    let t = run(timer, 5000);                     // 5s answering
    t = run(timer, 5 * 60000, { idle: true, from: t }); // long walk-away
    run(timer, 5000, { from: t });                // back at the controls
    expect(save.daily.ms).toBe(5000 + G.idleMs + 5000);
  });

  it('ignores a jump bigger than one tick — a sleeping tab is not practice', () => {
    const save = E.newSave('t');
    const timer = E.createDailyTimer(save, T0);
    timer.start(T0);
    timer.touch(T0 + 3600000);                // "active" on the far side of the gap
    expect(timer.tick(T0 + 3600000)).toBe(0); // the whole hour is dropped
    expect(save.daily.ms).toBe(0);
  });

  it('starts a fresh tally when the local date rolls over', () => {
    const save = E.newSave('t');
    const timer = E.createDailyTimer(save, T0);
    timer.start(T0);
    run(timer, 60000);
    expect(save.daily.ms).toBe(60000);

    const tomorrow = new Date(2026, 8, 18, 9, 0, 0).getTime();
    expect(E.goalProgress(save, tomorrow).ms).toBe(0);
    expect(save.daily.date).toBe(E.todayKey(tomorrow));
  });
});

describe('daily goal: when it is due', () => {
  const met = (min = 10) => {
    const save = E.newSave('t');
    save.settings.dailyGoalMin = min;
    E.dailyToday(save, T0).ms = min * 60000;
    return save;
  };

  it('is not due before the goal is reached', () => {
    const save = met();
    save.daily.ms = 10 * 60000 - 1;
    expect(E.goalDue(save, T0)).toBe(false);
  });

  it('is due once the goal is reached', () => {
    expect(E.goalDue(met(), T0)).toBe(true);
    expect(E.goalProgress(met(), T0).pct).toBe(100);
  });

  it('is never due when the goal is switched off, however long the session', () => {
    const save = met(0);
    E.dailyToday(save, T0).ms = 60 * 60000;
    expect(E.goalDue(save, T0)).toBe(false);
  });

  it('comes up once a day — practising on afterwards does not nag again', () => {
    const save = met();
    expect(E.goalDue(save, T0)).toBe(true);
    E.markGoalShown(save, T0);
    expect(E.goalDue(save, T0)).toBe(false);

    save.daily.ms += 5 * 60000;            // kept flying for another five minutes
    expect(E.goalDue(save, T0)).toBe(false);
    expect(E.goalProgress(save, T0).met).toBe(true); // still met, just quiet
  });

  it('comes up again the next day', () => {
    const save = met();
    E.markGoalShown(save, T0);
    const tomorrow = new Date(2026, 8, 18, 9, 0, 0).getTime();
    E.dailyToday(save, tomorrow).ms = 10 * 60000;
    expect(E.goalDue(save, tomorrow)).toBe(true);
  });

  it('falls due immediately if the goal is lowered below what is already flown', () => {
    const save = met(20);
    save.daily.ms = 12 * 60000;
    expect(E.goalDue(save, T0)).toBe(false);
    save.settings.dailyGoalMin = 10;       // parent shortens it mid-day
    expect(E.goalDue(save, T0)).toBe(true);
  });
});

describe('daily goal: it never interrupts a run', () => {
  it('only ever checks for a stopping point in practice', () => {
    // advance() runs between questions in every mode; the goal may only end a
    // PRACTICE session there. A test or fluency run finishes on its own terms.
    const fn = app.slice(app.indexOf('function advance()'), app.indexOf('function showHint()'));
    expect(fn).toContain("if (play.mode === 'practice' && E.goalDue(state.save)) return finishPractice();");
    expect(fn.match(/goalDue/g)).toHaveLength(1);
  });

  it('raises the banner only from a result screen', () => {
    // Every goalDue/banner call site: the practice stopping point above, plus
    // the three result renderers. Nothing mid-question, nothing mid-run.
    expect(app.match(/renderGoalBanner\(\)/g)).toHaveLength(4); // 1 definition + 3 calls
    const banner = app.slice(app.indexOf('function renderGoalBanner()'));
    expect(banner.slice(0, banner.indexOf('\n}'))).toContain('E.markGoalShown(state.save)');
  });

  it('stops the clock at every exit from a session', () => {
    for (const fn of ['function endPlay()', 'function finishTest()', 'function finishPractice()',
                      'function finishFluency()', 'function showVersusResult(', 'function leaveChallenge()']) {
      const body = app.slice(app.indexOf(fn));
      expect(body.slice(0, body.indexOf('\n}')), `${fn} must bank the time`).toContain('stopGoalClock()');
    }
  });
});
