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
import type { Cmd, ToolAct } from './mapping';

export type Pose = 'sit' | 'walk' | 'stand';

export type Pt = { readonly x: number; readonly y: number };

/**
 * One actor as the renderer needs it.
 *
 * `flip` and `away` are the mockup's two facing bits, kept verbatim so the renderer can map them
 * onto its own facing: `flip` means mirrored horizontally, i.e. facing *left*; `away` means back
 * to camera. Sitting implies `away` (you face your screen), standing implies neither (you turn to
 * the room to speak), and walking sets whichever the dominant axis of the current segment calls
 * for.
 *
 * Everything below `deskIndex` is what the widened command seam brought in. The rule for what
 * belongs here is narrow on purpose: a field earns its place by being something only the *stream*
 * knows — which tool is open, how the last one ended, whether this agent has finished. Anything
 * the renderer could work out from a position, a pose and its own memory of the last frame is
 * deliberately not here, because the engine is the thing replay has to reproduce exactly and
 * every field is one more thing that can drift.
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

  /** The shape of the work in progress, from the most recently opened tool call. */
  act?: ToolAct;
  /** The raw tool name and target behind `act` — for the label and the monitor's contents. */
  tool?: string;
  target?: string;
  /** Tool calls opened and not yet resolved. `0` is the honest test for "not working". */
  busy: number;
  /** Of those, the ones that are `Task` calls: this agent is waiting on children. */
  waiting: number;
  /** How the last resolved call ended, or `undefined` before any has. */
  lastOk?: boolean;
  /** Consecutive failures. A success clears it; a desk that keeps failing accumulates it. */
  fails: number;
  /** Total resolved calls, monotonic — the renderer diffs it to catch the moment of a result. */
  resolved: number;
  /** The file most recently changed, and how many changes this agent has made. */
  edit?: string;
  edits: number;
  /** Set once this agent's `agentDone` has landed. */
  done?: boolean;
  doneOk?: boolean;
  /** The agent that spawned this one, once the child's sidecar has joined the two halves. */
  parent?: string;
  /** A fresh parent→child edge, on the *parent*, for the couple of seconds a spawn line lives. */
  link?: { child: string; label: string };
  /** An instruction addressed to this agent — the human's, or its parent's brief. */
  heard?: string;
  /**
   * Finished, and off to the break corner rather than out of the building.
   *
   * `lounging` is the arrival: it has got there and stopped. The two are separate because the walk
   * over is several seconds long and the renderer draws those seconds very differently from what
   * happens afterwards.
   */
  retired?: boolean;
  lounging?: boolean;
  /** Which place in the corner it was given — the renderer reads it to know stool from couch. */
  loungeSlot?: number;
};

/** The scene basis every coordinate below is expressed in. */
export const SCENE = { w: 1600, h: 900 } as const;

/** Mockup walk speed (`seg(a, wp, 150)`), read as scene pixels per second. */
export const SPEED_PX_PER_S = 150;

/** How long a speech or thought bubble stays up, in tick time. */
export const BUBBLE_MS = 5000;

/**
 * How long a parent→child spawn edge stays on screen.
 *
 * Long enough to be read from across the room, short enough that a workflow fanning out forty
 * agents does not end up as a permanent cat's cradle over the floor.
 */
export const LINK_MS = 2200;

/** How long an agent shows the instruction it was just handed. */
export const HEARD_MS = 4000;

/** The pause an actor holds at the far end of a trip, from the mockup's beat between lines. */
export const SPEAK_HOLD_MS = 2500;

/**
 * A beat spent in the chair at the end of a trip. Without it an actor holding two queued trips
 * lands on its seat and turns on its heel inside a single tick — it never renders as seated,
 * and the two trips read as one long wander. Short enough that a busy agent barely lags.
 */
export const SETTLE_MS = 600;

/**
 * How many trips an actor may hold: the one it is walking, plus one waiting behind it.
 *
 * Two rather than one because the queue still contains the trip currently being walked — a cap of
 * one would let every new message overwrite the line an actor was on its way to deliver, and the
 * room would only ever show the latest thing said, never a completed errand. Two keeps the
 * hand-off visible while still bounding the queue; see `Engine.trip`.
 */
export const MAX_QUEUED_TRIPS = 2;

/**
 * How many agents have to be exchanging before the room gathers at the roundtable.
 *
 * The design doc's own number (§3.2: "≥3 agents exchanging within a window / workflow phase
 * barrier → huddle at roundtable"). Two agents talking is already fully drawn by the trip one of
 * them walks to the other's desk; three is the point at which the picture needs a table.
 */
export const HUDDLE_MIN = 3;

/**
 * The window those exchanges have to fall inside to count as one conversation.
 *
 * Deliberately not a fresh magic number: it is exactly how long one spoken line lives in this room
 * — the beat a speaker holds standing at the far desk, plus the bubble's own five seconds. So
 * "clustered in tick time" means the third agent speaks while the first one's line could still be
 * on screen, which is the only reading of the phrase a viewer can check against the picture.
 *
 * Shorter and a fan-out whose children report a few seconds apart never counts as a conversation,
 * which is the single most common shape a real session has. Longer and three unrelated reports a
 * minute apart drag half the room to the table.
 */
export const HUDDLE_WINDOW_MS = SPEAK_HOLD_MS + BUBBLE_MS;

/**
 * The beat a huddle holds at the table.
 *
 * It has to outlast the spread in arrival times, or the first person there would be walking away
 * as the last one arrived and the meeting would never be a group. At `SPEED_PX_PER_S` the walk
 * from the manager desk to the rug is about 3.3s and the walk from the far right bank is about
 * 6.1s, so four seconds covers the worst pair that sets off together.
 *
 * It cannot cover an arbitrary spread, and does not try: a participant that was mid-errand when
 * the meeting was called walks its errand first and may arrive to an empty table. Holding the
 * table until everybody made it would be a barrier, and a barrier deadlocks the first time a
 * participant finishes and walks out of the building instead of turning up.
 */
export const HUDDLE_HOLD_MS = 4000;

/**
 * How long an agent must have had nothing to do — no open tool call, nothing queued, nothing said
 * — before it goes for coffee. The design doc's own threshold (§3.2: "Idle > 90s while others
 * run → coffee walk (decorative)").
 */
export const IDLE_COFFEE_MS = 90_000;

/**
 * The beat spent at the machine.
 *
 * The walk is the whole picture here: from the right-hand bank the coffee corner is over ten
 * seconds away at `SPEED_PX_PER_S`, each way. The hold only has to be long enough that the actor
 * is *seen* at the machine rather than bouncing off it, so it is the same four seconds a huddle
 * holds — two pauses with nothing said, and a second number here would have nothing behind it.
 */
export const COFFEE_HOLD_MS = HUDDLE_HOLD_MS;

/** `main` sits at the manager desk, which is not part of the pod grid. */
export const MANAGER_DESK_INDEX = -1;

/** Nobody's desk: an agent the office knows about and has no chair for. */
export const OFFSITE_DESK_INDEX = -2;

/** Finished, and standing about in the break corner rather than at a desk. */
export const LOUNGE_DESK_INDEX = -3;

/**
 * How many finished agents the break corner will hold before the rest stay off-site.
 *
 * A session fans out forty agents and every one of them eventually finishes. Walking all forty
 * into one corner of a 480-pixel room is not "the team took a break", it is a crowd scene with the
 * office somewhere behind it. Past this they stay in the strip along the bottom, marked done —
 * still counted, still named, still nothing pretending they never existed.
 */
export const LOUNGE_CAPACITY = 12;

/**
 * The beat a finished agent holds at its desk before it stands up and goes.
 *
 * Without it a `done` that lands on the same frame as the agent's last line would erase the
 * bubble mid-sentence, and a workflow that finishes six children at once would empty half the
 * room inside a single tick — which reads as a glitch, not as people leaving.
 */
export const DONE_LINGER_MS = 1800;

/**
 * How much of that beat is spread across people, so they do not all stand up together.
 *
 * A workflow finishes six children within a second of each other, and with a fixed linger all six
 * pushed their chairs back on the same frame and crossed the floor in formation — which is the
 * single most mechanical thing the room did. Seeded per agent, so it is still deterministic.
 */
export const DONE_LINGER_SPREAD_MS = 4200;

/**
 * How far a person's walking pace may sit either side of the room's own speed.
 *
 * Everybody moved at exactly `SPEED_PX_PER_S`, which is what made a crowd read as one animation
 * however carefully the *cycle* was varied: two people setting off together arrived together, in
 * step, every time. A sixth either way is enough to break that up and small enough that nobody
 * reads as hurrying.
 */
export const PACE_SPREAD = 0.17;

/** How far apart arrivals are spread when a backlog hands the office a whole cast at once. */
export const ARRIVE_STAGGER_MS = 2600;

/**
 * The vertical pitch between desk rows.
 *
 * It was 90, which is what the mockup used, and at the renderer's scale that is 27 pixels for a
 * workstation that is 55 tall — every row was drawn through the row above it, and the left of the
 * room became an unreadable stack of monitors and nameplates while the right half stayed empty.
 * 187 is the smallest pitch that clears a whole workstation: desk, screen, occupant and chair.
 */
export const POD_ROW_PITCH_Y = 187;

/** The lowest a desk may sit — below this an actor would walk off the bottom of the scene. */
export const POD_ROW_MAX_Y = 780;

/**
 * Rows that would fall past `POD_ROW_MAX_Y` all share that row, fanned sideways instead of
 * stacked.
 *
 * The pitch clears a whole workstation, not just a person. It was originally the ~54px actor
 * width, which satisfied `POD_MIN_SEAT_GAP` for the *people* but packed their desks — 9% of a
 * 1600px stage, so 144px wide — at a third of their own width, and the overflow lane rendered as
 * a pile of monitors with the nameplates written over each other.
 */
export const POD_OVERFLOW_FAN_X = 150;

/** No two desks may come closer than this. The overflow layout exists to keep it true. */
export const POD_MIN_SEAT_GAP = 50;

/**
 * How many people the room will seat, `main` included.
 *
 * Exactly the twelve desks the floor plan draws, plus the orchestrator at the manager desk. A
 * single `Workflow` call spawns forty-odd agents, and drawing all of them produced a wall of desks
 * running off the right edge with a crowd stacked around the roundtable — every face overlapping
 * every other, which is worse than not drawing them at all.
 *
 * Nobody is ever teleported out of a chair to make room: a seat is given up only by the agent
 * holding it, and only when that agent has finished and walked out through the door. Everyone
 * waiting is still fully present in the roster, the feed, the tools panel and the totals, and the
 * renderer draws them along the bottom of the room as a strip of small avatars — off the floor,
 * but never off the screen. The queue is first-in-first-served, so the agent that has been waiting
 * longest is the one that takes the next free chair.
 */
export const MAX_SEATS = 13;

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

  /**
   * The twelve pod chairs, as two banks of six against the left and right walls.
   *
   * The mockup had four, in two columns on the left, and everything past them continued down the
   * same two columns — which put ten workstations into the left third of a room whose right half
   * was bare floor, each drawn through the one above it. Two banks with the floor open between
   * them is how an office is actually laid out, it reads at a glance, and it leaves the middle for
   * the roundtable and the walking.
   *
   * Filled a row at a time and alternating sides, so a session with only a handful of agents comes
   * out balanced across the room rather than piling everyone into one corner while the other half
   * stays bare. Six agents land as three and three along the top two rows.
   *
   * The left bank sits at 23% and 34% rather than the original 13.75% and 26.7%. That whole
   * left-hand strip is now the **break corner** — the coffee machine, the water cooler, a café
   * table and a couch — because agents that finish no longer walk out of the building, they go and
   * stand around in it. A room that empties itself as the work completes is a room that tells you
   * less the longer you watch it.
   */
  podSeats: [
    pct(23, 37), pct(78.75, 37), pct(34, 37), pct(91.7, 37),
    pct(23, 57.8), pct(78.75, 57.8), pct(34, 57.8), pct(91.7, 57.8),
    pct(23, 78.5), pct(78.75, 78.5), pct(34, 78.5), pct(91.7, 78.5),
  ] as readonly Pt[],

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

  /**
   * The aisle down the left of the pod block.
   *
   * Moved from 8% to 16% when the left bank moved right: it has to run *between* the break corner
   * and the desks, or the route to the coffee machine walks straight through the café table.
   */
  aisleWestX: pct(16, 0).x,

  /**
   * The break corner, at the far left where the desks used to be.
   *
   * These are the places an agent stands or sits once its work is done. Order matters — it is the
   * order they fill up in, and the first four are the ones around the table, so a couple of
   * finished agents read as two people talking rather than as two people standing apart.
   */
  loungeTable: pct(7.9, 43.7),
  /**
   * Deliberately spread across the whole corner rather than packed around the table.
   *
   * A person is sixteen pixels wide and the corner is about sixty across, so places six pixels
   * apart put two bodies in the same space: unreadable to look at, and — because the accessible
   * layer sits exactly over the sprites — unclickable, with one agent's hit box swallowing its
   * neighbour's. Nine people in a small room will still overlap, and should; these are the widest
   * nine spacings that keep every one of them individually reachable.
   */
  loungeSpots: [
    pct(4.2, 44.4), // a stool, west of the table
    pct(11.7, 44.4), // a stool, east of the table
    pct(7.9, 37), // standing at the table, far side
    pct(7.9, 51.9), // standing at the table, near side
    pct(3.3, 31.1), // leaning by the counter
    pct(12.1, 32.6), // by the water cooler
    // In front of the couch rather than on it. There is no seated-on-a-couch pose — the only one
    // the renderer has brings its own stool with it — and a stool drawn through the middle of a
    // sofa is worse than two people standing beside one.
    pct(3.75, 61.5), // by the couch, left
    pct(9.6, 60.7), // by the couch, right
    pct(13.75, 54.8), // out by the ash stand, having a cigarette
  ] as readonly Pt[],

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
 * The four places at the roundtable, in the order a huddle fills them.
 *
 * North, then west, east and south. North is the place an agent coming from the manager desk or
 * either bank reaches off `tableLane` without crossing the rug, and taking the opposite sides
 * before the near ones keeps a three-person huddle from bunching along one edge of the table.
 *
 * Four is the floor plan's own number and it is a hard cap: thirteen agents can be in the room and
 * there is no fifth place. The surplus is not queued and not fanned around the rug — it simply
 * stays at its desk and keeps working, still in the roster, the feed and the totals, exactly as
 * the off-site strip is. Both alternatives were tried on paper and both read as a bug rather than
 * as a meeting: bodies standing *on* the table, or a ring of people at coordinates the floor plan
 * never drew furniture for.
 */
export const TABLE_PLACES: readonly Pt[] = [
  WAYPOINTS.tableN,
  WAYPOINTS.tableW,
  WAYPOINTS.tableE,
  WAYPOINTS.tableS,
];

/** The pod chairs the floor plan actually draws. `MAX_SEATS` is these plus the manager's. */
const POD_CAPACITY = WAYPOINTS.podSeats.length;

/** Where the overflow lane starts, clear of the left bank's own desks. */
const OVERFLOW_X0 = pct(22, 0).x;

/**
 * The seat for pod slot `slot`, 0-based.
 *
 * The first twelve are the floor plan itself, read straight out of the table. Nothing past them is
 * reachable while `MAX_SEATS` holds — the renderer draws the surplus as the off-site strip rather
 * than inventing floor for it — but the function still has to be total, because a truncated
 * backlog can hand the office an agent whose `agentSeen` scrolled off the wire. Those land on a
 * lane along the bottom of the room, marching right at a pitch that clears the plan's own desks.
 */
export function podSeat(slot: number): Pt {
  const seats = WAYPOINTS.podSeats;
  // Negative slots are the deskless sentinels — manager (-1), off-site (-2), lounge (-3) — not pod
  // indices, and asking this for one is a caller's mistake. It has to be caught here anyway,
  // because `slot < seats.length` is true for every negative number: `seats[-3]` is `undefined`,
  // `noUncheckedIndexedAccess` is off so the type says `Pt`, and the renderer dereferenced it on
  // every single `agentDone` — a retired agent keeps `pose: 'sit'` for its whole leaving beat while
  // `deskIndex` is already -3. Clamped rather than thrown because the only caller is inside a frame,
  // where a nameplate a few pixels wrong is a blemish and an exception is a room frozen mid-stride.
  if (slot <= 0) return seats[0];
  if (slot < seats.length) return seats[slot];
  const n = slot - seats.length;
  const room = Math.floor((SCENE.w - OVERFLOW_X0) / POD_OVERFLOW_FAN_X);
  return { x: OVERFLOW_X0 + (n % room) * POD_OVERFLOW_FAN_X, y: POD_ROW_MAX_Y };
}

// --- routing -----------------------------------------------------------------------------

const EPS = 1e-9;

/**
 * A place for a finished agent to stand, 0-based.
 *
 * The first nine are the break corner as it is actually drawn — two stools at the café table, two
 * standing places at it, the counter, the water cooler, both cushions of the couch, and the ash
 * stand. Past those the surplus fans down the left wall in rows, which is not furniture but is at
 * least people standing apart from each other rather than inside each other.
 */
export function loungeSpot(slot: number): Pt {
  const spots = WAYPOINTS.loungeSpots;
  if (slot < spots.length) return spots[slot];
  const n = slot - spots.length;
  return {
    x: pct(3.5, 0).x + (n % 3) * pct(4.6, 0).x,
    y: pct(0, 62).y + Math.floor(n / 3) * pct(0, 7).y,
  };
}

/** The kitchen corner: left of the pod columns (11%) and above their top edge (29%). */
const KITCHEN = { maxX: pct(11, 0).x, maxY: pct(0, 29).y };

/**
 * The break corner's floor: the left strip below the kitchen, where the desks used to be.
 *
 * It has a lane for the same reason the kitchen does — anything crossing between it and the desks
 * has to go through the aisle rather than diagonally over two rows of workstations.
 */
const LOUNGE = { maxX: pct(15, 0).x, minY: pct(0, 30).y };

/** The round rug, `.rug-round` (line 393): left 54.5%, top 57%, 18% wide, 29% tall. */
const RUG = { x0: pct(54.5, 0).x, x1: pct(72.5, 0).x, y0: pct(0, 57).y, y1: pct(0, 86).y };

/** The band along the back wall. Of every anchor above, only the door sits in it. */
const WALL_BAND_MAX_Y = pct(0, 22).y;

const inKitchen = (p: Pt): boolean => p.x < KITCHEN.maxX && p.y < KITCHEN.maxY;
const inLounge = (p: Pt): boolean => p.x < LOUNGE.maxX && p.y > LOUNGE.minY;
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
  if (inLounge(p) && !inLounge(other)) {
    // Out of the break corner sideways onto the aisle at your own row, then away. Diagonally is
    // straight through the left bank's monitors, which is where a finished agent was walking.
    return [{ x: WAYPOINTS.aisleWestX, y: p.y }];
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

/**
 * The two walks that carry nothing: a meeting at the roundtable, and a cup of coffee.
 *
 * Both are simulation rather than decoration — the room only knows to send somebody because of
 * what the *stream* did or failed to do — but neither delivers anything, which is what separates
 * them from a trip and is why they are bounded by a different rule. See `Engine.sendOn`.
 */
type Stroll = 'huddle' | 'coffee';

type Step =
  | { readonly kind: 'walk'; readonly to: Pt }
  | { readonly kind: 'hold'; ms: number }
  | { readonly kind: 'say'; readonly text: string; readonly verdict?: Verdict }
  | { readonly kind: 'pose'; readonly pose: Pose }
  /** The last step of a huddle or a coffee break: back in the chair, free to be sent on another. */
  | { readonly kind: 'unstroll' }
  /** The last step of a life: reached the door, off the floor, seat released. */
  /** Arrived in the break corner. From here they stay put and the renderer takes over. */
  | { readonly kind: 'settle' };

type Actor = {
  readonly id: string;
  /** Mutable: an agent waiting off-site is given a chair the moment one is freed. */
  deskIndex: number;
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

  // --- what the stream knows and the picture cannot be derived from ---------------------
  /**
   * Tool calls opened and not yet resolved, by `tool_use` id.
   *
   * A map rather than a counter because tools run in parallel: an agent with three calls in
   * flight is doing whatever the *latest* one is, and when one comes back the room needs to know
   * which — a bare count cannot tell a finished `Read` from a finished `Task`.
   */
  open: Map<string, ToolAct>;
  act?: ToolAct;
  tool?: string;
  target?: string;
  lastOk?: boolean;
  fails: number;
  resolved: number;
  edit?: string;
  edits: number;
  done?: boolean;
  doneOk?: boolean;
  parent?: string;
  link?: { child: string; label: string };
  linkUntil: number;
  heard?: string;
  heardUntil: number;
  /**
   * The huddle or coffee break this actor is currently on, or `undefined` for neither.
   *
   * The only thing that bounds these walks. `MAX_QUEUED_TRIPS` cannot: it counts the one `say` a
   * trip contains and a stroll says nothing, so without this flag every exchange in a busy room
   * would queue the same three agents another walk to the table and they would spend the session
   * shuttling to a meeting they were already at. One outstanding stroll per actor, cleared by the
   * `unstroll` step at the end of it.
   */
  stroll?: Stroll;
  /**
   * Which of `TABLE_PLACES` this actor holds, or `-1`. Only meaningful while `stroll` is
   * `'huddle'` — it is how a meeting already in progress knows which places are still free.
   */
  place: number;
  /**
   * When this actor last spoke *to somebody else*, or `-Infinity` before it ever has.
   *
   * The speaker's instant only, never the addressee's. Every `deliver` in the stream is addressed
   * to main, so counting the person spoken to would make main a party to every exchange in the
   * building and three unrelated reports would call a meeting main was never in.
   */
  exchangeAt: number;
  /**
   * The last instant this actor showed any sign of life — a command about it, an open tool call,
   * or a step of its own queue running. What the coffee break's ninety seconds are measured from.
   */
  activeAt: number;
  /** It has reached a chair at least once, so retiring means getting up rather than turning round. */
  sat?: boolean;
  /** This agent has finished and is on its way to (or already in) the break corner. */
  retired?: boolean;
  /** Which place in the corner it was given, once it has one. */
  loungeSlot?: number;
  /** It has arrived there and stopped walking. */
  lounging?: boolean;
  /**
   * How fast this person walks, as a multiple of the room's own speed.
   *
   * Everybody moved at exactly one speed, which is what made a crowd read as a single animation
   * however carefully the walk *cycle* was varied — two agents setting off together arrived
   * together, in step, every time.
   */
  pace: number;
  /**
   * The last token line `usage` reported.
   *
   * The status line has two writers that would otherwise overwrite each other every second: a
   * tool call, which is what the agent is doing, and a token total, which is what it has cost.
   * Work wins while there is work, and the total is what is left on the plate when there is not.
   */
  tokens: string;
};

/**
 * A stable non-negative integer from an agent id.
 *
 * FNV-1a, the same hash the renderer uses for the same reason: every per-person variation in this
 * file has to be *varied* without being random, because two engines fed the same commands have to
 * come out identical or replay is a lie.
 */
function jitter(id: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Open `Task` calls: how many children this agent is currently waiting on. */
function countWaiting(a: Actor): number {
  let n = 0;
  for (const act of a.open.values()) if (act === 'delegate') n += 1;
  return n;
}

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

/**
 * The commands that prove a retired agent is working again.
 *
 * Deliberately not "any command", and the exclusions are the interesting part. `status` is a
 * token total — arithmetic about work already done, arriving on its own schedule long after it.
 * `ensureActor` is the hub re-reading a sidecar. `toolEnd` is a result for a call the agent opened
 * *before* it was told to stop. `done` is the event that retired it in the first place.
 *
 * `deliver` and `confront` are excluded for a subtler reason: speaking is precisely what an agent
 * does *as* it finishes. Its closing report routinely lands after `agentDone` — the room already
 * has a path for that, letting a departing agent say the line it was carrying where it stands —
 * and treating that line as proof of life would drag every finished agent back to a desk to
 * announce it had finished.
 *
 * What is left cannot be the tail of finished work: opening a new tool call, writing a file,
 * delegating, thinking, or being handed a fresh instruction.
 */
const BACK_TO_WORK: ReadonlySet<Cmd['op']> = new Set<Cmd['op']>(['think', 'tool', 'edit', 'spawn', 'prompt']);

export class Engine {
  /** Everyone on the floor, in the order they took a chair — also the order `tick` reports in. */
  private readonly order: Actor[] = [];

  /**
   * Everyone the office knows about, including the ones waiting outside and the ones who have
   * already gone home.
   *
   * A departed agent is kept here rather than deleted, and that is deliberate: `usage` and stray
   * `agentText` events keep arriving for an agent after its `agentDone`, and a map that forgot it
   * would walk a finished agent back in through the door and hand it a chair a live agent was
   * waiting for. Once somebody has left, they have left.
   */
  private readonly byId = new Map<string, Actor>();

  /** Which agent holds each pod chair, or `null` for an empty one. */
  private readonly seats: (string | null)[] = Array.from({ length: POD_CAPACITY }, () => null);

  /** Agents with no chair yet, longest-waiting first. The office's queue at the door. */
  private readonly bench: Actor[] = [];

  /**
   * Who is standing in each place in the break corner, or `null` for a free one.
   *
   * A counter that only ever grew was enough while retirement was permanent. It is not: an agent
   * can come back (see `unretire`), and a corner that never reclaimed its places would run out
   * after twelve arrivals however many of them had left again.
   */
  private readonly lounge: (string | null)[] = Array.from({ length: LOUNGE_CAPACITY }, () => null);

  /**
   * Bumped whenever the floor or the queue changes.
   *
   * The renderer's loop runs sixty times a second and has to know whether the cast moved without
   * building and comparing two lists of ids on every one of those frames. A revision number it
   * can compare against the last one it saw costs nothing on the frames — nearly all of them —
   * where nobody arrived and nobody left.
   */
  private rev = 0;

  private clock: number;

  /**
   * `Task` tool ids whose child has not introduced itself yet.
   *
   * A spawn and the agent it creates are announced in two different transcripts and in either
   * order: the parent records a `Task` call whose child id is literally `'pending'`, and the
   * child's sidecar later reports the `tool_use` id it was born from. Parking the parent here is
   * what turns those two halves into one edge, and it means the line is drawn at the moment the
   * child actually walks in rather than two seconds before it exists.
   */
  private readonly pendingSpawn = new Map<string, { parent: string; label: string }>();

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
    // Every command is a sign of life except two, and the coffee break's idle clock has to know
    // the difference. A token total is arithmetic about work already *done*, and an `ensureActor`
    // is the hub re-reading a sidecar rather than the agent doing anything; both arrive on their
    // own schedule, and either one would keep a stalled agent looking awake for ever.
    if (cmd.op !== 'status' && cmd.op !== 'ensureActor') a.activeAt = this.clock;
    // An agent that starts new work after it was retired was not finished. `agentDone` is derived
    // from the *parent's* `tool_result`, which comes back the instant a background spawn is
    // launched rather than when the child stops: across this machine's transcripts, 246 spawns
    // reported the child done while it was still writing, by as much as 995 seconds. Retiring on
    // that evidence and never revisiting it parks a working agent in the break corner for the rest
    // of the session, with its desk given away. So the decision is reversible, and the only
    // evidence that settles it is the agent itself doing something.
    if (a.retired && BACK_TO_WORK.has(cmd.op)) this.unretire(a);
    switch (cmd.op) {
      case 'ensureActor':
        if (cmd.parentToolUseId !== undefined) this.joinSpawn(a, cmd.parentToolUseId);
        return;
      case 'think':
        a.think = cmd.text;
        a.thinkUntil = this.clock + BUBBLE_MS;
        return;
      case 'tool':
        a.open.set(cmd.id, cmd.act);
        a.act = cmd.act;
        a.tool = cmd.tool;
        a.target = cmd.target;
        a.status = cmd.target ? `${cmd.tool} ${cmd.target}` : cmd.tool;
        return;
      case 'toolEnd': {
        // A result for a call this engine never saw open — a backlog that starts mid-tool — is
        // still a result: it says the work ended and how, which is the whole point of the event.
        // What it must not do is drive `busy` negative, so the count comes off the map.
        const known = a.open.delete(cmd.id);
        a.resolved += 1;
        a.lastOk = cmd.ok;
        a.fails = cmd.ok ? 0 : a.fails + 1;
        if (a.open.size === 0) {
          a.act = undefined;
          a.tool = undefined;
          a.target = undefined;
          a.status = a.tokens;
        } else if (known) {
          // Still working, on whatever else is in flight. The map preserves insertion order, so
          // "the newest still-open call" is its last entry.
          const rest = [...a.open.values()];
          a.act = rest[rest.length - 1];
        }
        return;
      }
      case 'edit':
        a.edit = cmd.path;
        a.edits += 1;
        return;
      case 'spawn':
        if (cmd.child && cmd.child !== 'pending') this.link(a, cmd.child, cmd.prompt);
        else if (cmd.toolUseId) this.pendingSpawn.set(cmd.toolUseId, { parent: a.id, label: cmd.prompt });
        return;
      case 'done':
        a.done = true;
        a.doneOk = cmd.ok;
        // Off the desk and over to the break corner — including for an agent that never got a
        // chair at all, which is the first time anybody sees it. `retire` decides whether there is
        // room; past capacity it leaves the agent exactly where it was.
        this.retire(a);
        return;
      case 'prompt':
        a.heard = cmd.text;
        a.heardUntil = this.clock + HEARD_MS;
        return;
      case 'status':
        a.tokens = cmd.text;
        // Work outranks arithmetic: an agent three seconds into a `Bash` should not have its
        // status quietly replaced by a token total that ticks over every second.
        if (a.open.size === 0) a.status = cmd.text;
        return;
      case 'deliver':
      case 'confront': {
        // A delivery is just a report; only a confront carries a verdict to colour.
        const to = this.ensure(cmd.to);
        this.trip(a, to, cmd.text, cmd.op === 'confront' ? cmd.verdict : undefined);
        // Talking to yourself is not an exchange. `trip` already declines to walk it anywhere, and
        // the room should not call a meeting over three agents each muttering at their own desk.
        if (a !== to) this.noteExchange(a);
        return;
      }
    }
  }

  /** Records a parent→child edge on the parent, for as long as a spawn line is worth drawing. */
  private link(parent: Actor, child: string, label: string): void {
    parent.link = { child, label };
    parent.linkUntil = this.clock + LINK_MS;
  }

  /**
   * Completes a spawn whose child has only just introduced itself.
   *
   * Guarded on the child not already having a parent, because `agentSeen` is re-emitted whenever
   * the hub re-reads a sidecar — without it every re-read would re-fire the line and a settled
   * room would flicker with edges to agents that arrived minutes ago.
   */
  private joinSpawn(child: Actor, toolUseId: string): void {
    if (child.parent !== undefined) return;
    const spawn = this.pendingSpawn.get(toolUseId);
    if (!spawn) return;
    this.pendingSpawn.delete(toolUseId);
    child.parent = spawn.parent;
    const parent = this.byId.get(spawn.parent);
    if (parent) this.link(parent, child.id, spawn.label);
  }

  tick(dtMs: number): ActorState[] {
    // A non-finite delta is unrecoverable if it lands: NaN or Infinity poisons the clock, and
    // from then on every position, every bubble deadline, and every future tick is ruined. A
    // dropped frame is the honest reading of "no usable delta", so treat it as no time passing.
    const dt = Number.isFinite(dtMs) ? Math.max(0, dtMs) : 0;
    const t0 = this.clock;
    for (const a of this.order) this.advance(a, t0, dt);
    this.clock = t0 + dt;
    // After the sweep, so an agent that reached the door on this very tick is off the floor before
    // it is considered for anything — and before it is counted as somebody still working.
    this.coffeeRound();
    // Bubbles time out for the queue outside as well: an agent that spoke while it was waiting
    // for a chair must not walk in five minutes later still holding the same sentence.
    for (const a of this.bench) this.expire(a);
    for (const a of this.order) this.expire(a);
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
      act: a.act,
      tool: a.tool,
      target: a.target,
      busy: a.open.size,
      waiting: countWaiting(a),
      lastOk: a.lastOk,
      fails: a.fails,
      resolved: a.resolved,
      edit: a.edit,
      edits: a.edits,
      done: a.done,
      doneOk: a.doneOk,
      parent: a.parent,
      link: a.link,
      heard: a.heard,
      retired: a.retired,
      lounging: a.lounging,
      loungeSlot: a.loungeSlot,
    }));
  }

  /** Drops whatever this actor is holding that has run out of time. */
  private expire(a: Actor): void {
    if (a.say !== undefined && a.sayUntil <= this.clock) {
      a.say = undefined;
      a.verdict = undefined; // the tint belongs to the bubble, not to the actor
    }
    if (a.think !== undefined && a.thinkUntil <= this.clock) a.think = undefined;
    if (a.link !== undefined && a.linkUntil <= this.clock) a.link = undefined;
    if (a.heard !== undefined && a.heardUntil <= this.clock) a.heard = undefined;
  }

  /** Everyone the office knows about and has no chair for, longest-waiting first. */
  offsite(): readonly string[] {
    return this.bench.map((a) => a.id);
  }

  /** A revision that changes when, and only when, who is on the floor or in the queue changes. */
  seating(): number {
    return this.rev;
  }

  private ensure(id: string): Actor {
    const found = this.byId.get(id);
    if (found) return found;

    const a: Actor = {
      id,
      deskIndex: OFFSITE_DESK_INDEX,
      x: WAYPOINTS.door.x,
      y: WAYPOINTS.door.y,
      pose: 'walk',
      flip: false,
      away: false,
      status: '',
      sayUntil: 0,
      thinkUntil: 0,
      queue: [],
      open: new Map<string, ToolAct>(),
      fails: 0,
      resolved: 0,
      edits: 0,
      linkUntil: 0,
      heardUntil: 0,
      tokens: '',
      pace: 1 + PACE_SPREAD * (((jitter(id) % 200) - 100) / 100),
      place: -1,
      // Not 0: with the clock's origin at 0 and a window measured backwards from it, an actor that
      // has never spoken would count as having spoken at the start of the session, and the first
      // three commands of any stream would call a meeting nobody had a conversation in.
      exchangeAt: Number.NEGATIVE_INFINITY,
      activeAt: this.clock,
    };
    this.byId.set(id, a);

    if (id === MAIN_ID) {
      // The orchestrator's desk is not part of the pod grid and is never contended for.
      this.take(a, MANAGER_DESK_INDEX);
      return a;
    }
    const slot = this.seats.indexOf(null);
    if (slot === -1) {
      this.bench.push(a);
      this.rev += 1;
    } else {
      this.take(a, slot);
    }
    return a;
  }

  /** Gives `a` a chair and walks it in: through the door, across the room, into the seat. */
  private take(a: Actor, deskIndex: number): void {
    a.deskIndex = deskIndex;
    if (deskIndex >= 0) this.seats[deskIndex] = a.id;
    a.x = WAYPOINTS.door.x;
    a.y = WAYPOINTS.door.y;
    a.pose = 'walk';
    const front = deskFront(a);
    a.queue = [
      // A beat at the door before setting off. A replayed backlog hands the office a dozen
      // `agentSeen` events inside one frame, and without this the whole cast crossed the room
      // shoulder to shoulder in a single rank — the most mechanical thing the room ever did.
      { kind: 'hold', ms: jitter(a.id) % ARRIVE_STAGGER_MS },
      ...walkSteps(route(WAYPOINTS.door, front)),
      ...sitDown(a),
    ];
    this.order.push(a);
    this.rev += 1;
  }

  /**
   * Sends a finished agent to the break corner, and gives its chair to whoever is waiting.
   *
   * This replaced walking them out of the door, and the difference is the whole character of the
   * room. An office that deletes people as they finish tells you less the longer you watch it:
   * a session that went well ends as an empty room, which looks exactly like a session that never
   * started. Sending them twenty pixels left instead means the corner fills up as the work
   * completes, and "how far along is this" becomes something you can see from the doorway.
   *
   * `main` never goes. It is the session, not a participant in it.
   */
  private retire(a: Actor): void {
    if (a.retired || a.deskIndex === MANAGER_DESK_INDEX) return;
    const slot = this.lounge.indexOf(null);
    // Past the corner's capacity there is nowhere honest to put them, so they stay where they are
    // — at a desk if they have one, in the queue outside if they do not. Cramming forty people
    // into one corner is a crowd, not a break room.
    if (slot === -1) return;

    a.retired = true;
    a.place = -1; // any table place they were holding is given up
    // And the errand they were on. `stroll` is normally cleared by an `unstroll` step at the end of
    // the walk, but when an agent finishes before it ever sat down the queue is *replaced* below,
    // which throws that step away. The flag then stays set for the rest of the session and
    // `strollable` refuses the agent for ever: it can never be called to the roundtable again, and
    // never takes another break, even after `unretire` puts it back at a desk.
    a.stroll = undefined;
    a.loungeSlot = slot;
    this.lounge[slot] = a.id;

    const from = a.deskIndex === OFFSITE_DESK_INDEX ? WAYPOINTS.door : deskFront(a);
    const spot = loungeSpot(slot);

    // The chair goes *now*, not when they get there. Somebody who has finished is not working, and
    // a live agent waiting outside should not be kept out while a finished one strolls the width
    // of the room.
    if (a.deskIndex >= 0 && this.seats[a.deskIndex] === a.id) this.seats[a.deskIndex] = null;
    a.deskIndex = LOUNGE_DESK_INDEX;
    this.rev += 1;

    if (this.bench.length > 0 && !this.bench.includes(a)) this.fillSeats();
    else if (this.bench.includes(a)) {
      // It never got a chair at all: it walks in from the door straight to the corner, which is
      // the first time anybody has actually seen it.
      this.bench.splice(this.bench.indexOf(a), 1);
      a.x = WAYPOINTS.door.x;
      a.y = WAYPOINTS.door.y;
      a.pose = 'walk';
      a.queue = [];
      this.order.push(a);
    }

    if (!a.sat) {
      // It finished before it ever reached a chair — which is what *every* agent looks like when a
      // finished session's backlog is replayed into an empty room. Making it complete the walk to
      // a desk, sit for a beat and stand straight back up is the single most pointless thing the
      // room did: twelve people filing in, perching for three seconds, and filing out again.
      // Whatever it was walking towards no longer matters; it goes straight to the corner.
      a.queue = [...walkSteps(route({ x: a.x, y: a.y }, spot)), { kind: 'pose', pose: 'stand' }, { kind: 'settle' }];
      return;
    }

    // Queued behind whatever it was already doing, so an agent that finishes mid-errand still
    // delivers the line it was carrying before it wanders off for a coffee.
    a.queue.push(
      // Seeded, so six children finishing inside a second do not all push their chairs back on the
      // same frame and cross the floor in formation.
      { kind: 'hold', ms: DONE_LINGER_MS + (jitter(a.id) % DONE_LINGER_SPREAD_MS) },
      { kind: 'walk', to: from },
      { kind: 'pose', pose: 'stand' },
      // A beat on their feet. Without it the stand and the first step away fall inside one tick,
      // so nobody is ever *seen* getting up — they simply resume walking, from their own chair.
      { kind: 'hold', ms: SETTLE_MS },
      ...walkSteps(route(from, spot)),
      { kind: 'pose', pose: 'stand' },
      { kind: 'settle' },
    );
  }

  /**
   * Brings an agent back from the break corner, because it turned out not to be finished.
   *
   * The counterpart to `retire`, and the reason the corner tracks *who* is in each place rather
   * than only how many have been handed out. They walk back from where they are standing, not in
   * through the door: they never left the building, and re-staging an arrival would claim a second
   * agent had joined the session.
   *
   * A chair is not guaranteed. Retirement gave theirs away on purpose — to a live agent that was
   * waiting outside — so if the floor filled up while they were gone they join the queue like
   * anybody else. That is the honest picture: they are working, and there is nowhere to sit.
   */
  private unretire(a: Actor): void {
    if (!a.retired) return;
    if (a.loungeSlot !== undefined && this.lounge[a.loungeSlot] === a.id) this.lounge[a.loungeSlot] = null;
    a.loungeSlot = undefined;
    a.retired = false;
    a.done = false;
    a.doneOk = undefined;
    // `lounging` is "has arrived in the corner and stopped". They are about to leave it, and a
    // renderer that still believed they were settled there would draw the break-corner pose over
    // an agent walking back to a desk.
    a.lounging = false;
    a.stroll = undefined; // same reason as in `retire`: the queue below replaces the unstroll step
    // Whatever walk to the corner was still queued is no longer where they are going.
    a.queue = [];

    const slot = this.seats.indexOf(null);
    if (slot === -1) {
      a.deskIndex = OFFSITE_DESK_INDEX;
      const at = this.order.indexOf(a);
      if (at !== -1) this.order.splice(at, 1); // on the floor and in the queue would draw them twice
      if (!this.bench.includes(a)) this.bench.push(a);
    } else {
      a.deskIndex = slot;
      this.seats[slot] = a.id;
      a.pose = 'walk';
      a.queue = [...walkSteps(route({ x: a.x, y: a.y }, deskFront(a))), ...sitDown(a)];
      if (!this.order.includes(a)) this.order.push(a);
    }
    this.rev += 1;
  }

  /** Hands every free chair to whoever has been waiting longest for one. */
  private fillSeats(): void {
    while (this.bench.length > 0) {
      const slot = this.seats.indexOf(null);
      if (slot === -1) return;
      const next = this.bench.shift();
      if (next) this.take(next, slot);
    }
  }

  /** Trips still waiting in this actor's queue, counted by the one `say` each of them contains. */
  private queuedTrips(a: Actor): number {
    let n = 0;
    for (const step of a.queue) if (step.kind === 'say') n += 1;
    return n;
  }

  /**
   * Queues a round trip: over to `target`'s desk, a line spoken standing there, then back to
   * one's own chair. Trips queue behind whatever the actor is already doing, so a burst of
   * events never teleports anyone mid-stride.
   */
  private trip(a: Actor, target: Actor, text: string, verdict?: Verdict): void {
    // Somebody who has finished, or is waiting outside for a chair, has no desk to walk a note
    // back to. They still get to say it, where they stand — a line queued behind a walk that never
    // ends would simply never be seen.
    if (a.retired || a.deskIndex === OFFSITE_DESK_INDEX) {
      a.say = text;
      a.verdict = verdict;
      a.sayUntil = this.clock + BUBBLE_MS;
      return;
    }
    // A round trip takes several seconds of office time; a busy agent can produce messages far
    // faster than that. Queueing one walk per message made the room a backlog rather than a view
    // — an agent that spoke thirty times would still be walking its fourth note across the floor
    // minutes after the session ended, showing text nobody was waiting on any more.
    //
    // Past the cap the newest line replaces the pending one instead of joining a queue behind it,
    // so the room stays roughly current and always shows the most recent thing that was said.
    if (a !== target && this.queuedTrips(a) >= MAX_QUEUED_TRIPS) {
      for (let i = a.queue.length - 1; i >= 0; i--) {
        const step = a.queue[i];
        if (step.kind === 'say') {
          a.queue[i] = { kind: 'say', text, verdict };
          return;
        }
      }
    }
    // Nobody walks a note to their own desk, and nobody can walk one to a desk that does not
    // exist. The second case is not rare: `mapping.ts` resolves a verdict's target against the
    // *whole* roster, which includes every agent queued outside for a chair and every agent
    // already in the break corner, so on a wide fan-out most named targets are deskless. Asking
    // `visitorSpot` where their desk is threw out of `apply`, and that throw escapes all the way to
    // the socket's flush loop — taking every remaining event in the batch with it, permanently,
    // while the feed and the roster had already folded them. The room and the panels then disagree
    // for the rest of the session, and nothing says why.
    const targetDeskless =
      target.deskIndex !== MANAGER_DESK_INDEX && (target.retired || target.deskIndex < 0);
    if (a === target || targetDeskless) {
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

  // --- huddle and coffee break -----------------------------------------------------------
  //
  // The two behaviours in this room that nobody asks for. Everything above walks because an event
  // said so; these two walk because of the *shape* of the stream — several agents talking at once,
  // or one agent doing nothing while the rest work — which is a fact about the simulation and not
  // about any single frame, so it is decided here rather than in the renderer. What the renderer
  // gets is what it gets for every other walk: a position and a pose. "At the table" is the point
  // being within a pixel of one of `TABLE_PLACES`, which the renderer can read off the position it
  // is already given, so `ActorState` gains nothing for either of them.

  /** At a desk and still working — not retired to the corner, not queued outside for a chair. */
  private onFloor(a: Actor): boolean {
    return !a.retired && a.deskIndex !== OFFSITE_DESK_INDEX;
  }

  /** …and not already out on one. */
  private strollable(a: Actor): boolean {
    return this.onFloor(a) && a.stroll === undefined;
  }

  /**
   * Records that `a` has just spoken to somebody else, and gathers the room at the roundtable if
   * enough of them have done so recently.
   *
   * The meeting *grows* rather than being fixed at the moment it is called: the third recent
   * exchange calls it, and a fourth agent that speaks while it is still on takes the last place.
   * That is why the window is re-counted on every exchange instead of latched — a fan-out whose
   * children report one after another is one conversation, not three overlapping ones.
   */
  private noteExchange(a: Actor): void {
    a.exchangeAt = this.clock;
    const cutoff = this.clock - HUDDLE_WINDOW_MS;
    // Everyone on the floor who spoke inside the window, *including* the ones already at the
    // table. Dropping those would make the count collapse back below the threshold the moment the
    // meeting started, and the fourth place could then never be filled by anybody.
    const recent = this.order.filter((b) => b.exchangeAt > cutoff && this.onFloor(b));
    if (recent.length < HUDDLE_MIN) return;

    const taken = new Set<number>();
    for (const b of this.order) if (b.stroll === 'huddle') taken.add(b.place);
    for (const b of recent) {
      if (!this.strollable(b)) continue;
      const place = TABLE_PLACES.findIndex((_, i) => !taken.has(i));
      // The table is full. The surplus — a fifth agent, and the ninth, and the thirteenth — is not
      // queued for a place and not stood on the table: it stays at its desk and keeps working.
      if (place === -1) return;
      taken.add(place);
      b.place = place;
      this.sendOn(b, 'huddle', TABLE_PLACES[place], HUDDLE_HOLD_MS);
    }
  }

  /**
   * Sends anyone who has had nothing to do for `IDLE_COFFEE_MS` to the machine — but only while
   * somebody else is still working.
   *
   * That second condition is most of the behaviour. Without it the end of every session, the
   * moment when the last agent has reported and the room should go still, turns into a procession
   * to the coffee corner: an office where everybody has finished is quiet, not on a break.
   */
  private coffeeRound(): void {
    // Walking and an open tool call are the two signs of life that never arrive as a command, so
    // they are stamped here instead. Without this the idle clock would run while an actor was
    // halfway across the room on an errand, and a long enough trip would end at the machine.
    for (const a of this.order) if (a.open.size > 0 || a.queue.length > 0) a.activeAt = this.clock;

    // `done` is excluded deliberately: an agent lingering in its chair on `DONE_LINGER_MS` with a
    // call still open is finishing, not working, and it must not hold the room's lights on.
    if (!this.order.some((a) => a.open.size > 0 && !a.done && this.onFloor(a))) return;
    // One machine, one cup. Without this every idle agent in a finishing session sets off at the
    // same instant and they all stand on the same anchor — a queue at the coffee corner is a
    // picture of a bug, whatever the office it is drawn from.
    if (this.order.some((a) => a.stroll === 'coffee')) return;

    for (const a of this.order) {
      // Idleness, spelled out: nothing in flight, nothing queued, and nothing for ninety seconds.
      // The queue test is implied by the stamp above and kept anyway, because `strollable` is
      // shared with the huddle, whose participants are deliberately allowed to be mid-errand.
      if (a.open.size > 0 || a.queue.length > 0) continue;
      // The same exclusion the lights-on test above makes, and for the same reason — it was simply
      // never applied here. An agent that finished when the break corner was already full keeps its
      // chair (`retire` gives up and returns), so it stays `done` on the floor, goes idle, and
      // ninety seconds later sets off for a coffee. Repeatedly, for as long as anyone else is still
      // working. Somebody who has finished does not get up for a drink; they have left.
      if (a.done) continue;
      if (this.clock - a.activeAt < IDLE_COFFEE_MS) continue;
      if (!this.strollable(a)) continue;
      this.sendOn(a, 'coffee', WAYPOINTS.coffee, COFFEE_HOLD_MS);
      return; // one at a time, as above
    }
  }

  /**
   * Queues a walk that carries nothing: out onto the floor, over to `to`, a beat standing there,
   * and back into the chair.
   *
   * Queued *behind* whatever the actor is already doing, and never in place of it. A delivery is
   * the only thing in this room a viewer is waiting on, so it always wins: an agent called to the
   * table while it is carrying a line walks the line first and joins the huddle afterwards, even
   * if the meeting has broken up by then. The mirror of that rule is `MAX_QUEUED_TRIPS`, which
   * counts `say` steps and therefore cannot see a stroll at all — so a stroll never replaces a
   * queued line, and a line queued later never replaces a stroll. What bounds strolls instead is
   * `Actor.stroll`: exactly one outstanding per actor, cleared by the `unstroll` step below.
   */
  private sendOn(a: Actor, kind: Stroll, to: Pt, hold: number): void {
    a.stroll = kind;
    const front = deskFront(a);
    a.queue.push(
      { kind: 'walk', to: front },
      ...walkSteps(route(front, to)),
      { kind: 'pose', pose: 'stand' },
      { kind: 'hold', ms: hold },
      ...walkSteps(route(to, front)),
      ...sitDown(a),
      { kind: 'unstroll' },
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
          a.sat = true; // it got to a chair, so finishing means getting up rather than turning round
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
      if (step.kind === 'unstroll') {
        // Back in the chair, and free to be sent out again. The exchanges that called the meeting
        // are spent along with it: without that, the same three lines still sitting inside the
        // window would call a second meeting the instant the first one broke up, and a chatty
        // office would never leave the rug.
        a.stroll = undefined;
        a.place = -1;
        a.exchangeAt = Number.NEGATIVE_INFINITY;
        a.queue.shift();
        continue;
      }
      if (step.kind === 'settle') {
        // Arrived in the break corner. Nothing more is queued for this actor ever again: what it
        // does from here — perch on a stool, hold a mug, have a cigarette, talk to whoever else is
        // over there — is a presentation decision, and the renderer makes it from the position and
        // the seed rather than the simulation scripting it.
        a.lounging = true;
        a.queue.length = 0;
        return;
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
        // Everybody used to move at exactly `SPEED_PX_PER_S`, and that single number is what made
        // a crowd read as one animation no matter how carefully the walk *cycle* was varied: two
        // agents leaving their desks together arrived together, in step, every single time.
        const speed = SPEED_PX_PER_S * a.pace;
        const travel = (speed * rem) / 1000;
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
        const ms = (dist / speed) * 1000;
        used += ms;
        rem -= ms;
        a.queue.shift();
        continue;
      }
      if (step.kind !== 'hold') {
        // Every other kind is handled above; this keeps the union exhaustive rather than letting a
        // future step kind fall into the hold arithmetic and silently consume time.
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
