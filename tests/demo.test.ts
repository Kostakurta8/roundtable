/**
 * The hosted demo's player, the cut that makes its recording, and the recording itself.
 *
 * The page on GitHub Pages is the app fed from `src/demo/recording.json` instead of a hub, so
 * everything the app believes about time, order and resets has to survive being replayed: a frame
 * delivered early, a timestamp left on the recording's clock, or a second pass whose `seq`s the
 * store has already seen would each show up as a room that is subtly wrong rather than broken.
 *
 * The recorder's cut deals out again what the hub sent for a session written in one go, so it has
 * to put every line back where it was written, keep the hub's derived frames after what they were
 * derived from, and still frame the whole thing as a hub would.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { evSession, isEv, type Ev } from '../shared/events';
import type { HelloMsg, RosterMsg, ServerMsg } from '../shared/protocol';
import { HOLD_MS, paceOf, parseRecording, play, seqSpan, sessionsOf, shift, type Recording } from '../src/demo/playback';
import { compressedClock, cut, type Cut, type CutOptions, type Take } from '../src/demo/timelapse';
import { initialState, MAIN, reduce, roster, type RtState } from '../src/store';

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

  it('reads how a timelapse was cut, and believes both numbers or neither', () => {
    const base = { v: 1, frames: [[0, hello(0)]] };
    expect(parseRecording({ ...base, timelapse: { realMs: 540_000, playMs: 70_000 } }).timelapse).toEqual({ realMs: 540_000, playMs: 70_000 });
    expect(parseRecording({ ...base, timelapse: { realMs: 540_000 } }).timelapse).toBeUndefined();
    expect(parseRecording({ ...base, timelapse: { realMs: '9m', playMs: 70_000 } }).timelapse).toBeUndefined();
    expect(parseRecording({ ...base, timelapse: { realMs: 540_000, playMs: -1 } }).timelapse).toBeUndefined();
    expect(parseRecording(base).timelapse).toBeUndefined();
  });
});

describe('paceOf', () => {
  const lapse = (realMs: number, playMs: number): Recording => ({ span: playMs, frames: [], timelapse: { realMs, playMs } });

  /** The banner is the only thing on the page that can say this is not happening in real time. */
  it('calls a timelapse a timelapse, and says the silences were shortened', () => {
    const { label, title } = paceOf(lapse(566_894, 70_000), 1);
    expect(label).toBe('TIMELAPSE');
    expect(title).toContain('about 9½ minutes long, played in 70 seconds');
    expect(title).toMatch(/silences .* shortened/);
    expect(title).toContain('nothing here happens in real time');
  });

  it('counts a speed-up on top of the cut in what it says the replay lasts', () => {
    expect(paceOf(lapse(600_000, 70_000), 2).title).toContain('about 10 minutes long, played in 35 seconds');
    expect(paceOf(lapse(60_000, 20_000), 1).title).toContain('about 1 minute long');
  });

  it('says how much faster a recording that was not cut plays', () => {
    expect(paceOf({ span: 1000, frames: [] }, 2.5)).toEqual({ label: '2.5×', title: 'played at 2.5× the speed it was recorded' });
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

/** `Array.prototype.findLastIndex`, which the ES2022 lib this project compiles against does not have. */
const lastIndex = <T,>(xs: readonly T[], f: (x: T) => boolean): number => {
  for (let i = xs.length - 1; i >= 0; i--) if (f(xs[i])) return i;
  return -1;
};

describe('compressedClock', () => {
  /**
   * The numbers are chosen so the answer is exact: gaps of one second either side of a ten-minute
   * wait, played in six seconds with a two-second beat, can only come out with the wait as the beat
   * and every other second kept as a second.
   */
  it('clamps a long silence to one beat, then scales the run to the length asked', () => {
    const times = [0, 1000, 2000, 602_000, 603_000, 604_000];
    const clock = compressedClock(times, 6000, 2000);
    expect(times.map((t) => Math.round(clock.at(t)))).toEqual([0, 1000, 2000, 4000, 5000, 6000]);
    expect(clock.capMs).toBeCloseTo(2000, -1);
    expect(clock.realMs).toBe(604_000);
  });

  it('cuts nothing from a run whose longest silence already fits in a beat', () => {
    const clock = compressedClock([0, 10_000, 20_000, 30_000], 3000, 1500);
    expect([0, 10_000, 20_000, 30_000].map(clock.at)).toEqual([0, 1000, 2000, 3000]);
    expect(clock.capMs).toBe(10_000);
  });

  it('is monotonic everywhere, including between moments and past either end', () => {
    const clock = compressedClock([5000, 5500, 90_000, 91_000], 4000, 1000);
    let prev = Number.NEGATIVE_INFINITY;
    for (let t = -60_000; t <= 200_000; t += 250) {
      const at = clock.at(t);
      expect(at).toBeGreaterThanOrEqual(prev);
      prev = at;
    }
  });
});

describe('cut', () => {
  const L = 'lead-1';
  const SIDE = 'side-2';
  /** The transcripts' clock: the morning the staged session pretends to have happened. */
  const T0 = Date.UTC(2026, 8, 17, 9, 12, 0);
  /** The hub's clock: a week later, when it read the whole thing in one go. */
  const HUB = Date.UTC(2026, 8, 24, 12, 0, 0);
  const at = (sessionId: string, agentId: string) => ({ sessionId, agentId });
  type Loose = Ev extends infer E ? (E extends Ev ? Omit<E, 'seq'> : never) : never;
  const numbered = (evs: Loose[], from: number): Ev[] => evs.map((e, i) => ({ ...e, seq: from + i }) as Ev);

  /**
   * A finished fan-out in the order the hub replays one: the main transcript whole, then the child's
   * file whole. Two stamps are the hub's own — `sessionSeen`, and the sidecar's `agentSeen` — and the
   * derived `agentDone` sits where the hub derives it, beside the sidecar, stamped with the parent's
   * result. Every one of those is a way for the cut to get the order wrong.
   */
  const leadEvs = (): Ev[] =>
    numbered(
      [
        { kind: 'sessionSeen', sessionId: L, cwd: 'C:\\work\\x', live: true, ts: HUB },
        { kind: 'userMessage', ref: at(L, MAIN), text: 'do the thing', source: 'human', ts: T0 },
        { kind: 'toolStart', ref: at(L, MAIN), tool: 'Task', toolUseId: 'tu-1', target: 'scout it', ts: T0 + 1000 },
        { kind: 'agentSpawn', ref: at(L, MAIN), childAgentId: 'pending', prompt: 'scout it', toolUseId: 'tu-1', background: false, ts: T0 + 1000 },
        { kind: 'toolResult', ref: at(L, MAIN), toolUseId: 'tu-1', ok: true, ts: T0 + 30_000 },
        { kind: 'agentText', ref: at(L, MAIN), text: 'Done.', ts: T0 + 32_000 },
        { kind: 'agentSeen', ref: at(L, 'kid'), parentToolUseId: 'tu-1', label: 'scout it', ts: HUB },
        { kind: 'agentDone', ref: at(L, 'kid'), ok: true, ts: T0 + 30_000 },
        { kind: 'userMessage', ref: at(L, 'kid'), text: 'scout it', ts: T0 + 2000 },
        { kind: 'toolStart', ref: at(L, 'kid'), tool: 'Read', toolUseId: 'tu-2', target: 'a.ts', ts: T0 + 5000 },
        { kind: 'toolResult', ref: at(L, 'kid'), toolUseId: 'tu-2', ok: true, ts: T0 + 7000 },
        { kind: 'agentText', ref: at(L, 'kid'), text: 'Found it.', ts: T0 + 27_000 },
      ],
      1,
    );
  /** A second session: asked a minute before the lead was, then says one thing in the middle of the lead's run. */
  const sideEvs = (): Ev[] =>
    numbered(
      [
        { kind: 'sessionSeen', sessionId: SIDE, cwd: 'C:\\work\\y', live: true, ts: HUB },
        { kind: 'userMessage', ref: at(SIDE, MAIN), text: 'and this', source: 'human', ts: T0 - 60_000 },
        { kind: 'agentText', ref: at(SIDE, MAIN), text: 'On it.', ts: T0 + 17_000 },
      ],
      100,
    );
  const row = (sessionId: string, name: string, mtime: number) => ({ sessionId, slug: sessionId, mtime, live: true, name });
  const take = (withSide = true): Take => ({
    // The hub's own order, by real file times: the side session was copied in last, so it looks newest.
    hello: {
      kind: 'hello',
      root: '/tmp/somewhere-private',
      sessions: withSide ? [row(SIDE, 'side', HUB + 5), row(L, 'lead', HUB)] : [row(L, 'lead', HUB)],
    },
    sessions: withSide ? [{ sessionId: L, evs: leadEvs() }, { sessionId: SIDE, evs: sideEvs() }] : [{ sessionId: L, evs: leadEvs() }],
  });
  /**
   * The lead's moments are 0, 1, 2, 5, 7, 27, 30 and 32 s, so its gaps sum to 32 s with one of 20 s.
   * Played in 16 s with a 4 s beat, the cap can only be 4 s and the scale exactly 1: every moment
   * lands on a round number, which is what lets these tests say where things go.
   */
  const OPTS: CutOptions = { lead: L, playMs: 16_000, beatMs: 4000, tailMs: 3000, rosterMs: 4000, root: '(staged)' };
  const evsOf = (c: Cut): [number, Ev][] => c.frames.flatMap(([t, m]) => (isEv(m) ? [[t, m] as [number, Ev]] : []));
  const label = (e: Ev): string => `${'ref' in e ? e.ref.agentId : 'session'} ${e.kind}`;

  it('frames the opening as the hub attaches: hello, then reset, sessionSeen, backlog and ready per session, lead first', () => {
    const c = cut(take(), OPTS);
    const opening = c.frames.filter(([t]) => t === 0).map(([, m]) => m);
    const shape = opening.map((m) => (isEv(m) ? `${evSession(m) === L ? 'L' : 'S'} ${label(m)}` : `${m.kind}${'sessionId' in m ? ` ${m.sessionId === L ? 'L' : 'S'}` : ''}`));
    expect(shape).toEqual([
      'hello',
      'reset L',
      'L session sessionSeen',
      'L main userMessage',
      'ready L',
      'reset S',
      'S session sessionSeen',
      'S main userMessage',
      'ready S',
    ]);
    const hi = opening[0] as HelloMsg;
    expect(hi.root).toBe('(staged)');
    // Dated by the cut, not by the recording machine's clock — and the busy room is the newest.
    expect(hi.sessions.map((r) => [r.sessionId, r.mtime])).toEqual([
      [L, 0],
      [SIDE, -4000],
    ]);
    expect(opening.filter((m) => !isEv(m) && m.kind === 'ready')).toEqual([
      { kind: 'ready', sessionId: L, replayed: 2 },
      { kind: 'ready', sessionId: SIDE, replayed: 2 },
    ]);
    // What was on disk before the take is in the past of the take; the attach itself is at zero.
    for (const m of opening.filter(isEv)) expect(m.ts).toBeLessThanOrEqual(0);
    expect(opening.filter(isEv).filter((m) => m.kind === 'sessionSeen').map((m) => m.ts)).toEqual([0, 0]);
  });

  it('is monotonic: arrival never goes back, seq always rises, and every live event is stamped with when it plays', () => {
    const c = cut(take(), OPTS);
    let t = 0;
    let seq = 0;
    for (const [arrive, m] of c.frames) {
      expect(arrive).toBeGreaterThanOrEqual(t);
      t = arrive;
      if (!isEv(m)) continue;
      expect(m.seq).toBeGreaterThan(seq);
      seq = m.seq;
      if (arrive > 0) expect(m.ts).toBe(arrive);
    }
  });

  /**
   * The hub sent the parent's whole transcript before the child's first line, so in arrival order
   * the orchestrator said "Done." before anybody had started. Written order is the one to keep.
   */
  it('puts every line back in the order it was written, across files', () => {
    const lead = evsOf(cut(take(false), OPTS)).filter(([, e]) => e.kind !== 'sessionSeen');
    expect(lead.map(([t, e]) => `${t} ${label(e)}`)).toEqual([
      '0 main userMessage',
      '1000 main toolStart',
      '1000 main agentSpawn',
      '2000 kid agentSeen',
      '2000 kid userMessage',
      '5000 kid toolStart',
      '7000 kid toolResult',
      '11000 kid agentText',
      '14000 main toolResult',
      '14000 kid agentDone',
      '16000 main agentText',
    ]);
  });

  it('lands a derived agentDone after the last thing its agent did', () => {
    const evs = evsOf(cut(take(), OPTS)).map(([, e]) => e);
    for (const [i, e] of evs.entries()) {
      if (e.kind !== 'agentDone') continue;
      const last = lastIndex(evs, (x) => x.kind !== 'agentDone' && 'ref' in x && x.ref.agentId === e.ref.agentId && x.ref.sessionId === e.ref.sessionId);
      expect(i).toBeGreaterThan(last);
    }
  });

  it('carries a second session on the lead’s clock without stretching it', () => {
    const alone = cut(take(false), OPTS);
    const both = cut(take(), OPTS);
    const leadAts = (c: Cut): number[] => evsOf(c).flatMap(([t, e]) => (evSession(e) === L ? [t] : []));
    expect(leadAts(both)).toEqual(leadAts(alone));
    expect(both.playMs).toBe(OPTS.playMs);
    // Halfway between the lead's moments at 7 s and 27 s, which play at 7 s and 11 s.
    const said = evsOf(both).find(([, e]) => e.kind === 'agentText' && evSession(e) === SIDE);
    expect(said?.[0]).toBe(9000);
  });

  it('sends a roster on the hub’s tick only when a main transcript moved, newest first', () => {
    const c = cut(take(), OPTS);
    const rosters = c.frames.flatMap(([t, m]) => (!isEv(m) && m.kind === 'roster' ? [[t, (m as RosterMsg).sessions] as const] : []));
    expect(rosters.map(([t, rows]) => [t, rows.map((r) => `${r.name}@${r.mtime}`)])).toEqual([
      [4000, ['lead@1000', 'side@-4000']],
      // The side session spoke at 9 s while the lead was quiet, so for one tick it is the newer one.
      [12000, ['side@9000', 'lead@1000']],
      [16000, ['lead@16000', 'side@9000']],
    ]);
    expect(c.span).toBe(16_000 + OPTS.tailMs);
  });

  it('gives a tie on the millisecond to the lead', () => {
    const t = take();
    const side = [...t.sessions[1].evs];
    // Written on the lead's own moment at 30 s, which plays at 14 s.
    side[2] = { ...side[2], ts: T0 + 30_000 };
    const c = cut({ ...t, sessions: [t.sessions[0], { sessionId: SIDE, evs: side }] }, OPTS);
    const at16 = c.frames.find(([when, m]) => when === 16_000 && !isEv(m) && m.kind === 'roster');
    expect((at16?.[1] as RosterMsg).sessions[0].sessionId).toBe(L);
  });

  describe('played', () => {
    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-09-24T12:00:00Z'));
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    /** Through the real reducer, honouring resets as the stream does: pass two rebuilds pass one. */
    it('loops cleanly: the second pass rebuilds each session the first one built', () => {
      const c = cut(take(), OPTS);
      const rec = parseRecording(JSON.parse(JSON.stringify({ v: 1, span: c.span, frames: c.frames })));
      const states: Record<string, RtState> = {};
      const stop = play(rec, (m) => {
        if (isEv(m)) states[evSession(m)] = reduce(states[evSession(m)] ?? initialState, m);
        else if ((m as { kind: string }).kind === 'reset') delete states[(m as { sessionId: string }).sessionId];
      });
      vi.advanceTimersByTime(rec.span);
      const first = { ...states };
      expect(first[L].agents.kid.phase).toBe('done');
      vi.advanceTimersByTime(HOLD_MS + 1);
      // A moment into pass two: rebuilt from the backlog, not stacked on the first pass.
      expect(Object.keys(states[L].agents)).toEqual([MAIN]);
      vi.advanceTimersByTime(rec.span);
      for (const id of [L, SIDE]) {
        expect(states[id].msgs.map((m) => m.text)).toEqual(first[id].msgs.map((m) => m.text));
        expect(roster(states[id]).map((a) => [a.id, a.phase])).toEqual(roster(first[id]).map((a) => [a.id, a.phase]));
        expect(states[id].lastSeq).toBeGreaterThan(first[id].lastSeq);
      }
      stop();
    });
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
