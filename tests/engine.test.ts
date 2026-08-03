import { describe, expect, it } from 'vitest';
import type { Cmd } from '../src/office/mapping';
import {
  ARRIVE_STAGGER_MS,
  BUBBLE_MS,
  DONE_LINGER_MS,
  Engine,
  HEARD_MS,
  HUDDLE_MIN,
  HUDDLE_WINDOW_MS,
  IDLE_COFFEE_MS,
  LINK_MS,
  MANAGER_DESK_INDEX,
  MAX_SEATS,
  POD_MIN_SEAT_GAP,
  POD_OVERFLOW_FAN_X,
  POD_ROW_MAX_Y,
  SCENE,
  SETTLE_MS,
  TABLE_PLACES,
  WAYPOINTS,
  LOUNGE_CAPACITY,
  LOUNGE_DESK_INDEX,
  LOUNGE_STAY_MS,
  loungeSpot,
  podSeat,
  route,
  type ActorState,
} from '../src/office/engine';

// --- helpers -----------------------------------------------------------------------------

const STEP_MS = 50;

const stateOf = (states: readonly ActorState[], id: string): ActorState => {
  const found = states.find((s) => s.id === id);
  if (!found) throw new Error(`no actor '${id}' in ${JSON.stringify(states.map((s) => s.id))}`);
  return found;
};

/** Ticks in fixed 50ms steps until `done` holds; fails loudly rather than looping forever. */
function tickUntil(e: Engine, maxMs: number, done: (states: ActorState[]) => boolean): ActorState[] {
  let states = e.tick(0);
  if (done(states)) return states;
  for (let t = 0; t < maxMs; t += STEP_MS) {
    states = e.tick(STEP_MS);
    if (done(states)) return states;
  }
  throw new Error(`condition never held within ${maxMs}ms of tick time`);
}

const poseIs = (id: string, pose: string) => (states: ActorState[]) => stateOf(states, id).pose === pose;

/** Where a visitor stands to talk to the agent in pod slot `slot`. */
const podVisitorSpot = (slot: number) => ({
  x: podSeat(slot).x + WAYPOINTS.podStandOffset.x,
  y: podSeat(slot).y + WAYPOINTS.podStandOffset.y,
});

/** The brief's tolerance: an actor "reached" an anchor when it is within a pixel of it. */
const expectAt = (s: ActorState, p: { x: number; y: number }): void => {
  expect(Math.hypot(s.x - p.x, s.y - p.y)).toBeLessThanOrEqual(1);
};

const seated = (e: Engine, id: string): ActorState[] => tickUntil(e, 30_000, poseIs(id, 'sit'));

/** An engine whose named agents have all walked in from the door and settled at their desks. */
function officeOf(...ids: string[]): Engine {
  const e = new Engine();
  for (const id of ids) e.apply({ op: 'ensureActor', agentId: id });
  tickUntil(e, 30_000, (states) => states.every((s) => s.pose === 'sit'));
  e.tick(SETTLE_MS); // drain the beat each of them holds in the chair on arrival
  return e;
}

// --- desks -------------------------------------------------------------------------------

describe('Engine — desk assignment', () => {
  it('gives two agents distinct desks, in spawn order', () => {
    const e = new Engine();
    e.apply({ op: 'ensureActor', agentId: 'alpha' });
    e.apply({ op: 'ensureActor', agentId: 'beta' });

    const states = e.tick(0);
    expect(stateOf(states, 'alpha').deskIndex).toBe(0);
    expect(stateOf(states, 'beta').deskIndex).toBe(1);
    expect(states.map((s) => s.id)).toEqual(['alpha', 'beta']);
  });

  it('is idempotent — the same id keeps its desk and adds no second actor', () => {
    const e = new Engine();
    e.apply({ op: 'ensureActor', agentId: 'alpha' });
    e.apply({ op: 'ensureActor', agentId: 'beta' });
    e.apply({ op: 'ensureActor', agentId: 'alpha' });

    const states = e.tick(0);
    expect(states).toHaveLength(2);
    expect(stateOf(states, 'alpha').deskIndex).toBe(0);
  });

  it('seats main at the manager desk rather than a pod slot', () => {
    const e = new Engine();
    e.apply({ op: 'ensureActor', agentId: 'alpha' });
    e.apply({ op: 'ensureActor', agentId: 'main' });

    const states = e.tick(0);
    expect(stateOf(states, 'main').deskIndex).toBe(MANAGER_DESK_INDEX);
    expect(stateOf(states, 'alpha').deskIndex).toBe(0);

    const settled = seated(e, 'main');
    expectAt(stateOf(settled, 'main'), WAYPOINTS.managerSeat);
  });

  it('seats the twelve planned desks at their absolute positions', () => {
    // Pinned to literal scene pixels on purpose: deriving these from the same table the
    // implementation reads would assert nothing. The plan is two banks of six — the left at
    // 23% and 34% of 1600, the right at 78.75% and 91.7%, over rows at 37%, 57.8% and 78.5% of
    // 900. The left bank moved right from 13.75%/26.7% when the break corner took that strip.
    expect(podSeat(0).x).toBeCloseTo(368, 6);
    expect(podSeat(0).y).toBeCloseTo(333, 6);
    // Slot 1 crosses to the other side of the room rather than continuing down the left.
    expect(podSeat(1).x).toBeCloseTo(1260, 6);
    expect(podSeat(1).y).toBeCloseTo(333, 6);
    expect(podSeat(4).x).toBeCloseTo(368, 6);
    expect(podSeat(4).y).toBeCloseTo(520.2, 6);
    // Past the plan: the lane along the bottom of the room, which the seat cap makes unreachable
    // but which still has to be a real position.
    expect(podSeat(12).y).toBeCloseTo(780, 6);
    expect(podSeat(13).x).toBeCloseTo(podSeat(12).x + POD_OVERFLOW_FAN_X, 6);
  });

  // 17 actors, not a dozen: the overflow lane is where this invariant actually gets tested, and
  // twelve stopped one row short of the first failure — column 0's fan used to march on until
  // slot 14 landed 23.6px from slot 7, which the smaller roster never reached.
  it('keeps every desk at least 50px from every other with 17 agents', () => {
    const seats = [...Array(16).keys()].map(podSeat).concat([WAYPOINTS.managerSeat]);
    expect(seats).toHaveLength(17);
    for (let i = 0; i < seats.length; i++) {
      for (let j = i + 1; j < seats.length; j++) {
        const gap = Math.hypot(seats[i].x - seats[j].x, seats[i].y - seats[j].y);
        expect(gap, `slots ${i} and ${j} are ${gap.toFixed(1)}px apart`).toBeGreaterThanOrEqual(
          POD_MIN_SEAT_GAP,
        );
      }
    }
  });

  it('lays the plan out as two banks of six, filled a row at a time and alternating sides', () => {
    const mid = SCENE.w / 2;
    for (const row of [0, 1, 2]) {
      const slots = [0, 1, 2, 3].map((i) => podSeat(row * 4 + i));
      for (const s of slots) expect(s.y, `row ${row} is level`).toBe(slots[0].y);
      // Left, right, left, right — so the first agents seen land on opposite sides of the room.
      expect(slots[0].x).toBeLessThan(mid);
      expect(slots[1].x).toBeGreaterThan(mid);
      expect(slots[2].x).toBeLessThan(mid);
      expect(slots[3].x).toBeGreaterThan(mid);
    }
    expect(podSeat(4).y).toBeGreaterThan(podSeat(0).y);
    expect(podSeat(8).y).toBeGreaterThan(podSeat(4).y);
    // The two banks leave the middle of the room clear, which is what the roundtable, the door's
    // approach and every walk across the floor need.
    const leftmostRight = Math.min(podSeat(1).x, podSeat(3).x);
    const rightmostLeft = Math.max(podSeat(0).x, podSeat(2).x);
    expect(leftmostRight - rightmostLeft).toBeGreaterThan(SCENE.w / 3);
  });

  it('never lets a desk fall off the bottom of the room', () => {
    for (let slot = 0; slot < 40; slot++) expect(podSeat(slot).y).toBeLessThanOrEqual(POD_ROW_MAX_Y);
  });
});

// --- entering ----------------------------------------------------------------------------

describe('Engine — entering the room', () => {
  it('spawns a new actor at the door and walks it to its own desk', () => {
    const e = new Engine();
    e.apply({ op: 'ensureActor', agentId: 'alpha' });

    const spawned = stateOf(e.tick(0), 'alpha');
    expectAt(spawned, WAYPOINTS.door);
    expect(spawned.pose).toBe('walk');

    const settled = stateOf(seated(e, 'alpha'), 'alpha');
    expectAt(settled, podSeat(0));
    expect(settled.away).toBe(true); // sitting means facing the screen, back to camera
    expect(settled.flip).toBe(false);
  });
});

// --- deliver -----------------------------------------------------------------------------

describe('Engine — deliver', () => {
  it('walks to the manager desk anchor and speaks there', () => {
    const e = officeOf('main', 'alpha');
    e.apply({ op: 'deliver', agentId: 'alpha', to: 'main', text: 'found it' });

    expect(stateOf(e.tick(STEP_MS), 'alpha').pose).toBe('walk');

    const arrived = stateOf(tickUntil(e, 30_000, poseIs('alpha', 'stand')), 'alpha');
    expectAt(arrived, WAYPOINTS.managerStand);
    expect(arrived.say).toBe('found it');
    expect(arrived.away).toBe(false); // turned to face the room while speaking
  });

  it('walks back and sits down at its own desk, bubble spent', () => {
    const e = officeOf('main', 'alpha');
    e.apply({ op: 'deliver', agentId: 'alpha', to: 'main', text: 'found it' });
    tickUntil(e, 30_000, poseIs('alpha', 'stand'));

    const home = stateOf(tickUntil(e, 30_000, poseIs('alpha', 'sit')), 'alpha');
    expectAt(home, podSeat(0));
    expect(home.away).toBe(true);
    expect(home.say).toBeUndefined();
  });
});

// --- confront ----------------------------------------------------------------------------

describe('Engine — confront', () => {
  it("walks to the target agent's desk and speaks there", () => {
    const e = officeOf('main', 'alpha', 'beta');
    e.apply({ op: 'confront', agentId: 'alpha', to: 'beta', text: 'REFUTED', verdict: 'err' });

    const arrived = stateOf(tickUntil(e, 30_000, poseIs('alpha', 'stand')), 'alpha');
    // beta holds pod slot 1 — the mockup's finder-bugs desk, whose visitor spot is `nearFinder`.
    expectAt(arrived, podVisitorSpot(1));
    expect(podVisitorSpot(1)).toEqual({ x: 1356, y: 385.2 }); // SPOT.nearFinder, in scene pixels
    expect(arrived.say).toBe('REFUTED');
    // beta itself never moved.
    expect(stateOf(e.tick(0), 'beta').pose).toBe('sit');
  });

  it('speaks in place when the target is the actor itself', () => {
    const e = officeOf('main', 'alpha');
    e.apply({ op: 'confront', agentId: 'alpha', to: 'alpha', text: 'CONFIRMED', verdict: 'ok' });

    const s = stateOf(e.tick(STEP_MS), 'alpha');
    expect(s.pose).toBe('sit');
    expect(s.say).toBe('CONFIRMED');
    expectAt(s, podSeat(0));
  });

  it('lets the newer line replace the one already on screen', () => {
    const e = officeOf('main', 'alpha');
    e.apply({ op: 'confront', agentId: 'alpha', to: 'alpha', text: 'first', verdict: 'err' });
    e.apply({ op: 'confront', agentId: 'alpha', to: 'alpha', text: 'second', verdict: 'ok' });

    const s = stateOf(e.tick(STEP_MS), 'alpha');
    expect(s.say).toBe('second');
    expect(s.verdict).toBe('ok');
  });

  it('carries the verdict for as long as the bubble is up, and no longer', () => {
    const e = officeOf('main', 'alpha', 'beta');
    e.apply({ op: 'confront', agentId: 'alpha', to: 'beta', text: 'REFUTED', verdict: 'err' });

    const arrived = stateOf(tickUntil(e, 30_000, poseIs('alpha', 'stand')), 'alpha');
    expect(arrived.say).toBe('REFUTED');
    expect(arrived.verdict).toBe('err');

    const spent = stateOf(tickUntil(e, 30_000, (st) => stateOf(st, 'alpha').say === undefined), 'alpha');
    expect(spent.verdict).toBeUndefined();
  });

  it('leaves a delivery untinted', () => {
    const e = officeOf('main', 'alpha');
    e.apply({ op: 'deliver', agentId: 'alpha', to: 'main', text: 'found it' });

    const arrived = stateOf(tickUntil(e, 30_000, poseIs('alpha', 'stand')), 'alpha');
    expect(arrived.say).toBe('found it');
    expect(arrived.verdict).toBeUndefined();
  });
});

// --- bubbles -----------------------------------------------------------------------------

describe('Engine — bubbles', () => {
  it('keeps a think bubble for 5s of tick time, then drops it', () => {
    const e = officeOf('alpha');
    e.apply({ op: 'think', agentId: 'alpha', text: 'grep retry paths' });

    expect(stateOf(e.tick(BUBBLE_MS - 1), 'alpha').think).toBe('grep retry paths');
    expect(stateOf(e.tick(1), 'alpha').think).toBeUndefined();
  });

  it('times every actor’s bubble separately', () => {
    const e = officeOf('alpha', 'beta');
    e.apply({ op: 'think', agentId: 'alpha', text: 'early' });
    e.tick(2000);
    e.apply({ op: 'think', agentId: 'beta', text: 'late' });

    const mid = e.tick(BUBBLE_MS - 2000); // alpha is exactly 5s old, beta only 3s
    expect(stateOf(mid, 'alpha').think).toBeUndefined();
    expect(stateOf(mid, 'beta').think).toBe('late');

    expect(stateOf(e.tick(2000), 'beta').think).toBeUndefined();
  });

  it('replaces the bubble with the newer text and restarts its 5s', () => {
    const e = officeOf('alpha');
    e.apply({ op: 'think', agentId: 'alpha', text: 'first' });
    e.tick(1000);
    e.apply({ op: 'think', agentId: 'alpha', text: 'second' });

    expect(stateOf(e.tick(4500), 'alpha').think).toBe('second'); // 4.5s after the second
    expect(stateOf(e.tick(500), 'alpha').think).toBeUndefined();
  });

  it('takes only its origin from the injected clock — bubble life is still tick time', () => {
    const e = new Engine(() => 1_000_000);
    e.apply({ op: 'think', agentId: 'alpha', text: 'hm' });

    expect(stateOf(e.tick(BUBBLE_MS - 1), 'alpha').think).toBe('hm');
    expect(stateOf(e.tick(1), 'alpha').think).toBeUndefined();
  });
});

// --- truncated backlogs ------------------------------------------------------------------

describe('Engine — commands for unknown ids', () => {
  it('lazily creates the actor a command names, rather than crashing', () => {
    const e = new Engine();
    e.apply({ op: 'think', agentId: 'ghost', text: 'hm' });
    e.apply({ op: 'status', agentId: 'ghost2', text: '1.2k tok' });
    e.apply({ op: 'deliver', agentId: 'ghost3', to: 'main', text: 'hi' });

    const states = e.tick(0);
    expect(states.map((s) => s.id)).toEqual(['ghost', 'ghost2', 'ghost3', 'main']);
    expect(stateOf(states, 'ghost').think).toBe('hm');
    expect(stateOf(states, 'ghost2').status).toBe('1.2k tok');
    expect(stateOf(states, 'main').deskIndex).toBe(MANAGER_DESK_INDEX);
  });
});

// --- status line -------------------------------------------------------------------------

describe('Engine — status line', () => {
  it('shows the work label, then the token total, without disturbing the pose', () => {
    const e = officeOf('alpha');
    e.apply({ op: 'tool', agentId: 'alpha', id: 't1', tool: 'Read', act: 'read', target: 'src/a.ts' });

    const working = stateOf(e.tick(STEP_MS), 'alpha');
    expect(working.status).toBe('Read src/a.ts');
    expect(working.pose).toBe('sit');

    // A token total arriving mid-call does not get to overwrite what the agent is doing…
    e.apply({ op: 'status', agentId: 'alpha', text: '12.3k tok' });
    expect(stateOf(e.tick(STEP_MS), 'alpha').status).toBe('Read src/a.ts');

    // …but it is what is left on the plate once the call comes back.
    e.apply({ op: 'toolEnd', agentId: 'alpha', id: 't1', ok: true });
    expect(stateOf(e.tick(STEP_MS), 'alpha').status).toBe('12.3k tok');
  });

  it('shows a bare tool name when the call has no target', () => {
    const e = officeOf('alpha');
    e.apply({ op: 'tool', agentId: 'alpha', id: 't1', tool: 'Bash', act: 'run' });
    expect(stateOf(e.tick(STEP_MS), 'alpha').status).toBe('Bash');
  });
});

// --- what the widened seam reports --------------------------------------------------------

describe('Engine — tool calls', () => {
  it('reports the open call as the current act, and clears it when the result lands', () => {
    const e = officeOf('alpha');
    e.apply({ op: 'tool', agentId: 'alpha', id: 't1', tool: 'Bash', act: 'run', target: 'npm test' });

    const busy = stateOf(e.tick(STEP_MS), 'alpha');
    expect(busy.act).toBe('run');
    expect(busy.tool).toBe('Bash');
    expect(busy.target).toBe('npm test');
    expect(busy.busy).toBe(1);
    expect(busy.lastOk).toBeUndefined();

    e.apply({ op: 'toolEnd', agentId: 'alpha', id: 't1', ok: true });
    const free = stateOf(e.tick(STEP_MS), 'alpha');
    expect(free.busy).toBe(0);
    expect(free.act).toBeUndefined();
    expect(free.lastOk).toBe(true);
    expect(free.resolved).toBe(1);
  });

  it('stays busy while other calls are still in flight, and shows the newest of them', () => {
    const e = officeOf('alpha');
    e.apply({ op: 'tool', agentId: 'alpha', id: 't1', tool: 'Read', act: 'read' });
    e.apply({ op: 'tool', agentId: 'alpha', id: 't2', tool: 'Bash', act: 'run' });
    e.apply({ op: 'toolEnd', agentId: 'alpha', id: 't2', ok: true });

    const s = stateOf(e.tick(STEP_MS), 'alpha');
    expect(s.busy).toBe(1);
    expect(s.act).toBe('read'); // the Read is what is left running
  });

  it('counts consecutive failures and forgets them on the first success', () => {
    const e = officeOf('alpha');
    for (const [i, ok] of [false, false, true].entries()) {
      e.apply({ op: 'tool', agentId: 'alpha', id: `t${i}`, tool: 'Bash', act: 'run' });
      e.apply({ op: 'toolEnd', agentId: 'alpha', id: `t${i}`, ok });
    }
    const s = stateOf(e.tick(STEP_MS), 'alpha');
    expect(s.fails).toBe(0);
    expect(s.resolved).toBe(3);

    e.apply({ op: 'tool', agentId: 'alpha', id: 'tz', tool: 'Bash', act: 'run' });
    e.apply({ op: 'toolEnd', agentId: 'alpha', id: 'tz', ok: false });
    expect(stateOf(e.tick(STEP_MS), 'alpha').fails).toBe(1);
  });

  it('never lets a result for a call it never saw open drive the busy count negative', () => {
    // A backlog that begins mid-tool: the result arrives with no start to close.
    const e = officeOf('alpha');
    e.apply({ op: 'toolEnd', agentId: 'alpha', id: 'stranger', ok: false });
    const s = stateOf(e.tick(STEP_MS), 'alpha');
    expect(s.busy).toBe(0);
    expect(s.resolved).toBe(1);
    expect(s.lastOk).toBe(false);
  });

  it('counts open Task calls separately, as children being waited on', () => {
    const e = officeOf('main');
    e.apply({ op: 'tool', agentId: 'main', id: 'k1', tool: 'Task', act: 'delegate' });
    e.apply({ op: 'tool', agentId: 'main', id: 'k2', tool: 'Task', act: 'delegate' });
    e.apply({ op: 'tool', agentId: 'main', id: 'r1', tool: 'Read', act: 'read' });

    expect(stateOf(e.tick(STEP_MS), 'main').waiting).toBe(2);
    e.apply({ op: 'toolEnd', agentId: 'main', id: 'k1', ok: true });
    const s = stateOf(e.tick(STEP_MS), 'main');
    expect(s.waiting).toBe(1);
    expect(s.busy).toBe(2);
  });
});

describe('Engine — edits, prompts and completion', () => {
  it('remembers the last file changed and counts the changes', () => {
    const e = officeOf('alpha');
    e.apply({ op: 'edit', agentId: 'alpha', path: 'src/a.ts' });
    e.apply({ op: 'edit', agentId: 'alpha', path: 'src/b.ts' });
    const s = stateOf(e.tick(STEP_MS), 'alpha');
    expect(s.edit).toBe('src/b.ts');
    expect(s.edits).toBe(2);
  });

  it('holds an instruction for its own window, then drops it', () => {
    const e = officeOf('alpha');
    e.apply({ op: 'prompt', agentId: 'alpha', text: 'scout the suites', from: 'parent' });
    expect(stateOf(e.tick(HEARD_MS - 1), 'alpha').heard).toBe('scout the suites');
    expect(stateOf(e.tick(1), 'alpha').heard).toBeUndefined();
  });

  it('marks an agent finished, with how it went', () => {
    const e = officeOf('alpha');
    expect(stateOf(e.tick(0), 'alpha').done).toBeUndefined();
    e.apply({ op: 'done', agentId: 'alpha', ok: false });
    const s = stateOf(e.tick(STEP_MS), 'alpha');
    expect(s.done).toBe(true);
    expect(s.doneOk).toBe(false);
  });
});

describe('Engine — spawn links', () => {
  it('draws the edge the moment the child introduces itself, not before', () => {
    const e = officeOf('main');
    e.apply({ op: 'spawn', agentId: 'main', child: 'pending', prompt: 'map the layout', toolUseId: 'tu1' });
    // The child does not exist yet, so there is nothing honest to draw a line to.
    expect(stateOf(e.tick(STEP_MS), 'main').link).toBeUndefined();

    e.apply({ op: 'ensureActor', agentId: 'kid', parentToolUseId: 'tu1' });
    const s = e.tick(STEP_MS);
    expect(stateOf(s, 'main').link).toEqual({ child: 'kid', label: 'map the layout' });
    expect(stateOf(s, 'kid').parent).toBe('main');
  });

  it('drops the edge once its couple of seconds are up', () => {
    const e = officeOf('main');
    e.apply({ op: 'spawn', agentId: 'main', child: 'kid', prompt: 'map the layout' });
    expect(stateOf(e.tick(LINK_MS - 1), 'main').link).toBeDefined();
    expect(stateOf(e.tick(1), 'main').link).toBeUndefined();
  });

  it('does not re-fire the edge when the same agentSeen is replayed', () => {
    const e = officeOf('main');
    e.apply({ op: 'spawn', agentId: 'main', child: 'pending', prompt: 'map the layout', toolUseId: 'tu1' });
    e.apply({ op: 'ensureActor', agentId: 'kid', parentToolUseId: 'tu1' });
    e.tick(LINK_MS + 1);
    expect(stateOf(e.tick(0), 'main').link).toBeUndefined();

    e.apply({ op: 'ensureActor', agentId: 'kid', parentToolUseId: 'tu1' });
    expect(stateOf(e.tick(STEP_MS), 'main').link).toBeUndefined();
  });
});

// --- queueing ----------------------------------------------------------------------------

describe('Engine — queued trips', () => {
  it('runs a second trip only after the first one has finished', () => {
    const e = officeOf('main', 'alpha', 'beta');
    e.apply({ op: 'deliver', agentId: 'alpha', to: 'main', text: 'first' });
    e.apply({ op: 'confront', agentId: 'alpha', to: 'beta', text: 'second', verdict: 'ok' });

    const atManager = stateOf(tickUntil(e, 40_000, poseIs('alpha', 'stand')), 'alpha');
    expectAt(atManager, WAYPOINTS.managerStand);
    expect(atManager.say).toBe('first');

    const home = stateOf(tickUntil(e, 40_000, poseIs('alpha', 'sit')), 'alpha');
    expectAt(home, podSeat(0));

    const atBeta = stateOf(tickUntil(e, 40_000, poseIs('alpha', 'stand')), 'alpha');
    expectAt(atBeta, podVisitorSpot(1));
    expect(atBeta.say).toBe('second');
  });
});

// --- huddle and coffee break ---------------------------------------------------------------

/** The four roundtable places by name, in `TABLE_PLACES` order — what a huddle fills. */
const TABLE_NAMES = ['tableN', 'tableW', 'tableE', 'tableS'] as const;

/**
 * Runs `ms` of tick time and reports, per agent, how many separate times it stood at each place
 * at the roundtable.
 *
 * Arrivals rather than frames, and counted on the rising edge: a count is what tells one long
 * meeting from two, which is the whole question when the rule under test is "an agent already at
 * the table is never sent to it again".
 */
function tableArrivals(e: Engine, ms: number): Map<string, Record<string, number>> {
  const counts = new Map<string, Record<string, number>>();
  const previous = new Map<string, string>();
  for (let t = 0; t < ms; t += STEP_MS) {
    for (const s of e.tick(STEP_MS)) {
      let here = '';
      TABLE_PLACES.forEach((p, i) => {
        if (s.pose === 'stand' && Math.hypot(s.x - p.x, s.y - p.y) <= 1) here = TABLE_NAMES[i];
      });
      if (here !== '' && previous.get(s.id) !== here) {
        const row = counts.get(s.id) ?? {};
        row[here] = (row[here] ?? 0) + 1;
        counts.set(s.id, row);
      }
      previous.set(s.id, here);
    }
  }
  return counts;
}

/** Everybody reports to main at once — the burst that a fan-out returning looks like. */
const allReport = (e: Engine, ...ids: string[]): void => {
  for (const id of ids) e.apply({ op: 'deliver', agentId: id, to: 'main', text: `${id} says` });
};

describe('Engine — huddle at the roundtable', () => {
  it('gathers three exchanging agents at three of the table’s four places', () => {
    const e = officeOf('main', 'alpha', 'beta', 'gamma');
    allReport(e, 'alpha', 'beta', 'gamma');

    // 60s covers the longest of the three: a delivery to the manager desk from pod slot 0 and then
    // the round trip out to the rug, about 30s of office time in all.
    const visits = tableArrivals(e, 60_000);
    expect(visits.get('alpha')).toEqual({ tableN: 1 });
    expect(visits.get('beta')).toEqual({ tableW: 1 });
    expect(visits.get('gamma')).toEqual({ tableE: 1 });
    // Three people take three places, and the one nobody was addressing stays at its desk.
    expect(visits.get('main')).toBeUndefined();
  });

  it('seats four and no more — the fifth stays at its desk and keeps working', () => {
    const e = officeOf('main', 'a0', 'a1', 'a2', 'a3', 'a4');
    allReport(e, 'a0', 'a1', 'a2', 'a3', 'a4');

    const visits = tableArrivals(e, 60_000);
    expect(visits.get('a0')).toEqual({ tableN: 1 });
    expect(visits.get('a1')).toEqual({ tableW: 1 });
    expect(visits.get('a2')).toEqual({ tableE: 1 });
    expect(visits.get('a3')).toEqual({ tableS: 1 });
    // Not queued for a place, not stood on the table itself: a4 simply never goes.
    expect(visits.get('a4')).toBeUndefined();
    expectAt(stateOf(e.tick(0), 'a4'), podSeat(4));
  });

  it('takes two agents exchanging as a conversation, not a meeting', () => {
    expect(HUDDLE_MIN).toBe(3);
    const e = officeOf('main', 'alpha', 'beta');
    allReport(e, 'alpha', 'beta');
    expect(tableArrivals(e, 40_000).size).toBe(0);
  });

  it('does not gather three reports spread wider than the window', () => {
    const e = officeOf('main', 'alpha', 'beta', 'gamma');
    e.apply({ op: 'deliver', agentId: 'alpha', to: 'main', text: 'one' });
    e.tick(HUDDLE_WINDOW_MS / 2 + 100);
    e.apply({ op: 'deliver', agentId: 'beta', to: 'main', text: 'two' });
    e.tick(HUDDLE_WINDOW_MS / 2 + 100);
    // By now alpha's line is older than the window, so only two of the three are still talking.
    e.apply({ op: 'deliver', agentId: 'gamma', to: 'main', text: 'three' });
    expect(tableArrivals(e, 40_000).size).toBe(0);
  });

  it('does not count three agents each talking to themselves', () => {
    const e = officeOf('main', 'alpha', 'beta', 'gamma');
    for (const id of ['alpha', 'beta', 'gamma']) {
      e.apply({ op: 'confront', agentId: id, to: id, text: 'CONFIRMED', verdict: 'ok' });
    }
    expect(tableArrivals(e, 40_000).size).toBe(0);
  });

  it('walks the line it was already carrying before it joins the huddle', () => {
    // The rule the two behaviours are bounded by: a delivery is the thing a viewer is waiting on,
    // so it is never displaced — the huddle queues behind it.
    const e = officeOf('main', 'alpha', 'beta', 'gamma');
    allReport(e, 'alpha', 'beta', 'gamma');

    let spoke = -1;
    let atTable = -1;
    for (let i = 0; i * STEP_MS < 60_000; i++) {
      const s = stateOf(e.tick(STEP_MS), 'alpha');
      if (spoke === -1 && s.pose === 'stand' && s.say === 'alpha says') spoke = i;
      const table = Math.hypot(s.x - WAYPOINTS.tableN.x, s.y - WAYPOINTS.tableN.y);
      if (atTable === -1 && s.pose === 'stand' && table <= 1) atTable = i;
    }
    expect(spoke).toBeGreaterThanOrEqual(0);
    expect(atTable).toBeGreaterThan(spoke);
  });

  it('never queues a second walk to the table for somebody already at it', () => {
    const e = officeOf('main', 'alpha', 'beta', 'gamma');
    for (let i = 0; i < 4; i++) allReport(e, 'alpha', 'beta', 'gamma');

    // Twelve exchanges, one meeting. 80s covers alpha's worst case: a delivery, the huddle, and
    // the second delivery `MAX_QUEUED_TRIPS` let it keep hold of.
    const visits = tableArrivals(e, 80_000);
    expect(visits.get('alpha')).toEqual({ tableN: 1 });
    expect(visits.get('beta')).toEqual({ tableW: 1 });
    expect(visits.get('gamma')).toEqual({ tableE: 1 });
  });

  it('sends every participant back to its own chair', () => {
    const e = officeOf('main', 'alpha', 'beta', 'gamma');
    allReport(e, 'alpha', 'beta', 'gamma');
    for (let t = 0; t < 60_000; t += STEP_MS) e.tick(STEP_MS);

    const settled = e.tick(0);
    for (const [i, id] of ['alpha', 'beta', 'gamma'].entries()) {
      expect(stateOf(settled, id).pose, `${id} is still on its feet`).toBe('sit');
      expectAt(stateOf(settled, id), podSeat(i));
    }
    expectAt(stateOf(settled, 'main'), WAYPOINTS.managerSeat);
  });

  it('lets an agent that finishes at the table still leave the meeting for the break corner', () => {
    const e = officeOf('main', 'alpha', 'beta', 'gamma');
    allReport(e, 'alpha', 'beta', 'gamma');
    tickUntil(e, 60_000, (st) => {
      const s = stateOf(st, 'alpha');
      return s.pose === 'stand' && Math.hypot(s.x - WAYPOINTS.tableN.x, s.y - WAYPOINTS.tableN.y) <= 1;
    });

    e.apply({ op: 'done', agentId: 'alpha', ok: true });
    const after = tickUntil(e, 60_000, (st) => stateOf(st, 'alpha').lounging === true);
    // Still in the room — everyone is, now — but off the table and over in the corner.
    expect(after.map((s) => s.id).sort()).toEqual(['alpha', 'beta', 'gamma', 'main']);
    expectAt(stateOf(after, 'alpha'), loungeSpot(0));
    expect(e.offsite()).toEqual([]);
  });

  it('never calls the queue outside to a table it has no chair near', () => {
    // Off-site agents are in the roster and still speak, but they have no desk to walk from and
    // nothing to walk back to — the same reason `trip` refuses to send them anywhere.
    const e = officeOf('main', ...[...Array(MAX_SEATS - 1).keys()].map((i) => `a${i}`));
    for (const id of ['w0', 'w1', 'w2']) e.apply({ op: 'ensureActor', agentId: id });
    allReport(e, 'w0', 'w1', 'w2');

    expect(tableArrivals(e, 20_000).size).toBe(0);
    expect(e.offsite()).toEqual(['w0', 'w1', 'w2']);
  });
});

describe('Engine — coffee break', () => {
  /** A tool call opened and never closed: one agent visibly still at work. */
  const working = (e: Engine, id: string): void => {
    e.apply({ op: 'tool', agentId: id, id: `${id}-t1`, tool: 'Bash', act: 'run', target: 'npm test' });
  };

  it('leaves an office where nobody is working still, however long it idles', () => {
    const e = officeOf('main', 'alpha');
    let stirred = false;
    for (let t = 0; t < IDLE_COFFEE_MS * 2; t += STEP_MS) {
      if (e.tick(STEP_MS).some((s) => s.pose !== 'sit')) stirred = true;
    }
    expect(stirred, 'somebody went for coffee in a finished office').toBe(false);
  });

  it('sends an idle agent to the machine and back while somebody else is still working', () => {
    const e = officeOf('alpha', 'beta');
    working(e, 'beta');

    const atMachine = tickUntil(e, IDLE_COFFEE_MS + 30_000, poseIs('alpha', 'stand'));
    expectAt(stateOf(atMachine, 'alpha'), WAYPOINTS.coffee);
    // beta has a call in flight, so it is not idle and never leaves its chair.
    expect(stateOf(atMachine, 'beta').pose).toBe('sit');
    expectAt(stateOf(atMachine, 'beta'), podSeat(1));

    const home = stateOf(tickUntil(e, 30_000, poseIs('alpha', 'sit')), 'alpha');
    expectAt(home, podSeat(0));
    expect(home.away).toBe(true);
  });

  it('waits exactly ninety seconds, counted from the last sign of life', () => {
    const e = officeOf('alpha', 'beta');
    working(e, 'beta');
    e.apply({ op: 'think', agentId: 'alpha', text: 'nothing to do' }); // restarts alpha's idle clock

    let stood = -1;
    for (let t = STEP_MS; t <= IDLE_COFFEE_MS + 5000 && stood === -1; t += STEP_MS) {
      if (stateOf(e.tick(STEP_MS), 'alpha').pose !== 'sit') stood = t;
    }
    // The threshold is tested at the end of a tick, after everyone has already moved, so the first
    // frame that shows the actor on its feet is the one after the tick that crossed it.
    expect(stood).toBe(IDLE_COFFEE_MS + STEP_MS);
  });

  it('drops to the lane’s turn before joining the aisle, from a desk that sits above it', () => {
    // The guard `lanesOf` exists for: the top row is north of the lane's turn, and joining the
    // aisle at its own row would walk the actor through the kitchen counter.
    const e = officeOf('alpha', 'beta');
    working(e, 'beta');
    expect(podSeat(0).y).toBeLessThan(WAYPOINTS.coffeeLane.y);

    // How far *south* it gets once it is west of its own desk. The turn is south of that desk, so
    // a route that joined the aisle at the desk's own row would never reach it. Sampled positions
    // rather than the anchor itself: a segment boundary is crossed inside a tick, so no frame is
    // guaranteed to land on one.
    let deepest = Number.NEGATIVE_INFINITY;
    let strayed = false;
    for (let t = 0; t < IDLE_COFFEE_MS + 30_000; t += STEP_MS) {
      const s = stateOf(e.tick(STEP_MS), 'alpha');
      if (s.x < WAYPOINTS.aisleWestX + 1) deepest = Math.max(deepest, s.y);
      // North of the turn, the only column it may ever be found in is the machine's own.
      const north = s.y < WAYPOINTS.coffeeLane.y && s.x < WAYPOINTS.aisleWestX;
      if (north && Math.abs(s.x - WAYPOINTS.coffee.x) > 1) strayed = true;
    }
    expect(deepest, 'never came down to the lane’s turn').toBeGreaterThanOrEqual(
      WAYPOINTS.coffeeLane.y - 1,
    );
    expect(strayed, 'walked through the kitchen counter').toBe(false);
  });

  it('sends one agent to the machine at a time', () => {
    // There is one coffee machine and one anchor in front of it. Two idle agents arriving together
    // would stand in the same pixel, which is a picture of a bug whatever office it is drawn from.
    const e = officeOf('alpha', 'beta', 'gamma');
    working(e, 'gamma');

    let crowded = false;
    let wentOut = 0;
    let away = new Set<string>();
    for (let t = 0; t < IDLE_COFFEE_MS + 60_000; t += STEP_MS) {
      const out = new Set(e.tick(STEP_MS).filter((s) => s.pose !== 'sit').map((s) => s.id));
      if (out.size > 1) crowded = true;
      for (const id of out) if (!away.has(id)) wentOut += 1;
      away = out;
    }
    expect(crowded, 'two agents were off their chairs at once').toBe(false);
    expect(wentOut, 'both idle agents should get a turn').toBe(2);
  });

  it('never sends somebody who has already retired to the corner off for a coffee', () => {
    // They are *at* the coffee machine. An idle timer that fired for them would walk them out of
    // the break corner and back into it, forever.
    const e = officeOf('main', 'alpha', 'beta');
    working(e, 'beta');
    e.apply({ op: 'done', agentId: 'alpha', ok: true });
    const settled = tickUntil(e, 60_000, (st) => stateOf(st, 'alpha').lounging === true);
    const spot = { x: stateOf(settled, 'alpha').x, y: stateOf(settled, 'alpha').y };

    // Bounded by the corner stay, because leaving for good is the one departure that *is* allowed
    // — and `IDLE_COFFEE_MS` is well inside it, so the idle timer still gets its chance to misfire.
    for (let t = 0; t < LOUNGE_STAY_MS - STEP_MS; t += STEP_MS) {
      const s = stateOf(e.tick(STEP_MS), 'alpha');
      expect(s.x, 'a retired agent must not wander').toBeCloseTo(spot.x, 6);
      expect(s.y).toBeCloseTo(spot.y, 6);
    }
    expect(IDLE_COFFEE_MS).toBeLessThan(LOUNGE_STAY_MS); // or the loop above proves nothing
    expect(e.offsite()).toEqual([]);
  });

  it('replays both behaviours identically from the same script and the same ticks', () => {
    // The room's whole contract: neither of these reads a clock, rolls a die, or remembers a frame.
    const script = (e: Engine): ActorState[][] => {
      const frames: ActorState[][] = [];
      for (const id of ['main', 'alpha', 'beta', 'gamma']) e.apply({ op: 'ensureActor', agentId: id });
      for (let i = 0; i < 60; i++) frames.push(e.tick(211));
      allReport(e, 'alpha', 'beta', 'gamma');
      for (let i = 0; i < 200; i++) frames.push(e.tick(211));
      e.apply({ op: 'tool', agentId: 'beta', id: 'b1', tool: 'Bash', act: 'run' });
      for (let i = 0; i < 600; i++) frames.push(e.tick(211));
      return frames;
    };
    expect(script(new Engine())).toEqual(script(new Engine()));
  });
});

// --- hot-desking -------------------------------------------------------------------------

describe('Engine — hot-desking', () => {
  /** The pod ids that exactly fill the floor plan, plus main at the manager desk. */
  const fullHouse = (): string[] => [...Array(MAX_SEATS - 1).keys()].map((i) => `a${i}`);

  it('walks a finished agent to the break corner, and leaves it there', () => {
    const e = officeOf('main', 'alpha');
    e.apply({ op: 'done', agentId: 'alpha', ok: true });

    // It holds its chair for a beat first, so a `done` on the same frame as a last line does not
    // erase the line.
    expect(stateOf(e.tick(DONE_LINGER_MS - 100), 'alpha').pose).toBe('sit');

    const up = stateOf(tickUntil(e, 60_000, poseIs('alpha', 'stand')), 'alpha');
    expect(up.done).toBe(true);
    expect(up.doneOk).toBe(true);
    expect(up.retired).toBe(true);
    // Its chair is given up the moment it stands, not when it arrives: a live agent waiting
    // outside should not be kept out while a finished one strolls the width of the room.
    expect(up.deskIndex).toBe(LOUNGE_DESK_INDEX);

    const settled = stateOf(tickUntil(e, 60_000, (st) => stateOf(st, 'alpha').lounging === true), 'alpha');
    expectAt(settled, loungeSpot(0));
    expect(settled.loungeSlot).toBe(0);

    // It stays a while — the corner is what makes work completing visible, and an office that
    // deleted people the instant they finished would end a successful session as an empty room.
    const during = e.tick(LOUNGE_STAY_MS - 5_000);
    expect(during.map((s) => s.id).sort()).toEqual(['alpha', 'main']);
    expectAt(stateOf(during, 'alpha'), loungeSpot(0));

    // And then it goes home. The corner used to be the end of the line, which over a couple of
    // hours turned the room into a group photograph of everyone who had ever worked there.
    const after = tickUntil(e, 300_000, (st) => !st.some((s) => s.id === 'alpha'));
    expect(after.map((s) => s.id)).toEqual(['main']);
    expect(e.offsite()).toEqual([]); // gone, not queued outside for a chair
  });

  it('brings an agent that had already left back in through the door', () => {
    // It left because it was finished. If it turns out not to have been, it did not teleport to the
    // corner — it walks back in, because that is what actually happened.
    const e = officeOf('main', 'alpha');
    e.apply({ op: 'done', agentId: 'alpha', ok: true });
    tickUntil(e, 300_000, (st) => !st.some((s) => s.id === 'alpha'));

    e.apply({ op: 'tool', agentId: 'alpha', id: 't1', tool: 'Read', act: 'read' });
    const back = stateOf(e.tick(0), 'alpha');
    expect(back.deskIndex).toBeGreaterThanOrEqual(0);
    expectAt(back, WAYPOINTS.door);
    expect(stateOf(tickUntil(e, 60_000, poseIs('alpha', 'sit')), 'alpha').pose).toBe('sit');
  });

  it('gives the break-corner place back when somebody leaves', () => {
    // The corner holds twelve. If a place were still held by somebody who had gone home, a long
    // session would run out of room to retire into and later agents would be stranded at their
    // desks looking like they were still working.
    const e = officeOf('main', 'alpha');
    for (let i = 0; i < LOUNGE_CAPACITY + 2; i++) {
      e.apply({ op: 'done', agentId: 'alpha', ok: true });
      tickUntil(e, 300_000, (st) => !st.some((s) => s.id === 'alpha'));
      e.apply({ op: 'tool', agentId: 'alpha', id: `t${i}`, tool: 'Read', act: 'read' });
      tickUntil(e, 60_000, poseIs('alpha', 'sit'));
    }
    e.apply({ op: 'done', agentId: 'alpha', ok: true });
    const settled = stateOf(tickUntil(e, 60_000, (st) => stateOf(st, 'alpha').lounging === true), 'alpha');
    expect(settled.loungeSlot).toBe(0); // the same place, handed back every time
  });

  /**
   * `agentDone` is not proof that an agent has stopped.
   *
   * The hub derives it from the *parent's* `tool_result`, which comes back the instant a
   * background spawn is launched — 246 real spawns on this machine reported the child finished
   * while it was still writing, by as much as 995 seconds. Retirement therefore has to be
   * reversible, or a working agent spends the rest of the session in the break corner with its
   * desk given away.
   */
  it('brings an agent back to a desk when it turns out not to have finished', () => {
    const e = officeOf('main', 'alpha');
    e.apply({ op: 'done', agentId: 'alpha', ok: true });
    const gone = stateOf(tickUntil(e, 60_000, (st) => stateOf(st, 'alpha').lounging === true), 'alpha');
    expect(gone.retired).toBe(true);
    expect(gone.loungeSlot).toBe(0);

    // It opens a tool call. That cannot be the tail of finished work.
    e.apply({ op: 'tool', agentId: 'alpha', id: 't1', tool: 'Read', act: 'read' });
    const back = stateOf(e.tick(0), 'alpha');
    expect(back.retired).toBe(false);
    expect(back.done).toBe(false);
    expect(back.deskIndex).toBeGreaterThanOrEqual(0); // a real chair, not the corner
    expect(back.lounging).toBeFalsy();

    // It walks back from the corner rather than in through the door: it never left the building,
    // and re-staging an arrival would claim a second agent had joined.
    expectAt(back, loungeSpot(0));
    expect(stateOf(tickUntil(e, 60_000, poseIs('alpha', 'sit')), 'alpha').pose).toBe('sit');
  });

  it('gives the break-corner place back, so the corner cannot run out', () => {
    // A counter that only ever grew was fine while retirement was permanent. With agents coming
    // back, LOUNGE_CAPACITY arrivals would have exhausted it however many had already left.
    const e = officeOf('main', 'alpha');
    for (let i = 0; i < LOUNGE_CAPACITY + 2; i++) {
      e.apply({ op: 'done', agentId: 'alpha', ok: true });
      tickUntil(e, 60_000, (st) => stateOf(st, 'alpha').lounging === true);
      expect(stateOf(e.tick(0), 'alpha').loungeSlot).toBe(0); // the same place, handed back each time
      e.apply({ op: 'tool', agentId: 'alpha', id: `t${i}`, tool: 'Read', act: 'read' });
      tickUntil(e, 60_000, poseIs('alpha', 'sit'));
    }
    expect(stateOf(e.tick(0), 'alpha').retired).toBe(false);
  });

  it('does not drag a finished agent back to a desk just to say it has finished', () => {
    // Its closing report routinely lands after `agentDone`. Speech is what an agent does *as* it
    // finishes, so it says the line where it stands — which is what the corner is for.
    const e = officeOf('main', 'alpha');
    e.apply({ op: 'done', agentId: 'alpha', ok: true });
    tickUntil(e, 60_000, (st) => stateOf(st, 'alpha').lounging === true);
    e.apply({ op: 'deliver', agentId: 'alpha', to: 'main', text: 'All six checks pass.' });
    const s = stateOf(e.tick(STEP_MS), 'alpha');
    expect(s.retired).toBe(true);
    expect(s.say).toBe('All six checks pass.');
  });

  /**
   * The deskless cases. All three used to throw or misbehave, and all three are ordinary: an agent
   * gives up its chair the instant it finishes, `mapping.ts` resolves a verdict's target against
   * the whole roster (which includes everyone queued outside and everyone already finished), and a
   * full break corner leaves a finished agent sitting where it was.
   */
  it('lets an agent be spoken to after it has given up its desk', () => {
    const e = officeOf('main', 'alpha', 'beta');
    e.apply({ op: 'done', agentId: 'beta', ok: true });
    tickUntil(e, 60_000, (st) => stateOf(st, 'beta').lounging === true);
    // The throw this prevents escaped `apply` all the way to the socket's flush loop, taking every
    // remaining event in that batch with it while the feed had already folded them.
    expect(() =>
      e.apply({ op: 'confront', agentId: 'alpha', to: 'beta', text: 'REFUTED that.', verdict: 'err' }),
    ).not.toThrow();
    expect(stateOf(e.tick(STEP_MS), 'alpha').say).toBe('REFUTED that.');
  });

  it('lets an agent be spoken to while it is still waiting outside for a chair', () => {
    const e = officeOf('main', ...fullHouse());
    e.apply({ op: 'ensureActor', agentId: 'waiter' });
    expect(e.tick(0).map((s) => s.id)).not.toContain('waiter'); // genuinely deskless
    expect(() =>
      e.apply({ op: 'confront', agentId: 'main', to: 'waiter', text: 'CONFIRMED it.', verdict: 'ok' }),
    ).not.toThrow();
  });

  it('does not send an agent that has finished off for a coffee', () => {
    // Filling the break corner takes exactly as many finished agents as it holds. Their chairs come
    // free as they go, so `late` — queued outside at the start — is seated by the time it finishes,
    // and `retire` then has nowhere to put it: it keeps the chair, still `done`, still on the floor.
    // That agent used to go idle and set off for the machine, every ninety seconds, for ever.
    const crowd = [...Array(LOUNGE_CAPACITY).keys()].map((i) => `f${i}`);
    const e = officeOf('main', ...crowd, 'late');
    for (const id of crowd) e.apply({ op: 'done', agentId: id, ok: true });
    tickUntil(e, 300_000, (st) => stateOf(st, 'late').pose === 'sit');
    e.tick(SETTLE_MS);

    e.apply({ op: 'tool', agentId: 'main', id: 'keepalive', tool: 'Bash', act: 'run' }); // lights on
    e.apply({ op: 'done', agentId: 'late', ok: true });
    const refused = stateOf(e.tick(0), 'late');
    expect(refused.retired).toBeFalsy(); // the corner had no room for it
    const seat = { x: refused.x, y: refused.y };

    e.tick(IDLE_COFFEE_MS + 5_000);
    // Still in its chair. A coffee is a walk to the machine, so either of these moving is the bug.
    const after = stateOf(e.tick(0), 'late');
    expect(after.pose).toBe('sit');
    expectAt(after, seat);
  });

  it('never makes an agent that finished before it sat down go and sit down first', () => {
    // This is what replaying a completed session looked like: every agent filed in through the
    // door, perched at a desk for three seconds, stood up and filed out again. Nothing about that
    // happened. If the `done` arrives before it ever reached a chair, it just goes to the corner.
    const e = new Engine();
    e.apply({ op: 'ensureActor', agentId: 'alpha' });
    e.tick(ARRIVE_STAGGER_MS + 400); // long enough to be walking, nowhere near long enough to arrive
    expect(stateOf(e.tick(0), 'alpha').pose).toBe('walk');

    e.apply({ op: 'done', agentId: 'alpha', ok: true });
    let everSat = false;
    for (let t = 0; t < 60_000; t += STEP_MS) {
      const s = stateOf(e.tick(STEP_MS), 'alpha');
      if (s.pose === 'sit') everSat = true;
      if (s.lounging) break;
    }
    expect(everSat, 'it detoured to a desk it had no reason to visit').toBe(false);
    expectAt(stateOf(e.tick(0), 'alpha'), loungeSpot(0));
  });

  it('does not give two people the same walking speed', () => {
    // The complaint in one line: everyone moved at exactly `SPEED_PX_PER_S`, so two agents leaving
    // together arrived together, in step, every time.
    const e = new Engine();
    for (const id of ['alpha', 'beta', 'gamma', 'delta']) e.apply({ op: 'ensureActor', agentId: id });
    const arrived = new Map<string, number>();
    for (let t = 0; t < 60_000 && arrived.size < 4; t += STEP_MS) {
      for (const s of e.tick(STEP_MS)) if (s.pose === 'sit' && !arrived.has(s.id)) arrived.set(s.id, t);
    }
    expect(arrived.size).toBe(4);
    expect(new Set(arrived.values()).size, 'they all arrived on the same frame').toBeGreaterThan(1);
  });

  it('fills the corner in order, so two finishers end up talking rather than standing apart', () => {
    const e = officeOf('main', 'alpha', 'beta');
    e.apply({ op: 'done', agentId: 'alpha', ok: true });
    e.apply({ op: 'done', agentId: 'beta', ok: true });
    const settled = tickUntil(
      e,
      90_000,
      (st) => stateOf(st, 'alpha').lounging === true && stateOf(st, 'beta').lounging === true,
    );
    expect(stateOf(settled, 'alpha').loungeSlot).toBe(0);
    expect(stateOf(settled, 'beta').loungeSlot).toBe(1);
    expectAt(stateOf(settled, 'beta'), loungeSpot(1));
  });

  it('does not all stand up on the same frame', () => {
    // The complaint this exists for: six children finishing inside a second used to push their
    // chairs back together and cross the floor in one rank.
    const e = officeOf('main', 'a', 'b', 'c', 'd');
    for (const id of ['a', 'b', 'c', 'd']) e.apply({ op: 'done', agentId: id, ok: true });
    const rose = new Map<string, number>();
    for (let t = 0; t < 60_000 && rose.size < 4; t += STEP_MS) {
      for (const s of e.tick(STEP_MS)) {
        if (s.pose !== 'sit' && !rose.has(s.id) && s.id !== 'main') rose.set(s.id, t);
      }
    }
    expect(rose.size).toBe(4);
    expect(new Set(rose.values()).size, 'they all got up together').toBeGreaterThan(1);
  });

  it('keeps the surplus where it is once the corner is full', () => {
    // Forty finished agents in one corner is a crowd scene, not a break room.
    const ids = [...Array(LOUNGE_CAPACITY + 3).keys()].map((i) => `f${i}`);
    const e = officeOf('main', ...ids.slice(0, MAX_SEATS - 1));
    for (const id of ids.slice(0, MAX_SEATS - 1)) e.apply({ op: 'done', agentId: id, ok: true });
    const st = e.tick(120_000);
    const retired = st.filter((s) => s.retired === true);
    expect(retired.length).toBeLessThanOrEqual(LOUNGE_CAPACITY);
    for (const s of retired) expect(s.loungeSlot).toBeLessThan(LOUNGE_CAPACITY);
  });

  it('never sends main home — it is the session, not a participant in it', () => {
    const e = officeOf('main', 'alpha');
    e.apply({ op: 'done', agentId: 'main', ok: true });
    const st = e.tick(30_000);
    expect(st.some((s) => s.id === 'main')).toBe(true);
    expect(stateOf(st, 'main').deskIndex).toBe(MANAGER_DESK_INDEX);
  });

  it('queues everyone past the floor plan off-site rather than seating them nowhere', () => {
    const e = officeOf('main', ...fullHouse());
    e.apply({ op: 'ensureActor', agentId: 'waiter' });
    e.apply({ op: 'ensureActor', agentId: 'waiter2' });

    const st = e.tick(0);
    expect(st).toHaveLength(MAX_SEATS);
    expect(st.some((s) => s.id === 'waiter')).toBe(false);
    expect(e.offsite()).toEqual(['waiter', 'waiter2']);
  });

  it('hands the freed chair to whoever has been waiting longest', () => {
    const e = officeOf('main', ...fullHouse());
    e.apply({ op: 'ensureActor', agentId: 'waiter' });
    e.apply({ op: 'ensureActor', agentId: 'waiter2' });

    const seatFreed = stateOf(e.tick(0), 'a3').deskIndex;
    e.apply({ op: 'done', agentId: 'a3', ok: true });

    const after = tickUntil(e, 60_000, (st) => st.some((s) => s.id === 'waiter'));
    expect(stateOf(after, 'waiter').deskIndex).toBe(seatFreed);
    expect(e.offsite()).toEqual(['waiter2']); // still one in the queue, and it kept its place
    // The newcomer comes in the way everybody does: through the door, and then to the chair.
    expectAt(stateOf(after, 'waiter'), WAYPOINTS.door);
    expectAt(stateOf(tickUntil(e, 60_000, poseIs('waiter', 'sit')), 'waiter'), podSeat(seatFreed));
  });

  it('walks a queued agent that finished in through the door, to the corner', () => {
    // It never got a chair, so this is the first time anybody has seen it at all. Dropping it
    // silently — which is what used to happen — meant an agent could run its whole life and leave
    // no trace in the room it ran in.
    const e = officeOf('main', ...fullHouse());
    e.apply({ op: 'ensureActor', agentId: 'waiter' });
    e.apply({ op: 'ensureActor', agentId: 'waiter2' });
    expect(e.offsite()).toEqual(['waiter', 'waiter2']);

    e.apply({ op: 'done', agentId: 'waiter', ok: true });
    expect(e.offsite(), 'it leaves the queue for a chair it no longer needs').toEqual(['waiter2']);

    const after = tickUntil(e, 90_000, (st) => stateOf(st, 'waiter').lounging === true);
    expectAt(stateOf(after, 'waiter'), loungeSpot(0));
    // …and it took nobody's desk on the way.
    expect(stateOf(after, 'waiter').deskIndex).toBe(LOUNGE_DESK_INDEX);
    expect(e.offsite()).toEqual(['waiter2']);
  });

  it('does not put a retired agent back at a desk when a late event arrives for it', () => {
    // `usage` and stray `agentText` keep arriving after an agent's `agentDone`. Re-seating on one
    // of those would take a chair off somebody who is still working.
    const e = officeOf('main', 'alpha', 'beta');
    e.apply({ op: 'done', agentId: 'alpha', ok: true });
    const settled = tickUntil(e, 60_000, (st) => stateOf(st, 'alpha').lounging === true);
    const spot = { x: stateOf(settled, 'alpha').x, y: stateOf(settled, 'alpha').y };

    e.apply({ op: 'status', agentId: 'alpha', text: '9.9k tok' });
    e.apply({ op: 'deliver', agentId: 'alpha', to: 'main', text: 'one more thing' });
    const st = e.tick(500);
    expect(stateOf(st, 'alpha').deskIndex).toBe(LOUNGE_DESK_INDEX);
    expectAt(stateOf(st, 'alpha'), spot);
    // It still gets to say the thing, where it stands.
    expect(stateOf(st, 'alpha').say).toBe('one more thing');
    expect(e.offsite()).toEqual([]);
  });

  it('reports a new seating revision only when the floor or the queue actually changes', () => {
    const e = new Engine();
    const r0 = e.seating();
    e.apply({ op: 'ensureActor', agentId: 'alpha' });
    const r1 = e.seating();
    expect(r1).not.toBe(r0);

    e.tick(2000);
    e.apply({ op: 'think', agentId: 'alpha', text: 'hm' });
    e.tick(2000);
    expect(e.seating()).toBe(r1); // walking, thinking and sitting down are not seating changes

    // Retiring gives up a chair, which is a seating change even though nobody left the room.
    e.apply({ op: 'done', agentId: 'alpha', ok: true });
    expect(e.seating()).not.toBe(r1);
  });

  it('lets a departing agent still say the line it was carrying', () => {
    const e = officeOf('main', 'alpha');
    e.apply({ op: 'done', agentId: 'alpha', ok: false });
    e.apply({ op: 'confront', agentId: 'alpha', to: 'main', text: 'REFUTED', verdict: 'err' });
    const s = stateOf(e.tick(STEP_MS), 'alpha');
    expect(s.say).toBe('REFUTED');
    expect(s.verdict).toBe('err');
  });
});

// --- determinism -------------------------------------------------------------------------

describe('Engine — determinism', () => {
  const script = (e: Engine): ActorState[][] => {
    const frames: ActorState[][] = [];
    const cmds: Cmd[] = [
      { op: 'ensureActor', agentId: 'main' },
      { op: 'ensureActor', agentId: 'alpha' },
    ];
    for (const c of cmds) e.apply(c);
    frames.push(e.tick(17));

    e.apply({ op: 'think', agentId: 'alpha', text: 'hm' });
    frames.push(e.tick(2500));

    e.apply({ op: 'deliver', agentId: 'alpha', to: 'main', text: 'found it' });
    for (let i = 0; i < 40; i++) frames.push(e.tick(333));

    e.apply({ op: 'confront', agentId: 'alpha', to: 'beta', text: 'REFUTED', verdict: 'err' });
    e.apply({ op: 'tool', agentId: 'beta', id: 'b1', tool: 'Bash', act: 'run' });
    e.apply({ op: 'spawn', agentId: 'main', child: 'pending', prompt: 'go and look', toolUseId: 'tu9' });
    e.apply({ op: 'ensureActor', agentId: 'gamma', parentToolUseId: 'tu9' });
    for (let i = 0; i < 20; i++) frames.push(e.tick(211));
    e.apply({ op: 'toolEnd', agentId: 'beta', id: 'b1', ok: false });
    e.apply({ op: 'done', agentId: 'gamma', ok: true });
    for (let i = 0; i < 20; i++) frames.push(e.tick(211));
    return frames;
  };

  it('produces identical states for the same command and tick sequence', () => {
    expect(script(new Engine())).toEqual(script(new Engine()));
  });

  it('shrugs off a non-finite delta instead of being poisoned by it', () => {
    // A dropped rAF frame or a bad clock read must not be able to end the simulation: NaN or
    // Infinity through the clock would make every position NaN from then on, with no recovery.
    const withGarbage = new Engine();
    const clean = new Engine();
    for (const e of [withGarbage, clean]) {
      e.apply({ op: 'ensureActor', agentId: 'main' });
      e.apply({ op: 'ensureActor', agentId: 'alpha' });
      e.apply({ op: 'deliver', agentId: 'alpha', to: 'main', text: 'found it' });
    }
    withGarbage.tick(NaN);
    withGarbage.tick(Number.POSITIVE_INFINITY);
    withGarbage.tick(Number.NEGATIVE_INFINITY);

    expect(withGarbage.tick(16)).toEqual(clean.tick(16));
    expect(withGarbage.tick(4000)).toEqual(clean.tick(4000));
    expect(stateOf(withGarbage.tick(0), 'alpha').x).not.toBeNaN();
  });

  it('lands exactly on an anchor whatever the tick granularity', () => {
    // Positions are integrated per segment, so a coarse or ragged frame rate must not leave an
    // actor a fraction of a pixel short of the anchor the ±1px contract is measured against.
    for (const dt of [1, 7, 250, 1000]) {
      const e = officeOf('main', 'alpha');
      e.apply({ op: 'deliver', agentId: 'alpha', to: 'main', text: 'found it' });
      let arrived: ActorState | undefined;
      for (let t = 0; t < 30_000 && !arrived; t += dt) {
        const s = stateOf(e.tick(dt), 'alpha');
        if (s.pose === 'stand') arrived = s;
      }
      expect(arrived, `never arrived at dt=${dt}`).toBeDefined();
      expect({ x: arrived?.x, y: arrived?.y }).toEqual(WAYPOINTS.managerStand);
    }
  });

  it('returns a fresh snapshot each tick, so earlier frames never mutate', () => {
    const e = officeOf('main', 'alpha');
    e.apply({ op: 'deliver', agentId: 'alpha', to: 'main', text: 'found it' });

    const before = stateOf(e.tick(500), 'alpha');
    const x = before.x;
    e.tick(2000);
    expect(before.x).toBe(x);
  });
});

// --- waypoint routing --------------------------------------------------------------------

describe('route', () => {
  it('reaches the coffee corner up the west aisle, never across the pods', () => {
    // Slot 8 is the left bank's bottom row, which is below the lane's turn — the case the aisle
    // was drawn for: seat → out to the aisle at your own row → up the lane → the machine.
    expect(route(podSeat(8), WAYPOINTS.coffee)).toEqual([
      { x: WAYPOINTS.aisleWestX, y: podSeat(8).y },
      WAYPOINTS.coffeeLane,
      WAYPOINTS.coffee,
    ]);
  });

  it('never joins the aisle north of its turn, even from a desk that sits above it', () => {
    // The top row is above the lane's turn, so joining the aisle at its own row would put the
    // walker inside the kitchen counter. The route drops to the turn first instead.
    const top = podSeat(0);
    expect(top.y).toBeLessThan(WAYPOINTS.coffeeLane.y);
    expect(route(top, WAYPOINTS.coffee)).toEqual([
      { x: WAYPOINTS.aisleWestX, y: WAYPOINTS.coffeeLane.y },
      WAYPOINTS.coffeeLane,
      WAYPOINTS.coffee,
    ]);
  });

  it('walks the coffee lane back out the same way', () => {
    expect(route(WAYPOINTS.coffee, podSeat(8))).toEqual([
      WAYPOINTS.coffeeLane,
      { x: WAYPOINTS.aisleWestX, y: podSeat(8).y },
      podSeat(8),
    ]);
  });

  it('approaches the roundtable from its west lane, not over the table', () => {
    expect(route(podSeat(1), WAYPOINTS.tableW)).toEqual([WAYPOINTS.tableLane, WAYPOINTS.tableW]);
    expect(route(WAYPOINTS.tableS, podSeat(1))).toEqual([WAYPOINTS.tableLane, podSeat(1)]);
  });

  it('steps down from the door into the room before crossing it', () => {
    expect(route(WAYPOINTS.door, podSeat(0))).toEqual([WAYPOINTS.doorLane, podSeat(0)]);
  });

  it('goes straight when no anchor asks for a lane', () => {
    expect(route(podSeat(0), WAYPOINTS.managerStand)).toEqual([WAYPOINTS.managerStand]);
  });
});
