import { describe, expect, it } from 'vitest';
import type { Cmd } from '../src/office/mapping';
import {
  BUBBLE_MS,
  Engine,
  MANAGER_DESK_INDEX,
  POD_ROW_STEP_Y,
  SETTLE_MS,
  WAYPOINTS,
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

  it('extends the pod grid by rows past the fourth slot', () => {
    expect(podSeat(4)).toEqual({ x: podSeat(0).x, y: podSeat(0).y + POD_ROW_STEP_Y });
    expect(podSeat(5)).toEqual({ x: podSeat(1).x, y: podSeat(1).y + POD_ROW_STEP_Y });
    expect(podSeat(8)).toEqual({ x: podSeat(0).x, y: podSeat(0).y + 2 * POD_ROW_STEP_Y });
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
    expect(podVisitorSpot(1)).toEqual({ x: 584, y: 360 }); // SPOT.nearFinder, in scene pixels
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
    e.apply({ op: 'workBurst', agentId: 'alpha', label: 'Read src/a.ts' });

    const working = stateOf(e.tick(STEP_MS), 'alpha');
    expect(working.status).toBe('Read src/a.ts');
    expect(working.pose).toBe('sit');

    e.apply({ op: 'status', agentId: 'alpha', text: '12.3k tok' });
    expect(stateOf(e.tick(STEP_MS), 'alpha').status).toBe('12.3k tok');
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
    e.apply({ op: 'workBurst', agentId: 'beta', label: 'Bash' });
    for (let i = 0; i < 40; i++) frames.push(e.tick(211));
    return frames;
  };

  it('produces identical states for the same command and tick sequence', () => {
    expect(script(new Engine())).toEqual(script(new Engine()));
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
    // The mockup's own coffee run: seat → {x:8,y:64.2} → {x:6.5,y:44} → coffee.
    expect(route(podSeat(2), WAYPOINTS.coffee)).toEqual([
      { x: WAYPOINTS.aisleWestX, y: podSeat(2).y },
      WAYPOINTS.coffeeLane,
      WAYPOINTS.coffee,
    ]);
  });

  it('walks the coffee lane back out the same way', () => {
    expect(route(WAYPOINTS.coffee, podSeat(2))).toEqual([
      WAYPOINTS.coffeeLane,
      { x: WAYPOINTS.aisleWestX, y: podSeat(2).y },
      podSeat(2),
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
