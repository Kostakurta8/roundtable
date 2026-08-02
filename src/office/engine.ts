/**
 * The office simulation: behavior only, no pixels. `Cmd`s from `mapping.ts` go in, a fresh
 * `ActorState[]` comes out of every `tick`, and Task 10 draws exactly what the array says.
 *
 * Time enters this module through one door — the `dtMs` handed to `tick`. Nothing here reads
 * the wall clock, touches the DOM, or rolls a die, so the same commands interleaved with the
 * same tick sequence always produce byte-identical states. That is what lets a recorded
 * session be replayed, scrubbed, or diffed later without the office drifting.
 *
 * Coordinates are in the fixed 1600x900 scene basis and were transcribed from the approved
 * mockup, `docs/mockup/office-sim-v5.html` — see WAYPOINTS for the per-anchor provenance. The
 * renderer scales that basis to whatever the viewport is; the engine never knows.
 */
import type { Cmd } from './mapping';

export type Pose = 'sit' | 'walk' | 'stand';

export type Pt = { readonly x: number; readonly y: number };

/**
 * One actor as the renderer needs it.
 *
 * `flip` and `away` are the mockup's two facing bits, kept verbatim so Task 10 can map them
 * straight onto its `.flip` / `.away` classes: `flip` means mirrored horizontally, i.e. facing
 * *left*; `away` means back to camera. Sitting implies `away` (you face your screen), standing
 * implies neither (you turn to the room to speak), and walking sets whichever the dominant
 * axis of the current segment calls for.
 */
export type ActorState = {
  id: string;
  x: number;
  y: number;
  pose: Pose;
  flip: boolean;
  away: boolean;
  say?: string;
  /** Set only while a confront's line is on screen, so the renderer can tint that bubble. */
  verdict?: 'ok' | 'err';
  think?: string;
  status: string;
  deskIndex: number;
};

/** The scene basis every coordinate below is expressed in. */
export const SCENE = { w: 1600, h: 900 } as const;

/** Mockup walk speed (`seg(a, wp, 150)`), read as scene pixels per second. */
export const SPEED_PX_PER_S = 150;

/** How long a speech or thought bubble stays up, in tick time. */
export const BUBBLE_MS = 5000;

/** The pause an actor holds at the far end of a trip, from the mockup's beat between lines. */
export const SPEAK_HOLD_MS = 2500;

/**
 * A beat spent in the chair at the end of a trip. Without it an actor holding two queued trips
 * lands on its seat and turns on its heel inside a single tick — it never renders as seated,
 * and the two trips read as one long wander. Short enough that a busy agent barely lags.
 */
export const SETTLE_MS = 600;

/** `main` sits at the manager desk, which is not part of the pod grid. */
export const MANAGER_DESK_INDEX = -1;

/**
 * Pod slots past the mockup's four run as a 2-wide grid down the room. The pitch clears the
 * ~54px actor height (`.person`, mockup line 208) so rows never overlap.
 */
export const POD_ROW_PITCH_Y = 90;

/** The lowest a desk may sit — below this an actor would walk off the bottom of the scene. */
export const POD_ROW_MAX_Y = 780;

/**
 * Rows that would fall past `POD_ROW_MAX_Y` all share that row, so they are fanned sideways
 * instead. 54px because two clamped rows are separated by the fan alone and the grid must stay
 * ≥50px apart; and because the column gap (224px) is not a whole multiple of it, so column 0 of
 * one overflow row can never land exactly on column 1 of another. Past ~12 actors this is a
 * holding pattern, not a layout — design spec §3.3 calls for a hot-desk overflow there.
 */
export const POD_OVERFLOW_FAN_X = 54;

/** The orchestrator's id, as `mapping.ts` emits it. */
const MAIN_ID = 'main';

/** Transcribes a mockup percentage pair into the scene basis. */
const pct = (x: number, y: number): Pt => ({ x: (x / 100) * SCENE.w, y: (y / 100) * SCENE.h });

/**
 * Named anchors, all lifted from `docs/mockup/office-sim-v5.html` except the door, which the
 * mockup does not have (it never spawns anyone — the five agents are simply already seated).
 * Line references are to that file.
 */
export const WAYPOINTS = {
  /** `SEAT.main` (line 595) — the orchestrator's chair at the manager desk. */
  managerSeat: pct(61, 32.2),

  /** `SEAT.explore` / `.finder` / `.verifya` / `.verifyb` (591-594) — the four pod chairs. */
  podSeats: [pct(16.5, 34.2), pct(30.5, 34.2), pct(16.5, 64.2), pct(30.5, 64.2)] as readonly Pt[],

  /**
   * The floor in front of the manager desk — the mockup's own `{x:61, y:42}` (708, 729), which
   * main steps out to on its way to the roundtable. It doubles as the spot a visitor stands on
   * to deliver, so deliveries land exactly where the mockup already walks.
   */
  managerStand: pct(61, 42),

  /**
   * Where a visitor stands relative to a pod chair: `SPOT.nearFinder` (598) minus
   * `SEAT.finder` (592). Applied to any pod seat, it reproduces `nearFinder` for slot 1.
   */
  podStandOffset: pct(6, 5.8),

  /** The aisle down the left of the pod block — x of the mockup's `{x:8, y:64.2}` (717, 720). */
  aisleWestX: pct(8, 0).x,

  /** `{x:6.5, y:44}` (717, 720) — the turn onto the kitchen corner, halfway up the west aisle. */
  coffeeLane: pct(6.5, 44),

  /** `SPOT.coffee` (603) — at the machine. */
  coffee: pct(6.5, 25),

  /** `SPOT.tableN` / `.tableW` / `.tableE` / `.tableS` (599-602) — the four roundtable places. */
  tableN: pct(63.5, 62),
  tableW: pct(55, 74),
  tableE: pct(72, 74),
  tableS: pct(63.5, 79),

  /** `{x:51, y:68}` (706) — the west approach to the rug, so nobody crosses the table itself. */
  tableLane: pct(51, 68),

  /**
   * DERIVED, not in the mockup: the office door. Placed in the one clear stretch of the back
   * wall — right of the third window (which ends at 70%) and left of the chat panel's edge
   * (~76% at this basis) — at the y where the baseboard meets the floor (13.1%, line 48).
   */
  door: pct(73, 13.5),

  /** DERIVED: one step into the room from the door, so arrivals never clip the manager desk. */
  doorLane: pct(73, 42),
} as const;

/**
 * The seat for pod slot `slot`, 0-based.
 *
 * Slots 0-3 are the mockup's own four chairs, verbatim. Past those the pods continue as the
 * same two columns (`col = slot % 2`) one row at a time (`row = slot / 2`), each row a pitch
 * below the mockup's second row — which is exactly how slots 0-3 are already laid out, so the
 * grid reads as one grid. Rows that would fall off the bottom of the room are pinned to the
 * last usable row and fanned sideways instead, so a big roster crowds rather than stacks.
 */
export function podSeat(slot: number): Pt {
  const seats = WAYPOINTS.podSeats;
  if (slot < seats.length) return seats[slot];

  const col = slot % 2;
  const row = Math.floor(slot / 2);
  const base = seats[2 + col]; // the mockup's second row, which is row 1 of the grid
  const y = base.y + (row - 1) * POD_ROW_PITCH_Y;
  const clampedRows = Math.max(0, Math.ceil((y - POD_ROW_MAX_Y) / POD_ROW_PITCH_Y));
  return { x: base.x + clampedRows * POD_OVERFLOW_FAN_X, y: Math.min(y, POD_ROW_MAX_Y) };
}

// --- routing -----------------------------------------------------------------------------

const EPS = 1e-9;

/** The kitchen corner: left of the pod columns (11%) and above their top edge (29%). */
const KITCHEN = { maxX: pct(11, 0).x, maxY: pct(0, 29).y };

/** The round rug, `.rug-round` (line 393): left 54.5%, top 57%, 18% wide, 29% tall. */
const RUG = { x0: pct(54.5, 0).x, x1: pct(72.5, 0).x, y0: pct(0, 57).y, y1: pct(0, 86).y };

/** The band along the back wall. Of every anchor above, only the door sits in it. */
const WALL_BAND_MAX_Y = pct(0, 22).y;

const inKitchen = (p: Pt): boolean => p.x < KITCHEN.maxX && p.y < KITCHEN.maxY;
const onRug = (p: Pt): boolean => p.x >= RUG.x0 && p.x <= RUG.x1 && p.y >= RUG.y0 && p.y <= RUG.y1;
const atWall = (p: Pt): boolean => p.y < WALL_BAND_MAX_Y;

/**
 * The waypoints between open floor and `p`, ordered *outward* from `p`. Only the three corners
 * of the room that furniture blocks have one; everywhere else is crossed in a straight line.
 * `other` is the far end of the trip: it supplies the row the west aisle is joined at, and it
 * suppresses the lane when both ends are already inside the same zone.
 */
function lanesOf(p: Pt, other: Pt): Pt[] {
  if (inKitchen(p) && !inKitchen(other)) {
    // Down the west aisle at the far end's own row — but never north of the lane's turn, which
    // would put the aisle point inside the kitchen counter.
    return [WAYPOINTS.coffeeLane, { x: WAYPOINTS.aisleWestX, y: Math.max(other.y, WAYPOINTS.coffeeLane.y) }];
  }
  if (onRug(p) && !onRug(other)) return [WAYPOINTS.tableLane];
  if (atWall(p) && !atWall(other)) return [WAYPOINTS.doorLane];
  return [];
}

/**
 * The fixed waypoint route from `from` to `to`, excluding `from` and ending on `to`: leave the
 * zone `from` sits in, enter the zone `to` sits in, arrive. One to four points — no search, no
 * state, no obstacle map, so the same pair always yields the same path.
 */
export function route(from: Pt, to: Pt): Pt[] {
  const path = [...lanesOf(from, to), ...lanesOf(to, from).reverse(), to];
  const out: Pt[] = [];
  let prev = from;
  for (const p of path) {
    if (Math.hypot(p.x - prev.x, p.y - prev.y) > EPS) out.push(p);
    prev = p;
  }
  return out;
}

// --- actors ------------------------------------------------------------------------------

type Verdict = 'ok' | 'err';

type Step =
  | { readonly kind: 'walk'; readonly to: Pt }
  | { readonly kind: 'hold'; ms: number }
  | { readonly kind: 'say'; readonly text: string; readonly verdict?: Verdict }
  | { readonly kind: 'pose'; readonly pose: Pose };

type Actor = {
  readonly id: string;
  readonly deskIndex: number;
  x: number;
  y: number;
  pose: Pose;
  flip: boolean;
  away: boolean;
  status: string;
  say?: string;
  verdict?: Verdict;
  sayUntil: number;
  think?: string;
  thinkUntil: number;
  queue: Step[];
};

const seatOf = (a: Actor): Pt =>
  a.deskIndex === MANAGER_DESK_INDEX ? WAYPOINTS.managerSeat : podSeat(a.deskIndex);

/** The floor spot an actor steps onto when it leaves its own chair. */
const deskFront = (a: Actor): Pt => {
  if (a.deskIndex === MANAGER_DESK_INDEX) return WAYPOINTS.managerStand;
  const seat = seatOf(a);
  return { x: seat.x, y: seat.y + WAYPOINTS.podStandOffset.y };
};

/** The floor spot a *visitor* stands on to talk to this actor. */
const visitorSpot = (a: Actor): Pt => {
  if (a.deskIndex === MANAGER_DESK_INDEX) return WAYPOINTS.managerStand;
  const seat = seatOf(a);
  return { x: seat.x + WAYPOINTS.podStandOffset.x, y: seat.y + WAYPOINTS.podStandOffset.y };
};

/** The mockup's rule (`seg`, line 626): the dominant axis decides which facing bit is set. */
function face(a: Actor, dx: number, dy: number): void {
  if (Math.abs(dx) >= Math.abs(dy)) {
    a.flip = dx < 0;
    a.away = false;
  } else {
    a.flip = false;
    a.away = dy < 0;
  }
}

const walkSteps = (path: readonly Pt[]): Step[] => path.map((to) => ({ kind: 'walk', to }));

/** The tail every queued sequence ends with: into the chair, and stay there for a beat. */
const sitDown = (a: Actor): Step[] => [
  { kind: 'walk', to: seatOf(a) },
  { kind: 'pose', pose: 'sit' },
  { kind: 'hold', ms: SETTLE_MS },
];

export class Engine {
  /** Spawn order, which is also the order `tick` reports in. */
  private readonly order: Actor[] = [];
  private readonly byId = new Map<string, Actor>();
  private podCount = 0;
  private clock: number;

  /**
   * `now` seeds the clock's origin and is never called again — every later instant comes from
   * accumulated `tick` time, which is what keeps two engines fed the same script identical.
   */
  constructor(now?: () => number) {
    this.clock = now ? now() : 0;
  }

  apply(cmd: Cmd): void {
    // Every handler goes through `ensure`: a truncated backlog can hand us a `think` or a
    // `deliver` for an agent whose `agentSeen` scrolled off the wire, and the office would
    // rather walk a stranger in from the door than drop the event.
    const a = this.ensure(cmd.agentId);
    switch (cmd.op) {
      case 'ensureActor':
        return;
      case 'think':
        a.think = cmd.text;
        a.thinkUntil = this.clock + BUBBLE_MS;
        return;
      case 'workBurst':
        a.status = cmd.label;
        return;
      case 'status':
        a.status = cmd.text;
        return;
      case 'deliver':
      case 'confront':
        // A delivery is just a report; only a confront carries a verdict to colour.
        this.trip(a, this.ensure(cmd.to), cmd.text, cmd.op === 'confront' ? cmd.verdict : undefined);
        return;
    }
  }

  tick(dtMs: number): ActorState[] {
    // A non-finite delta is unrecoverable if it lands: NaN or Infinity poisons the clock, and
    // from then on every position, every bubble deadline, and every future tick is ruined. A
    // dropped frame is the honest reading of "no usable delta", so treat it as no time passing.
    const dt = Number.isFinite(dtMs) ? Math.max(0, dtMs) : 0;
    const t0 = this.clock;
    for (const a of this.order) this.advance(a, t0, dt);
    this.clock = t0 + dt;
    for (const a of this.order) {
      if (a.say !== undefined && a.sayUntil <= this.clock) {
        a.say = undefined;
        a.verdict = undefined; // the tint belongs to the bubble, not to the actor
      }
      if (a.think !== undefined && a.thinkUntil <= this.clock) a.think = undefined;
    }
    return this.order.map((a) => ({
      id: a.id,
      x: a.x,
      y: a.y,
      pose: a.pose,
      flip: a.flip,
      away: a.away,
      say: a.say,
      verdict: a.verdict,
      think: a.think,
      status: a.status,
      deskIndex: a.deskIndex,
    }));
  }

  private ensure(id: string): Actor {
    const found = this.byId.get(id);
    if (found) return found;

    const a: Actor = {
      id,
      deskIndex: id === MAIN_ID ? MANAGER_DESK_INDEX : this.podCount++,
      x: WAYPOINTS.door.x,
      y: WAYPOINTS.door.y,
      pose: 'walk',
      flip: false,
      away: false,
      status: '',
      sayUntil: 0,
      thinkUntil: 0,
      queue: [],
    };
    // Everyone arrives the same way: through the door, across the room, into their chair.
    const front = deskFront(a);
    a.queue = [...walkSteps(route(WAYPOINTS.door, front)), ...sitDown(a)];
    this.order.push(a);
    this.byId.set(id, a);
    return a;
  }

  /**
   * Queues a round trip: over to `target`'s desk, a line spoken standing there, then back to
   * one's own chair. Trips queue behind whatever the actor is already doing, so a burst of
   * events never teleports anyone mid-stride.
   */
  private trip(a: Actor, target: Actor, text: string, verdict?: Verdict): void {
    if (a === target) {
      // Nobody walks a note to their own desk; they just say it where they sit.
      a.say = text;
      a.verdict = verdict;
      a.sayUntil = this.clock + BUBBLE_MS;
      return;
    }
    const front = deskFront(a);
    const stand = visitorSpot(target);
    a.queue.push(
      { kind: 'walk', to: front },
      ...walkSteps(route(front, stand)),
      { kind: 'pose', pose: 'stand' },
      { kind: 'say', text, verdict },
      { kind: 'hold', ms: SPEAK_HOLD_MS },
      ...walkSteps(route(stand, front)),
      ...sitDown(a),
    );
  }

  /** Spends `dt` of this actor's time on its queue. `t0 + used` is the instant a step runs at. */
  private advance(a: Actor, t0: number, dt: number): void {
    let rem = dt;
    let used = 0;

    while (a.queue.length > 0) {
      const step = a.queue[0];

      // Instant steps run even on a zero-length tick, so an arrival never renders a frame of
      // "standing at your own chair" before it turns into sitting.
      if (step.kind === 'pose') {
        a.pose = step.pose;
        if (step.pose === 'sit') {
          a.away = true; // sitting is `sitting away` in the mockup: facing your screen
          a.flip = false;
        } else if (step.pose === 'stand') {
          a.away = false; // turned back to the room, still facing the way you walked in
        }
        a.queue.shift();
        continue;
      }
      if (step.kind === 'say') {
        a.say = step.text;
        a.verdict = step.verdict;
        a.sayUntil = t0 + used + BUBBLE_MS;
        a.queue.shift();
        continue;
      }

      if (step.kind === 'walk') {
        const dx = step.to.x - a.x;
        const dy = step.to.y - a.y;
        const dist = Math.hypot(dx, dy);
        if (dist <= EPS) {
          a.queue.shift();
          continue;
        }
        a.pose = 'walk';
        face(a, dx, dy);
        if (rem <= 0) break;
        const travel = (SPEED_PX_PER_S * rem) / 1000;
        if (travel < dist) {
          a.x += (dx / dist) * travel;
          a.y += (dy / dist) * travel;
          used += rem;
          rem = 0;
          break;
        }
        // Land exactly on the anchor rather than within a float of it: every later segment
        // starts from the table's own numbers, so a long trip cannot accumulate drift.
        a.x = step.to.x;
        a.y = step.to.y;
        const ms = (dist / SPEED_PX_PER_S) * 1000;
        used += ms;
        rem -= ms;
        a.queue.shift();
        continue;
      }

      if (rem <= 0) break;
      if (rem < step.ms) {
        step.ms -= rem;
        used += rem;
        rem = 0;
        break;
      }
      used += step.ms;
      rem -= step.ms;
      a.queue.shift();
    }
  }
}
