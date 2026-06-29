// Regression tests for the host-authoritative match loop in js/multiplayer.js.
//
// These drive the host `Session` directly (no WebRTC). We stub the Trystero
// send-actions and the local roster, then run the match under fake timers so we
// can observe the exact sequence of phase snapshots the host broadcasts.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  Session,
  COUNTDOWN_MS,
  QUESTION_MS,
  GRACE_MS,
  REVEAL_MS,
} from '../js/multiplayer.js';

// Build a host Session wired up enough to run the match loop offline.
function makeHost(onState) {
  const session = new Session('TEST', true, { name: 'Host', callbacks: { onState } });
  session.selfId = 'host';
  session.roster = new Map([
    ['host', { name: 'Host', isHost: true }],
    ['guest', { name: 'Guest', isHost: false }],
  ]);
  // Trystero send-actions are normally wired in _connect(); stub them out.
  session._sendGo = () => {};
  session._sendSt = () => {};
  return session;
}

describe('multiplayer host match loop', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('reveals (and scores) every question even when a late answer lands during the reveal', () => {
    const states = [];
    const session = makeHost((snap) => states.push({ ...snap }));

    const COUNT = 3;
    session._beginMatch([2], COUNT, 12345);

    // Run the 3-2-1 countdown out to the first question.
    vi.advanceTimersByTime(COUNTDOWN_MS);

    // Q0: the host answers correctly. This opens the grace window.
    const q0 = session.questions[0];
    session._handleInput('host', { qIndex: 0, value: q0.answer, reactionMs: 5 });

    // Grace window elapses -> Q0 resolves and we enter the reveal phase.
    vi.advanceTimersByTime(GRACE_MS);

    // A late (but still correct) answer from the guest arrives DURING the reveal
    // window — the original symptom. The host must ignore it, not re-resolve.
    session._handleInput('guest', { qIndex: 0, value: q0.answer, reactionMs: 50 });

    // Play out the remainder of the match (reveals + unanswered question timeouts).
    vi.advanceTimersByTime((REVEAL_MS + QUESTION_MS) * COUNT);

    // Every question index must reach a 'reveal' phase exactly once. With the bug,
    // a second advance timer is scheduled and Q1 is skipped (painted, then instantly
    // replaced by Q2) — so index 1 never reveals.
    const revealedIndexes = states
      .filter((s) => s.phase === 'reveal')
      .map((s) => s.qIndex);

    for (let i = 0; i < COUNT; i++) {
      expect(revealedIndexes.filter((x) => x === i)).toHaveLength(1);
    }

    // And every question index must have been presented to players.
    const questionIndexes = new Set(
      states.filter((s) => s.phase === 'question').map((s) => s.qIndex)
    );
    for (let i = 0; i < COUNT; i++) {
      expect(questionIndexes.has(i)).toBe(true);
    }

    // The point for Q0 is awarded once, not twice (the duplicate resolve also
    // double-counted the score before the fix).
    const ended = states.filter((s) => s.phase === 'reveal' || s.phase === 'ended').pop();
    const total = ended.players.reduce((sum, p) => sum + p.score, 0);
    expect(total).toBe(1);
  });
});
