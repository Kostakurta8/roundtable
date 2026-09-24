/**
 * The hosted demo's player, and the recording it plays.
 *
 * The page on GitHub Pages is the app fed from `src/demo/recording.json` instead of a hub, so
 * everything the app believes about time, order and resets has to survive being replayed: a frame
 * delivered early, a timestamp left on the recording's clock, or a second pass whose `seq`s the
 * store has already seen would each show up as a room that is subtly wrong rather than broken.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isEv, type Ev } from '../shared/events';
import type { HelloMsg, ServerMsg } from '../shared/protocol';
import { HOLD_MS, parseRecording, play, seqSpan, sessionsOf, shift, type Recording } from '../src/demo/playback';
import { initialState, reduce, type RtState } from '../src/store';

const S = 's-1';
const ref = { sessionId: S, agentId: 'main' };
const hello = (mtime: number): HelloMsg => ({
  kind: 'hello',
  root: '(staged)',
  sessions: [{ sessionId: S, slug: 'x', mtime, live: true }],
});
const text = (t: string, ts: number, seq: number): Ev => ({ kind: 'agentText', ref, text: t, ts, seq });

/** A recording in the file's own shape, so `parseRecording` is on the path of every test. */
const recording = (frames: [number, ServerMsg | Ev][], span?: number): Recording =>
  parseRecording(JSON.parse(JSON.stringify({ v: 1, ...(span === undefined ? {} : { span }), frames })));

const TINY = (): Recording =>
  recording(
    [
      [0, hello(-50)],
      [0, { kind: 'reset', sessionId: S, reason: 'replay' }],
      [0, text('backlog', -40, 1)],
      [0, { kind: 'ready', sessionId: S, replayed: 1 }],
      [1000, text('one', 1000, 2)],
      [2500, text('two', 2400, 3)],
    ],
    3000,
  );

describe('parseRecording', () => {
  it('refuses anything that is not a version-1 recording', () => {
    expect(() => parseRecording(null)).toThrow(/version-1/);
    expect(() => parseRecording({ v: 2, frames: [] })).toThrow(/version-1/);
    expect(() => parseRecording({ v: 1, frames: {} })).toThrow(/version-1/);
  });

  it('skips a malformed frame instead of failing the whole page', () => {
    const rec = parseRecording({ v: 1, frames: [[0, hello(0)], ['x', {}], [5], [7, null], [9, text('ok', 9, 1)]] });
    expect(rec.frames.map(([at]) => at)).toEqual([0, 9]);
  });

  /**
   * The recorder stamps arrival with the wall clock, which can step backwards. Sorting by `at` would
   * then move a frame ahead of the ones the hub sent before it — a `reset` behind the backlog it was
   * clearing the way for — so the file's order is kept and the clock is not allowed to go back.
   */
  it('keeps arrival order when the recorded clock steps back', () => {
    const rec = recording([
      [100, text('a', 100, 1)],
      [90, text('b', 90, 2)],
      [120, text('c', 120, 3)],
    ]);
    expect(rec.frames.map(([at, m]) => [at, (m as { text: string }).text])).toEqual([
      [100, 'a'],
      [100, 'b'],
      [120, 'c'],
    ]);
  });

  it('runs to the recorded end of the take, but never ends before its last frame', () => {
    expect(recording([[500, text('a', 500, 1)]], 900).span).toBe(900);
    expect(recording([[500, text('a', 500, 1)]], 100).span).toBe(500);
    expect(recording([[500, text('a', 500, 1)]]).span).toBe(500);
  });
});

describe('shift', () => {
  it('puts an event on the viewer’s clock and moves its seq along', () => {
    const ev = text('x', -40, 7);
    const out = shift(ev, 1_000_000, 100) as Ev;
    expect(out).toMatchObject({ kind: 'agentText', ts: 999_960, seq: 107, text: 'x' });
    expect(ev).toMatchObject({ ts: -40, seq: 7 }); // the recording is shared by every pass
  });

  it('moves the roster’s mtimes too, so "4s ago" in the picker is about now', () => {
    const out = shift(hello(-50), 1_000_000, 0) as HelloMsg;
    expect(out.sessions[0].mtime).toBe(999_950);
    expect(out.root).toBe('(staged)');
  });

  it('leaves the frames that carry no time alone', () => {
    const ready = { kind: 'ready', sessionId: S, replayed: 1 } as const;
    expect(shift(ready, 1_000_000, 50)).toBe(ready);
  });

  it('shifts when a workflow agent was queued, not only when the phase ended', () => {
    const wf: Ev = {
      kind: 'workflowPhase',
      sessionId: S,
      workflowId: 'wf_1',
      status: 'completed',
      phases: [{ index: 1, title: 'p', order: 0, agents: [{ agentId: 'a', state: 'done', queuedAt: 10 }] }],
      ts: 20,
      seq: 1,
    };
    const out = shift(wf, 1000, 0) as Extract<Ev, { kind: 'workflowPhase' }>;
    expect(out.ts).toBe(1020);
    expect(out.phases[0].agents[0].queuedAt).toBe(1010);
  });
});

describe('play', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-24T12:00:00Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('delivers each frame at its own offset, and not a moment before', () => {
    const got: object[] = [];
    const start = Date.now();
    const stop = play(TINY(), (m) => got.push(m));

    expect(got.map((m) => (m as { kind: string }).kind)).toEqual(['hello', 'reset', 'agentText', 'ready']);
    vi.advanceTimersByTime(999);
    expect(got).toHaveLength(4);
    vi.advanceTimersByTime(1);
    expect(got).toHaveLength(5);
    expect(got[4]).toMatchObject({ text: 'one', ts: start + 1000, seq: 2 });
    vi.advanceTimersByTime(1500);
    expect(got[5]).toMatchObject({ text: 'two', ts: start + 2400, seq: 3 });
    // The backlog keeps its place in the past: it was written before the hub started.
    expect(got[2]).toMatchObject({ text: 'backlog', ts: start - 40 });
    stop();
  });

  it('delivers everything that fell due at once when the timers were held back', () => {
    const got: object[] = [];
    const start = Date.now();
    const stop = play(TINY(), (m) => got.push(m));
    // A background tab: time passes, the timer does not get to run until much later.
    vi.setSystemTime(start + 2600);
    vi.advanceTimersByTime(1000);
    expect(got.slice(4).map((m) => (m as Ev & { text: string }).text)).toEqual(['one', 'two']);
    // Stamped with when they were due, not when they got out.
    expect((got[5] as Ev).ts).toBe(start + 2400);
    stop();
  });

  it('holds the last moment, then starts over as a rewound transcript: a reset, then fresh seqs', () => {
    const rec = TINY();
    const got: object[] = [];
    const stop = play(rec, (m) => got.push(m), 4000);

    vi.advanceTimersByTime(rec.span + 4000 - 1);
    expect(got).toHaveLength(6); // still holding
    const restart = Date.now() + 1;
    vi.advanceTimersByTime(1);

    const second = got.slice(6);
    expect(second[0]).toEqual({ kind: 'reset', sessionId: S, reason: 'rewound' });
    expect((second[1] as { kind: string }).kind).toBe('hello');
    const firstSeqs = got.slice(0, 6).filter(isEv).map((e) => e.seq);
    const againSeqs = second.filter(isEv).map((e) => e.seq);
    expect(Math.min(...againSeqs)).toBeGreaterThan(Math.max(...firstSeqs));
    // The backlog of the new pass is in the past of the *new* pass.
    expect(second.filter(isEv)[0].ts).toBe(restart - 40);
    stop();
  });

  it('plays faster by one factor for every gap and every stamp, but holds the end in real time', () => {
    const rec = TINY();
    const got: object[] = [];
    const start = Date.now();
    const stop = play(rec, (m) => got.push(m), 4000, 2);

    expect(got).toHaveLength(4);
    vi.advanceTimersByTime(499);
    expect(got).toHaveLength(4);
    vi.advanceTimersByTime(1);
    // Recorded at 1000 ms, delivered at 500, and stamped as having happened then.
    expect(got[4]).toMatchObject({ text: 'one', ts: start + 500 });
    vi.advanceTimersByTime(750);
    expect(got[5]).toMatchObject({ text: 'two', ts: start + 1200 });
    // The backlog's distance into the past shrinks by the same factor, so its order is kept.
    expect(got[2]).toMatchObject({ text: 'backlog', ts: start - 20 });

    // The recording is done at span / 2 = 1500; the hold after it is the full 4 s, not 2.
    vi.advanceTimersByTime(rec.span / 2 + 4000 - 1250 - 1);
    expect(got).toHaveLength(6);
    vi.advanceTimersByTime(1);
    expect(got[6]).toMatchObject({ kind: 'reset', reason: 'rewound' });
    stop();
  });

  it('delivers nothing once stopped, including from inside a delivery', () => {
    const got: object[] = [];
    let stop = (): void => {};
    stop = play(TINY(), (m) => {
      got.push(m);
      // The restart's reset, which arrives from a timer — by then `stop` is the real one.
      if ((m as { reason?: string }).reason === 'rewound') stop();
    });
    vi.advanceTimersByTime(60_000);
    expect(got).toHaveLength(7);
    expect(got[6]).toMatchObject({ kind: 'reset', reason: 'rewound' });
  });

  it('uses the default hold when none is given', () => {
    const rec = TINY();
    const got: object[] = [];
    const stop = play(rec, (m) => got.push(m));
    vi.advanceTimersByTime(rec.span + HOLD_MS - 1);
    expect(got).toHaveLength(6);
    vi.advanceTimersByTime(1);
    expect(got.length).toBeGreaterThan(6);
    stop();
  });

  /**
   * The point of the fresh `seq`s: a store that somehow kept the first pass would ignore every
   * replayed frame if the numbers repeated, and fold the second pass on top of the first if they
   * did not reset. Folded through the real reducer, pass two lands with the reset honoured.
   */
  it('folds the second pass to the same session the first one built', () => {
    const rec = TINY();
    const states: Record<string, RtState> = {};
    const stop = play(rec, (m) => {
      if (isEv(m)) states[S] = reduce(states[S] ?? initialState, m);
      else if ((m as { kind: string }).kind === 'reset') delete states[S];
    });
    vi.advanceTimersByTime(rec.span);
    const first = states[S];
    vi.advanceTimersByTime(HOLD_MS + rec.span);
    const second = states[S];
    expect(second.msgs.map((m) => m.text)).toEqual(first.msgs.map((m) => m.text));
    expect(second.lastSeq).toBeGreaterThan(first.lastSeq);
    stop();
  });
});

describe('the committed recording', () => {
  const raw = readFileSync(join('src', 'demo', 'recording.json'), 'utf8');
  const rec = parseRecording(JSON.parse(raw));
  const evs = rec.frames.map(([, m]) => m).filter(isEv);

  it('is small enough to ship inside the page', () => {
    expect(raw.length).toBeLessThan(200 * 1024);
  });

  /** Both tabs, and the busy room first: the page opens on `sessions[0]` when nothing is pinned. */
  it('opens on both staged sessions, the busy one first', () => {
    const first = rec.frames[0][1] as HelloMsg;
    expect(first.kind).toBe('hello');
    expect(first.sessions.map((s) => s.name)).toEqual(['pathfinder-1', 'pathfinder-api-2']);
    expect(first.sessions.every((s) => s.live)).toBe(true);
    expect(sessionsOf(rec)).toHaveLength(2);
  });

  it('runs long enough for the room to fill, both verdicts to land and people to leave', () => {
    expect(evs.filter((e) => e.kind === 'agentSpawn').length).toBeGreaterThanOrEqual(17);
    const said = evs.flatMap((e) => (e.kind === 'agentText' ? [e.text] : []));
    expect(said.some((t) => t.startsWith('CONFIRMED'))).toBe(true);
    expect(said.some((t) => t.startsWith('REFUTED'))).toBe(true);
    expect(evs.filter((e) => e.kind === 'agentDone').length).toBeGreaterThanOrEqual(2);
  });

  it('keeps the hub’s own seq order', () => {
    const seqs = evs.map((e) => e.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(seqSpan(rec)).toBe(Math.max(...seqs));
  });

  /** Staged under a temp directory, published to strangers: nothing of the machine it ran on. */
  it('carries no path from the machine that recorded it', () => {
    expect(raw).not.toMatch(/roundtable-demo-record|\/tmp\/|\\\\Temp\\\\|\/Users\/|\/home\//i);
    expect((rec.frames[0][1] as HelloMsg).root).toBe('(a staged demo root)');
  });

  it('stores its times relative to the take, for the player to put back on the viewer’s clock', () => {
    for (const e of evs) expect(Math.abs(e.ts)).toBeLessThan(rec.span + 60_000);
  });
});
