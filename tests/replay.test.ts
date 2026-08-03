import { describe, expect, it } from 'vitest';
import { Engine, IDLE_COFFEE_MS, type ActorState } from '../src/office/engine';
import type { Cmd } from '../src/office/mapping';
import { frameAt, MAX_GAP_MS, Recorder, Replay, REPLAY_CAP, type Entry } from '../src/office/replay';

const seen = (agentId: string): Cmd => ({ op: 'ensureActor', agentId });
const says = (agentId: string, text: string): Cmd => ({ op: 'deliver', agentId, to: 'main', text });
const thinks = (agentId: string, text: string): Cmd => ({ op: 'think', agentId, text });

const stateOf = (states: readonly ActorState[], id: string): ActorState => {
  const found = states.find((s) => s.id === id);
  if (!found) throw new Error(`no actor '${id}' in ${JSON.stringify(states.map((s) => s.id))}`);
  return found;
};

/**
 * The room at the resolution anyone can see it.
 *
 * Advancing a walk segment in twenty small steps and advancing it in one large one differ in the
 * last bits of a float — that is what integrating a path against a time step means, and it is
 * documented at the top of `replay.ts`. A scene pixel is 0.3 canvas pixels and the renderer rounds
 * to whole canvas pixels before it draws, so rounding to a thousandth of a scene pixel here is
 * still four orders of magnitude below anything visible while catching any drift that is real.
 */
const asDrawn = (states: readonly ActorState[]): unknown[] =>
  states.map((s) => ({ ...s, x: Math.round(s.x * 1000) / 1000, y: Math.round(s.y * 1000) / 1000 }));

/** A short session: two agents arrive, one thinks, one walks a note over, one finishes. */
const SESSION: Entry[] = [
  { ts: 1000, cmd: seen('main') },
  { ts: 1000, cmd: seen('alpha') },
  { ts: 3000, cmd: thinks('alpha', 'where is the leak') },
  { ts: 6000, cmd: says('alpha', 'found it') },
  { ts: 20_000, cmd: seen('beta') },
  { ts: 24_000, cmd: { op: 'done', agentId: 'alpha', ok: true } },
];

describe('Recorder', () => {
  it('keeps what it is given, in arrival order', () => {
    const r = new Recorder();
    r.record(2, seen('a'));
    r.record(1, seen('b')); // out of order on purpose: arrival order is the causal order
    expect(r.entries().map((e) => e.cmd)).toEqual([seen('a'), seen('b')]);
    expect(r.truncated).toBe(0);
  });

  it('reports the span it can actually rebuild', () => {
    const r = new Recorder();
    expect(r.span).toBeUndefined();
    r.record(500, seen('a'));
    r.record(90, seen('b'));
    r.record(700, seen('c'));
    expect(r.span).toEqual({ from: 90, to: 700 });
  });

  it('caps the log and counts what fell off, rather than growing without bound', () => {
    const r = new Recorder();
    for (let i = 0; i < REPLAY_CAP + 25; i++) r.record(i, seen(`a${i}`));
    expect(r.entries()).toHaveLength(REPLAY_CAP);
    expect(r.truncated).toBe(25);
    // What is left is the *newest* window, so the scrubber's right-hand end is always the present.
    expect(r.entries()[r.entries().length - 1].cmd).toEqual(seen(`a${REPLAY_CAP + 24}`));
  });

  it('does not let a non-finite timestamp poison the log', () => {
    const r = new Recorder();
    r.record(NaN, seen('a'));
    expect(r.entries()[0].ts).toBe(0);
  });
});

describe('Replay — winding to a moment', () => {
  it('reproduces exactly what a live engine fed the same gaps would have shown', () => {
    // The claim the whole feature rests on: replay is not an approximation of the live room, it is
    // the same simulation driven by the same numbers.
    const live = new Engine();
    live.apply(seen('main'));
    live.apply(seen('alpha'));
    live.tick(2000);
    live.apply(thinks('alpha', 'where is the leak'));
    live.tick(3000);
    live.apply(says('alpha', 'found it'));
    const expected = live.tick(2000);

    const r = new Replay(SESSION);
    expect(r.seek(8000)).toEqual(expected);
  });

  it('lands on the same room whether it got there forwards or backwards', () => {
    const forwards = new Replay(SESSION).seek(8000);

    const back = new Replay(SESSION);
    back.seek(24_000);
    expect(back.seek(8000)).toEqual(forwards);
  });

  it('lands on the same room whether it got there in one step or many', () => {
    const oneStep = new Replay(SESSION).seek(9000);

    const crawl = new Replay(SESSION);
    for (let t = 1000; t <= 9000; t += 250) crawl.seek(t);
    expect(asDrawn(crawl.seek(9000))).toEqual(asDrawn(oneStep));
  });

  it('shows a bubble as old as it really was at that moment, not as new', () => {
    const r = new Replay(SESSION);
    // The thought lands at 3000 and the engine keeps one for five seconds.
    expect(stateOf(r.seek(4000), 'alpha').think).toBe('where is the leak');
    expect(stateOf(r.seek(7999), 'alpha').think).toBe('where is the leak');
    expect(stateOf(r.seek(8001), 'alpha').think).toBeUndefined();
  });

  it('has not seen an agent who had not arrived yet', () => {
    const r = new Replay(SESSION);
    expect(r.seek(5000).map((s) => s.id).sort()).toEqual(['alpha', 'main']);
    expect(r.seek(21_000).map((s) => s.id).sort()).toEqual(['alpha', 'beta', 'main']);
  });

  it('has sent a finished agent home by the time the scrubber passes it', () => {
    const r = new Replay(SESSION);
    expect(r.seek(23_000).find((s) => s.id === 'alpha')?.retired).toBeUndefined();
    // Its `done` lands at 24s; it holds a beat, gets up and walks out. A scrub past that point
    // rebuilds a room it is no longer in, which is the same room the live view showed.
    expect(r.seek(120_000).find((s) => s.id === 'alpha')).toBeUndefined();
  });

  it('reports its own honest bounds', () => {
    const r = new Replay(SESSION);
    expect(r.from).toBe(1000);
    expect(r.to).toBe(24_000);
    r.seek(9000);
    expect(r.position).toBe(9000);
  });

  it('draws an empty room from an empty log rather than throwing', () => {
    const r = new Replay([]);
    expect(r.seek(5000)).toEqual([]);
    expect(r.from).toBe(0);
    expect(r.to).toBe(0);
  });

  it('shrugs off a non-finite seek instead of being poisoned by it', () => {
    const r = new Replay(SESSION);
    const before = r.seek(8000);
    expect(r.seek(NaN)).toEqual(r.seek(8000));
    expect(before).toEqual(r.seek(8000));
    expect(r.position).toBe(8000);
  });
});

describe('Replay — the clock only ever runs forwards', () => {
  it('does not rewind the simulation when the stream’s own timestamps go backwards', () => {
    // Two transcripts tailed at once, or a clock that stepped: `seq` is monotonic but `ts` is not.
    // Arrival order is the causal truth, and a negative gap must be a zero one, not a rewind.
    const jumbled: Entry[] = [
      { ts: 1000, cmd: seen('main') },
      { ts: 5000, cmd: seen('alpha') },
      { ts: 2000, cmd: thinks('alpha', 'out of order') },
      { ts: 6000, cmd: says('alpha', 'still fine') },
    ];
    const r = new Replay(jumbled);
    const st = r.seek(7000);
    expect(stateOf(st, 'alpha').x).not.toBeNaN();
    expect(r.position).toBe(7000);
  });

  it('caps an enormous idle gap without changing what the room looks like', () => {
    // A nine-minute wait for a build is real, and simulating all of it is correct but slow. Past
    // the point where every queue has drained, more time changes nothing anyone can see.
    const capped: Entry[] = [
      { ts: 0, cmd: seen('main') },
      { ts: 0, cmd: seen('alpha') },
      { ts: 9 * 60_000, cmd: thinks('alpha', 'the build came back') },
    ];
    const r = new Replay(capped);
    const st = r.seek(9 * 60_000 + 100);
    // Everyone is settled at their desk, which is exactly what nine idle minutes look like.
    expect(stateOf(st, 'alpha').think).toBe('the build came back');
    expect(MAX_GAP_MS).toBeLessThan(9 * 60_000);
  });

  it('never caps a gap so short that it deletes a behaviour the live room would have shown', () => {
    // The cap is a performance bound, and a performance bound is not allowed to change what
    // happened. The office sends an idle agent for coffee after `IDLE_COFFEE_MS`; a cap below that
    // would mean the live room showed a coffee walk and the replay of the same session did not —
    // the scrubber would be quietly lying about its own history.
    expect(MAX_GAP_MS).toBeGreaterThan(IDLE_COFFEE_MS);
  });
});

describe('Replay — playing forward', () => {
  it('plays to the same room a seek would have shown', () => {
    const played = new Replay(SESSION);
    played.seek(1000);
    for (let i = 0; i < 40; i++) played.advance(200);

    expect(played.position).toBe(9000);
    expect(asDrawn(played.advance(0))).toEqual(asDrawn(new Replay(SESSION).seek(9000)));
  });

  it('treats a non-finite step as a dropped frame, not as the end of time', () => {
    const r = new Replay(SESSION);
    r.seek(5000);
    r.advance(NaN);
    expect(r.position).toBe(5000);
    expect(asDrawn(r.advance(1000))).toEqual(asDrawn(new Replay(SESSION).seek(6000)));
  });
});

describe('frameAt', () => {
  it('is the one-shot form of a seek', () => {
    expect(frameAt(SESSION, 8000)).toEqual(new Replay(SESSION).seek(8000));
  });
});

/**
 * The log a `Replay` is walking must not move underneath it.
 *
 * `Replay` tracks its position with a numeric cursor, so an entry removed from the front of the
 * array slides every later entry down by one and the replay skips a command it has not applied
 * yet — silently, and for the rest of the session. Once a session is at the cap that is one lost
 * command per new command: in a reproduction it dropped 59 edits and an entire agent, who simply
 * never appeared in the scrubbed room.
 */
describe('Recorder — the log a Replay holds', () => {
  it('hands out a snapshot, not the array it goes on writing to', () => {
    const rec = new Recorder();
    rec.record(1000, seen('a'));
    const snap = rec.entries();
    rec.record(2000, seen('b'));
    expect(snap).toHaveLength(1);
    expect(rec.entries()).toHaveLength(2);
  });

  it('keeps a replay intact while the cap drops entries off the front', () => {
    const rec = new Recorder();
    for (let i = 0; i < REPLAY_CAP; i++) rec.record(1000 + i, thinks('a', `t${i}`));
    const replay = new Replay(rec.entries());
    replay.seek(1000 + REPLAY_CAP);

    // Past the cap: one entry falls off the front for every one recorded.
    for (let i = 0; i < 60; i++) rec.record(50_000 + i, seen(`ghost${i}`));
    expect(rec.truncated).toBe(60);

    // The replay was built from a snapshot, so it still describes exactly the log it was given —
    // it has not silently skipped 60 commands it never applied.
    expect(replay.to).toBe(1000 + REPLAY_CAP - 1);
    expect(replay.seek(1000 + REPLAY_CAP).map((s) => s.id)).toEqual(['a']);
  });

  it('reports a revision that moves for a new command and for a dropped one', () => {
    const rec = new Recorder();
    expect(rec.revision).toBe(0);
    rec.record(1000, seen('a'));
    const afterOne = rec.revision;
    expect(afterOne).toBe(1);
    for (let i = 0; i < REPLAY_CAP + 5; i++) rec.record(2000 + i, thinks('a', `t${i}`));
    // Monotonic, and counts what was dropped as well as what is held — which is what lets a holder
    // of a snapshot notice it is stale with one comparison.
    expect(rec.revision).toBe(REPLAY_CAP + 6);
    expect(rec.truncated).toBeGreaterThan(0);
  });

  it('never reports a position before the log begins', () => {
    const rec = new Recorder();
    rec.record(10_000, seen('a'));
    const replay = new Replay(rec.entries());
    replay.seek(0); // earlier than anything recorded
    // Reporting 0 here claimed the room stood somewhere the log cannot describe, and the next
    // `advance` then ticked the engine through all ten seconds between that fiction and the first
    // real command.
    expect(replay.position).toBe(10_000);
  });
});
