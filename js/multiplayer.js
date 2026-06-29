// multiplayer.js — serverless head-to-head "Challenge" mode (N players).
//
// WebRTC needs a brief *signaling* handshake to connect peers, and GitHub Pages
// can't host a signaling server. We use Trystero (lazy-loaded from a CDN), which
// rides free PUBLIC infrastructure (Nostr relays) for signaling ONLY — once peers
// connect, every byte of gameplay flows directly peer-to-peer over a WebRTC data
// channel. Nothing we run, no accounts. Solo/offline play never touches this file.
//
// Topology: a Trystero room is a full MESH — everyone who joins the same code
// auto-discovers each other. One peer is the HOST/referee (whoever used "Create");
// it owns all match state and broadcasts authoritative snapshots that every client
// renders. Guests only send inputs. This scales to N with no per-pair coordination
// and makes scoring race-proof. No hard player cap — large meshes just get flakier.
//
// Fairness: we never sync clocks (NTP/ping-pong drift and add latency error).
// Each device measures a local DURATION — from when the question paints on *its*
// screen to when that player answers (performance.now(), a monotonic clock). The
// host compares those reaction times; the smallest correct one wins the point.

import { factKey } from './levels.js';

// Trystero's Nostr strategy: signaling over public Nostr relays. Pinned version.
const TRYSTERO_URL = 'https://esm.sh/trystero@0.21.4/nostr';
const APP_ID = 'math-galaxy-challenge-v1'; // namespaces room codes to our app only
const RTC_CONFIG = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };

// Match tuning.
export const DEFAULT_COUNT = 10;  // questions per match
const GRACE_MS = 350;             // window to catch a near-simultaneous correct answer
const REVEAL_MS = 1600;           // how long the answer is shown before advancing
export const QUESTION_MS = 15000; // per-question time limit (also drives the countdown bar)
const COUNTDOWN_MS = 3200;        // 3·2·1 before the first question

// Room codes kids can read aloud: 4 unambiguous uppercase letters (no I/O/0/1).
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
export function genCode() {
  let s = '';
  for (let i = 0; i < 4; i++) s += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
  return s;
}
export function normalizeCode(raw) {
  return String(raw || '').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 8);
}

// --- deterministic PRNG so every peer derives the IDENTICAL question set from a seed ---
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Build the shared question list from {tables, count, seed}. Runs identically on
// every device (same seed → same questions), so we ship only the seed, not a list.
export function buildQuestions(tables, count, seed) {
  const tbls = (tables && tables.length) ? tables : [2, 3, 4, 5];
  const rng = mulberry32(seed >>> 0);
  const qs = [];
  let lastKey = '';
  let guard = 0;
  while (qs.length < count) {
    const t = tbls[Math.floor(rng() * tbls.length)];
    const o = Math.floor(rng() * 13); // 0..12
    const key = factKey(t, o);
    if (key === lastKey && guard < 20) { guard++; continue; } // avoid back-to-back repeats
    guard = 0; lastKey = key;
    const flip = rng() < 0.5;
    const a = flip ? o : t;
    const b = flip ? t : o;
    qs.push({ a, b, answer: a * b });
  }
  return qs;
}

// ---------------------------------------------------------------------------
// Session: wraps the Trystero room, roster, the message protocol, and (on the
// host) the authoritative match loop. app.js drives it via callbacks.
// ---------------------------------------------------------------------------
class Session {
  constructor(code, isHost, { name = 'Player', callbacks = {} } = {}) {
    this.code = code;
    this.isHost = isHost;
    this.name = name || 'Player';
    this.cb = callbacks;            // { onRoster, onState, onError, onConnected }
    this.selfId = null;
    this.hostId = isHost ? null : null;
    this.room = null;
    this.questions = [];            // shared, seed-derived
    this.lastSnapshot = null;       // most recent state (for currentQuestion etc.)
    this.roster = new Map();        // peerId -> { name, isHost }
    this._timers = [];
    this._match = null;             // host-only authoritative state
    this._left = false;
  }

  // --- lifecycle ---
  async _connect() {
    let trystero;
    try {
      trystero = await import(/* @vite-ignore */ TRYSTERO_URL);
    } catch (e) {
      throw new Error('offline'); // couldn't fetch the matchmaking library
    }
    const { joinRoom, selfId } = trystero;
    this.selfId = selfId;
    if (this.isHost) this.hostId = selfId;
    this.roster.set(selfId, { name: this.name, isHost: this.isHost });

    this.room = joinRoom({ appId: APP_ID, rtcConfig: RTC_CONFIG }, this.code);

    // Action channels (Trystero caps names at 12 bytes).
    [this._sendHi, this._onHi] = this.room.makeAction('hi');
    [this._sendIn, this._onIn] = this.room.makeAction('in');
    [this._sendSt, this._onSt] = this.room.makeAction('st');
    [this._sendGo, this._onGo] = this.room.makeAction('go');
    [this._sendRm, this._onRm] = this.room.makeAction('rm');

    this._onHi((data, peer) => this._recvHi(data, peer));
    this._onGo((data, peer) => this._recvGo(data, peer));
    this._onSt((data, peer) => this._recvSt(data, peer));
    this._onIn((data, peer) => { if (this.isHost) this._handleInput(peer, data); });
    this._onRm(() => { if (this.isHost) this.rematch(); }); // any player can ask for a rematch

    this.room.onPeerJoin((peer) => this._peerJoined(peer));
    this.room.onPeerLeave((peer) => this._peerLeft(peer));

    this._emitRoster();
    if (this.cb.onConnected) this.cb.onConnected();
    return this;
  }

  _peerJoined(peer) {
    // Greet the newcomer directly so they learn our name/role; add a placeholder
    // until their own 'hi' arrives with a name.
    this._sendHi({ name: this.name, host: this.isHost }, peer);
    if (!this.roster.has(peer)) this.roster.set(peer, { name: '…', isHost: false });
    this._emitRoster();
  }

  _peerLeft(peer) {
    this.roster.delete(peer);
    this._emitRoster();
    if (!this.isHost && peer === this.hostId) {
      // No referee left — bail gracefully.
      this._fail('The host left the game.');
      return;
    }
    if (this.isHost && this._match) this._dropPlayer(peer);
  }

  _recvHi(data, peer) {
    const wasNew = !this.roster.has(peer) || this.roster.get(peer).name === '…';
    this.roster.set(peer, { name: (data && data.name) || 'Player', isHost: !!(data && data.host) });
    if (data && data.host) this.hostId = peer;
    // Make sure a brand-new peer also learns about us.
    if (wasNew) this._sendHi({ name: this.name, host: this.isHost }, peer);
    this._emitRoster();
  }

  _emitRoster() {
    if (!this.cb.onRoster) return;
    const list = [...this.roster.entries()].map(([id, v]) => ({
      id, name: v.name, isHost: v.isHost, isSelf: id === this.selfId,
    }));
    this.cb.onRoster(list);
  }

  players() {
    return [...this.roster.entries()].map(([id, v]) => ({
      id, name: v.name, isHost: v.isHost, isSelf: id === this.selfId,
    }));
  }

  nameOf(id) {
    const r = this.roster.get(id);
    return r ? r.name : 'Player';
  }

  currentQuestion() {
    const i = this.lastSnapshot ? this.lastSnapshot.qIndex : -1;
    return (i >= 0 && this.questions[i]) ? this.questions[i] : null;
  }

  // --- host: start / rematch ---
  start(tables, count = DEFAULT_COUNT) {
    if (!this.isHost) return;
    const others = [...this.roster.keys()].filter((id) => id !== this.selfId);
    if (!others.length) { this._fail('Need at least one more player to start.'); return; }
    const seed = (Math.floor(Math.random() * 0xffffffff)) >>> 0;
    this._beginMatch(tables, count, seed);
  }

  // Any player can ask for a rematch; only the host actually restarts.
  requestRematch() {
    if (this.isHost) this.rematch();
    else if (this.hostId) this._sendRm({}, this.hostId);
  }

  rematch() {
    if (!this.isHost || !this._match) return;
    if (this._rematchLock) return;            // debounce duplicate requests from N guests
    this._rematchLock = true;
    setTimeout(() => { this._rematchLock = false; }, 1500);
    const { tables, count } = this._match;
    const seed = (Math.floor(Math.random() * 0xffffffff)) >>> 0;
    this._beginMatch(tables, count, seed);
  }

  _beginMatch(tables, count, seed) {
    this._clearTimers();
    this.questions = buildQuestions(tables, count, seed);
    // Lock the roster for this match: everyone currently present is a player.
    const scores = new Map();
    for (const id of this.roster.keys()) scores.set(id, 0);
    this._match = {
      tables, count, seed, qIndex: -1, scores,
      answered: new Set(), correct: [], locked: new Set(),
      graceTimer: null, qTimer: null, lastResult: null,
    };
    // Tell guests to generate the same questions and run the countdown.
    this._sendGo({ tables, count, seed, host: this.selfId });
    this._emit({ phase: 'countdown', qIndex: -1, count });
    this._timers.push(setTimeout(() => this._startQuestion(0), COUNTDOWN_MS));
  }

  _startQuestion(idx) {
    const m = this._match;
    if (!m) return;
    if (m.qTimer) clearTimeout(m.qTimer);
    if (m.graceTimer) clearTimeout(m.graceTimer);
    m.qIndex = idx;
    m.answered = new Set();
    m.correct = [];
    m.locked = new Set();
    m.graceTimer = null;
    m.lastResult = null;
    m.qTimer = setTimeout(() => this._resolveQuestion(), QUESTION_MS);
    this._emit({ phase: 'question', qIndex: idx, count: m.count });
  }

  // A player's answer attempt reaches the host here (its own answers too).
  _handleInput(peerId, data) {
    const m = this._match;
    if (!m) return;
    if (!data || data.qIndex !== m.qIndex) return;       // stale / wrong question
    if (!m.scores.has(peerId)) return;                   // not a player this match
    if (m.answered.has(peerId)) return;                  // one attempt each
    m.answered.add(peerId);

    const correct = Number(data.value) === this.questions[m.qIndex].answer;
    if (correct) {
      m.correct.push({ peerId, reactionMs: Number(data.reactionMs) || Infinity });
      if (!m.graceTimer) m.graceTimer = setTimeout(() => this._resolveQuestion(), GRACE_MS);
    } else {
      m.locked.add(peerId);
    }

    const activeIds = [...m.scores.keys()];
    if (activeIds.every((id) => m.answered.has(id))) this._resolveQuestion();
    else this._emit({ phase: 'question', qIndex: m.qIndex, count: m.count }); // live lock/answer dots
  }

  _resolveQuestion() {
    const m = this._match;
    if (!m || m.qIndex < 0) return;
    if (m.qTimer) { clearTimeout(m.qTimer); m.qTimer = null; }
    if (m.graceTimer) { clearTimeout(m.graceTimer); m.graceTimer = null; }

    let winnerId = null;
    if (m.correct.length) {
      m.correct.sort((a, b) => a.reactionMs - b.reactionMs); // fastest reaction wins
      winnerId = m.correct[0].peerId;
      m.scores.set(winnerId, (m.scores.get(winnerId) || 0) + 1);
    }
    m.lastResult = { winnerId, answer: this.questions[m.qIndex].answer, qIndex: m.qIndex };
    this._emit({ phase: 'reveal', qIndex: m.qIndex, count: m.count });

    this._timers.push(setTimeout(() => {
      const next = m.qIndex + 1;
      if (next >= m.count) this._endMatch();
      else this._startQuestion(next);
    }, REVEAL_MS));
  }

  _endMatch() {
    const m = this._match;
    if (!m) return;
    m.qIndex = -1;
    this._emit({ phase: 'ended', qIndex: -1, count: m.count });
  }

  _dropPlayer(peerId) {
    const m = this._match;
    if (!m || !m.scores.has(peerId)) return;
    m.scores.delete(peerId);
    m.answered.delete(peerId);
    m.locked.delete(peerId);
    m.correct = m.correct.filter((c) => c.peerId !== peerId);
    // Their leaving might be the last outstanding answer for the question.
    if (m.qIndex >= 0) {
      const activeIds = [...m.scores.keys()];
      if (activeIds.length && activeIds.every((id) => m.answered.has(id))) this._resolveQuestion();
      else this._emit({ phase: 'question', qIndex: m.qIndex, count: m.count });
    }
  }

  // Build a full snapshot from host match state, broadcast it, and render locally.
  _emit(partial) {
    const m = this._match;
    const players = [...m.scores.entries()]
      .map(([id, score]) => ({ id, name: this.nameOf(id), score }))
      .sort((a, b) => b.score - a.score);
    const snap = {
      ...partial,
      players,
      answered: m.qIndex >= 0 ? [...m.answered] : [],
      locked: m.qIndex >= 0 ? [...m.locked] : [],
      lastResult: m.lastResult,
      host: this.selfId,
    };
    this._sendSt(snap);          // to every guest
    this._applySnapshot(snap);   // to ourselves (host is a player too)
  }

  // --- guest: receive host messages ---
  _recvGo(data, peer) {
    if (this.isHost) return;
    this.hostId = (data && data.host) || peer;
    this.questions = buildQuestions(data.tables, data.count, data.seed);
    this.cb.onState && this.cb.onState({ phase: 'countdown', qIndex: -1, count: data.count, players: [], answered: [], locked: [], lastResult: null });
  }

  _recvSt(data, peer) {
    if (this.isHost) return;
    if (this.hostId && peer !== this.hostId) return; // ignore non-host snapshots
    this._applySnapshot(data);
  }

  _applySnapshot(snap) {
    this.lastSnapshot = snap;
    this.cb.onState && this.cb.onState(snap);
  }

  // --- both: submit a local answer attempt ---
  // value: the integer the player entered/said; reactionMs: ms from question paint
  // to this commit, measured on THIS device's monotonic clock.
  submitAnswer(value, reactionMs) {
    const qIndex = this.lastSnapshot ? this.lastSnapshot.qIndex : -1;
    if (qIndex < 0) return;
    const payload = { qIndex, value: Number(value), reactionMs: Math.max(0, Math.round(reactionMs)) };
    if (this.isHost) this._handleInput(this.selfId, payload);
    else if (this.hostId) this._sendIn(payload, this.hostId);
  }

  _clearTimers() {
    for (const t of this._timers) clearTimeout(t);
    this._timers = [];
    if (this._match) {
      if (this._match.qTimer) clearTimeout(this._match.qTimer);
      if (this._match.graceTimer) clearTimeout(this._match.graceTimer);
    }
  }

  _fail(msg) {
    this._clearTimers();
    if (this.cb.onError) this.cb.onError(msg);
  }

  leave() {
    if (this._left) return;
    this._left = true;
    this._clearTimers();
    try { this.room && this.room.leave(); } catch (_) {}
  }
}

// --- public factory: both paths join the same Trystero room; role is local ---
export async function createRoom(code, opts) {
  const s = new Session(normalizeCode(code), true, opts);
  return s._connect();
}
export async function joinRoom(code, opts) {
  const s = new Session(normalizeCode(code), false, opts);
  return s._connect();
}
