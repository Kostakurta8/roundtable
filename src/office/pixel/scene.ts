/**
 * The room, composed.
 *
 * Everything else in `pixel/` knows how to draw one thing; this file knows where all of them go
 * and in what order. The whole scene is painted into a 480x270 buffer every frame — small enough
 * that redrawing all of it is cheaper than working out what changed, and the only way a light
 * pool or a piece of steam can sit correctly on top of the desk it belongs to.
 *
 * Two rules do all the work:
 *
 *   - **Painter order is y order.** Every object in the room declares the row it stands on, and
 *     the whole floor layer is sorted by that row before anything is drawn. Nearer things are
 *     drawn later and therefore occlude farther ones, for free, with no z-index table to keep in
 *     sync with the geometry.
 *   - **Time comes from the tick.** Not one animation here reads the wall clock. `draw` is handed
 *     the same delta the simulation was, and every phase is derived from an accumulated total, so
 *     a replayed session animates identically to the live one that recorded it.
 *
 * The engine's 1600x900 basis maps to the buffer by a flat x0.3 — `SCENE.w * S === PIX.w` exactly,
 * so a scene coordinate is a canvas coordinate without a special case anywhere.
 */
import {
  LINK_MS,
  MANAGER_DESK_INDEX,
  podSeat,
  SCENE,
  SPEED_PX_PER_S,
  WAYPOINTS,
  type ActorState,
} from '../engine';
import { drawText, drawTextOutlined, FONT_HEIGHT, PAL, PIX, pool, rect, textWidth } from './art';
import * as CH from './characters';
import * as ENV from './environment';
import * as FX from './effects';
import * as FUR from './furniture';
import * as PR from './props';

/** Scene basis to canvas pixels. Exactly 0.3, and exactly 480x270 out of 1600x900. */
export const S = PIX.w / SCENE.w;

const sx = (v: number): number => v * S;
const sy = (v: number): number => v * S;

/** The row the floor starts on — everything above it is wall. */
const FLOOR_Y = ENV.WALL_H;

/** A desk sits this far above its owner's chair (mockup's 5.2% of the scene height). */
const DESK_ABOVE_SEAT = Math.round(sy(0.052 * SCENE.h));

/** Where a monitor's foot rests on a desk, measured up from the desk's own floor row. */
const DESK_SURFACE = 12;

/** The off-site strip along the bottom, when there is one. */
const GHOST_BAND_H = 26;

/**
 * How long a change of facing takes. Two frames at sixty — enough to be seen, short enough that
 * a route with four corners in it does not become a person spinning on the spot.
 */
const TURN_MS = 130;

/** A full walk, in canvas pixels per millisecond: the engine's 150 scene px/s through `S`. */
const FULL_SPEED_PX_PER_MS = (SPEED_PX_PER_S * S) / 1000;

/** How quickly measured speed is chased. Roughly two frames of ramp at each end of a trip. */
const SPEED_EASE_MS = 120;

/**
 * How long a reaction to a tool result plays.
 *
 * Under a second. A fist-pump that lasts two seconds stops being a reaction and becomes a pose,
 * and twelve of them at once would be a room of people celebrating rather than working.
 */
const REACT_MS = 800;

/** How long somebody in the break corner holds one activity before drifting into the next. */
const LOUNGE_TURN_MS = 5200;

/** Every desk the floor plan draws: the manager's, then the pod grid in seating order. */
const DESK_INDICES: readonly number[] = [
  MANAGER_DESK_INDEX,
  ...WAYPOINTS.podSeats.map((_, i) => i),
];

/**
 * The round rug, in canvas pixels — derived from the engine's own `RUG` extent (54.5%…72.5% by
 * 57%…86% of the scene) rather than written down, so it cannot drift away from the roundtable
 * routing that avoids it.
 */
const RUG_CENTRE = {
  x: Math.round(sx(((0.545 + 0.725) / 2) * SCENE.w)),
  y: Math.round(sy(((0.57 + 0.86) / 2) * SCENE.h)),
} as const;

// ---------------------------------------------------------------- inputs

export type SceneLook = { tint: string; color: string; skin: string; hair: string };

export type SceneAgent = {
  label: string;
  look: SceneLook;
  /** Free text under the nameplate — the current tool line, or a token count. */
  status: string;
  /** Drawn as a `!` pop over the head when it flips to true. */
  errored?: boolean;
  /**
   * Tokens this agent has spent.
   *
   * Drawn as a stack of paper on the desk, never as a number. $160 and 66M tokens currently live
   * only in the top bar, which is the one place in the app nobody is looking while they watch the
   * room — and a figure would be unreadable at this size anyway. A deepening pile of paper is
   * legible at a glance and impossible to read precisely, which is exactly the right precision.
   */
  tokens?: number;
};

export type Ghost = {
  id: string;
  label: string;
  look: SceneLook;
  busy: boolean;
  /** Finished and gone home, rather than still waiting for a chair. */
  done?: boolean;
};

export type SceneInput = {
  actors: readonly ActorState[];
  agents: Readonly<Record<string, SceneAgent>>;
  /** The session's opening prompt, for the whiteboard. */
  task: string;
  turns: number;
  /**
   * How far along this session's spend is, 0..1, for the whiteboard's bar.
   *
   * A fraction rather than a figure, because the room has no business asserting what a session
   * *should* cost — it only has to show that this one has been getting more expensive. The caller
   * decides what counts as full.
   */
  spend?: number;
  selected: string | null;
  /**
   * The selected agent's spawn tree, when there is a selection.
   *
   * `selected` is one id and dimming keyed on it alone dimmed the selected agent's own children —
   * so clicking a parent to see what it was running greyed out exactly the agents you had clicked
   * it to look at. The DOM layer already carries the tree; the paint has to agree with it or the
   * two halves of the same room contradict each other.
   */
  kin?: ReadonlySet<string> | null;
  /** Agents the room has no chair for. Shown, never silently dropped. */
  ghosts: readonly Ghost[];
  /** 0 = day, 1 = night. Eased internally, so a theme flip is a dusk rather than a cut. */
  night: number;
  /** Milliseconds since the last draw — the same delta the simulation was advanced by. */
  dt: number;
  /**
   * The viewer has asked for reduced motion.
   *
   * Half-honoured before this: the simulation was slowed to a 500ms tick, but every effect was
   * still driven by the same accumulated time, so steam, dust, plant sway and the screen flicker
   * did not stop — they advanced in half-second jumps, which is *more* motion-sick, not less.
   * Freezing the effect clock is what "reduced motion" actually asks for. People still move
   * between the places they need to be, because that is information rather than decoration.
   */
  still?: boolean;
};

// ------------------------------------------------------------ render memory

/** One footstep's dust, from the moment it was raised until it has faded. */
type Puff = { x: number; y: number; age: number };

/**
 * What the renderer remembers about an actor between frames.
 *
 * The simulation is deliberately memoryless about presentation — it reports a position, a pose and
 * two facing bits, and nothing about how it got there. Facing in particular cannot be recovered
 * from the state alone: the engine's `flip`/`away` pair cannot tell "walking right" from "walking
 * toward the camera", because both are `flip:false, away:false`. Differencing the position across
 * frames can, so the renderer does that here rather than reaching into the tested engine.
 */
type Mem = {
  px: number;
  py: number;
  dir: CH.CharDir;
  flip: boolean;
  /** Milliseconds spent stationary, for the idle `?` pop and for settling into a chair. */
  stillMs: number;
  /** Distance walked since the last footstep puff. */
  stepAcc: number;
  /**
   * Total distance walked, in canvas pixels — the walk cycle's only clock.
   *
   * It used to be driven by wall time, which is the classic way to make feet skate: the cycle ran
   * at a fixed rate whatever the actor's speed or the frame delta, so the moment either changed
   * the contact frames stopped landing where the body actually was. Distance cannot drift out of
   * step with movement, because it *is* movement.
   */
  walkAcc: number;
  /** 0..1, smoothed — how fast this actor is going, as a fraction of a full walk. */
  speed: number;
  /** Milliseconds left in a turn. Non-zero draws the three-quarter in-between pose. */
  turnMs: number;
  puffs: Puff[];
  /** How long the current speech bubble has been up, for the typewriter reveal. */
  sayMs: number;
  saying?: string;
  /** A `!` or `?` pop, with its own 0..1 life. */
  emote?: { kind: '!' | '?' | '...'; age: number };
  /**
   * How far through its life the spawn edge this actor is holding is, 0..1.
   *
   * The engine reports *that* there is an edge, not how old it is — age is a presentation
   * question, and keeping it here means the line can draw itself in and fade out without the
   * simulation having to carry a number whose only consumer is a paintbrush.
   */
  linkAge: number;
  linkTo?: string;
  /** The last outcome count seen, so the frame a tool call *comes back* can be caught. */
  resolved: number;
  /** A reaction to that outcome, with its own 0..1 life. */
  react?: { kind: 'cheer' | 'slump'; age: number };
  seed: number;
  hairStyle: number;
};

/** FNV-1a over the id: a stable seed, so an agent keeps its face and its blink rhythm. */
function hash(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** A drawable deferred until the whole floor layer can be sorted by the row it stands on. */
type Layered = { y: number; draw: () => void };

/** A rectangle in canvas pixels, for hit-testing and for placing the DOM layer over the paint. */
export type Box = { x: number; y: number; w: number; h: number };

// ------------------------------------------------------------ static dressing

/** Wall fixtures, in canvas pixels. `y` is the bottom row each one occupies on the wall. */
const WALL_FIXTURES = {
  windows: [72, 149, 278],
  windowBase: FLOOR_Y - 4,
  art: [
    { x: 240, y: FLOOR_Y - 12, variant: 0 },
    { x: 415, y: FLOOR_Y - 14, variant: 1 },
    { x: 455, y: FLOOR_Y - 10, variant: 2 },
  ],
  clock: { x: 253, y: FLOOR_Y - 22 },
  vent: { x: 108, y: 7 },
  shelf: { x: 385, y: FLOOR_Y - 6 },
  // One over the break corner too. Without it that whole side of the room went black after hours
  // and the people gathered there read as a smudge rather than as a group.
  lamps: [38, 130, 228, 326, 424],
} as const;

// -------------------------------------------------------------- clickable fixtures

/**
 * The pieces of the room the interaction layer hangs a real button over.
 *
 * A hit target is not a second opinion about where something is; it is the geometry that draws the
 * thing, read back out. These lived in `PixelOffice.tsx` as two hand-written rectangles a thousand
 * lines away from the draw calls, and both were wrong in the same way: they were written as if a
 * draw function's second argument were the fixture's *centre*, when the anchor rule the whole
 * renderer is built on says it is the **bottom row the object occupies**. The whiteboard's button
 * therefore sat fourteen rows low — over the skirting and the floorboards under the board, with
 * the task written on the board not clickable at all — and the roundtable's sat seven rows high,
 * over the rug in front of the table and missing its pedestal entirely.
 *
 * Writing the box down again, correctly, would only have reset the clock on the same drift. So
 * each fixture is one record: the anchor, the footprint about that anchor, and the call that
 * paints it. `Scene.draw` paints through `paint`; everything downstream measures through
 * `fixtureBox`; neither can move without the other.
 */
export type FixtureName = 'whiteboard' | 'roundtable';

type Fixture = {
  /** The `cx` its draw function is handed — the fixture's horizontal centre. */
  cx: number;
  /** The `yBase` its draw function is handed — the bottom row it occupies. */
  yBase: number;
  /** Its footprint about that anchor, in canvas pixels. */
  w: number;
  h: number;
  /** Paints it, and nothing else — no chairs, no dressing, no light. */
  paint: (ctx: CanvasRenderingContext2D, input: SceneInput) => void;
};

/** The board's anchor on the back wall: centred at 205, its tray three rows clear of the floor. */
const BOARD_AT = { cx: 205, yBase: FLOOR_Y - 3 } as const;

/**
 * The table's anchor, derived from the engine's own table places rather than written down —
 * `tableN` gives the column the four seats are arranged around, `tableS` the row the near chair
 * stands on — so the furniture cannot drift away from the people routed to it.
 */
const TABLE_AT = { cx: sx(WAYPOINTS.tableN.x), yBase: sy(WAYPOINTS.tableS.y) - 4 } as const;

const FIXTURES: Readonly<Record<FixtureName, Fixture>> = {
  whiteboard: {
    ...BOARD_AT,
    // 66 x 30 rather than the 62 x 26 frame: `drawWhiteboard` hangs the marker tray two pixels
    // past each end of the frame (`environment.ts:724`, `x0 - 2` by 66) and drops a contact shadow
    // on the row below it (`environment.ts:731`, `y0 + 29`). Both are the board to anyone looking
    // at it, and the tray is the part people reach for.
    w: 66,
    h: 30,
    paint: (ctx, input) => ENV.drawWhiteboard(ctx, BOARD_AT.cx, BOARD_AT.yBase, boardOf(input)),
  },
  roundtable: {
    ...TABLE_AT,
    w: FUR.TABLE.w,
    h: FUR.TABLE.h,
    paint: (ctx) => FUR.drawRoundtable(ctx, TABLE_AT.cx, TABLE_AT.yBase),
  },
};

/** Every fixture there is, so nothing downstream has to enumerate them by hand. */
export const FIXTURE_NAMES = Object.keys(FIXTURES) as readonly FixtureName[];

/**
 * Where a fixture is, in buffer pixels.
 *
 * The anchor rule resolved into a rectangle, and the only supported answer to "where is the
 * whiteboard". A free function rather than a `Scene` method because a fixture does not move:
 * there is no per-frame memory to consult, nothing to instantiate a scene for, and a frame loop
 * can hoist the answer out of itself entirely.
 */
export function fixtureBox(name: FixtureName): Box {
  const f = FIXTURES[name];
  return { x: Math.round(f.cx - f.w / 2), y: Math.round(f.yBase - f.h + 1), w: f.w, h: f.h };
}

/**
 * Paints one fixture on its own, at the anchor the room paints it at.
 *
 * Exported so that the box and the paint can be held against each other: draw the fixture into an
 * empty buffer, measure the ink, and the rectangle `fixtureBox` publishes has to contain it. That
 * is the check the two literals this replaced could never have failed.
 */
export function paintFixture(
  ctx: CanvasRenderingContext2D,
  name: FixtureName,
  input: SceneInput,
): void {
  FIXTURES[name].paint(ctx, input);
}

/**
 * The kitchen corner the coffee trips end at. The engine's `KITCHEN` zone is everything left of
 * 11% and above 29% of the scene, and `WAYPOINTS.coffee` is the spot an actor stands on; the
 * counter therefore has to sit just *above* that spot, or people would walk through it.
 */
const KITCHEN = {
  counter: { x: 34, y: 58, w: 40 },
  fridge: { x: 10, y: 62 },
  machine: { x: 28, y: 47 },
  cooler: { x: 58, y: 76 },
} as const;

/**
 * The break corner, in canvas pixels.
 *
 * The left bank of desks used to be here; it moved right so that agents who have finished have
 * somewhere to *be*. They used to walk out of the door and stop existing, which meant a session
 * that went well ended as an empty room — indistinguishable from one that never started. Now the
 * corner fills up as the work completes, and how far along a session is becomes something you can
 * read from across the room without a single number.
 *
 * Every anchor here is the canvas twin of a `WAYPOINTS.lounge*` entry the engine walks people to;
 * the two have to agree or people stand next to the furniture instead of at it.
 */
const LOUNGE = {
  table: { x: 38, y: 118 },
  stools: [
    { x: 24, y: 124 },
    { x: 52, y: 124 },
  ],
  couch: { x: 25, y: 154 },
  ash: { x: 66, y: 142 },
} as const;

/**
 * Floor dressing that belongs to the room rather than to any agent.
 *
 * Bare floor is what makes a pixel room look unfinished, and the first pass left the middle and
 * the right-hand third empty enough to read as a warehouse. Everything here is kept out of the
 * lanes the simulation actually walks — the west aisle, the door's approach, and the run to the
 * roundtable — because a person striding through a filing cabinet is worse than an empty corner.
 * Nothing sits below `y` 242 either: that band belongs to the off-site strip.
 */
const DRESSING = [
  // The open middle, between the two banks of desks.
  // Moved right when the left bank did: at 176 these stood inside the second column's desks.
  { kind: 'plant', x: 202, y: 74, size: 1 },
  { kind: 'cabinet', x: 228, y: 70, variant: 1 },
  { kind: 'printer', x: 258, y: 68 },
  { kind: 'bin', x: 206, y: 124 },
  { kind: 'plant', x: 262, y: 122, size: 1 },
  { kind: 'coatrack', x: 336, y: 62 },
  // The near edge, in front of everything.
  { kind: 'box', x: 180, y: 234 },
  { kind: 'box', x: 191, y: 240 },
  { kind: 'plant', x: 232, y: 240, size: 2 },
  { kind: 'cabinet', x: 300, y: 250, variant: 0 },
  { kind: 'plant', x: 352, y: 240, size: 2 },
  { kind: 'bin', x: 404, y: 238 },
  { kind: 'box', x: 464, y: 240 },
  // The narrow gap between the right bank's two columns.
  { kind: 'plant', x: 409, y: 180, size: 0 },
] as const;

// ------------------------------------------------------------------- scene

export class Scene {
  private readonly mem = new Map<string, Mem>();
  /** Accumulated tick time. Every animation phase in the room is derived from this. */
  private t = 0;
  /** The eased night level, chasing `input.night` so a theme flip reads as dusk, not a cut. */
  private night = 0;
  /** The door's swing, opened by an arrival and closing on its own. */
  private doorOpen = 0;

  /** Where each actor's head ended up, so the DOM accessibility layer can be placed over it. */
  private readonly boxes = new Map<string, Box>();

  /** Where each actor's workstation ended up — a hover target that stays put when they walk off. */
  private readonly deskBoxes = new Map<string, Box>();

  /**
   * How deep in paper each desk was left, by desk index rather than by agent.
   *
   * It outlives its owner on purpose. An agent that finishes walks out and stops being reported at
   * all, and with it would go the only thing in the room that said what it had cost — so the pile
   * stays on the desk it was made at. A newcomer taking that chair overwrites it with their own,
   * which is right: it is the desk's paper, not a monument.
   */
  private readonly deskPapers = new Map<number, number>();

  /**
   * Where each off-site avatar ended up in the strip along the bottom.
   *
   * Published for the same reason the actor boxes are: forty small heads with no names is a
   * decoration, and the only way to give them names without covering the room in text is to hang
   * real DOM over them — which needs somewhere to hang.
   */
  private readonly ghostBoxes = new Map<string, Box>();

  /** The canvas-space box an actor occupies, for hit-testing and for the overlay layer. */
  boxOf(id: string): Box | undefined {
    return this.boxes.get(id);
  }

  /**
   * The canvas-space box an actor's desk occupies — screen, surface and all.
   *
   * Separate from `boxOf` because the two answer different questions: a person is wherever they
   * currently are, and a desk is where their work lives whether they are sitting at it or standing
   * across the room arguing with somebody.
   */
  deskBoxOf(id: string): Box | undefined {
    return this.deskBoxes.get(id);
  }

  /** Where an off-site agent's avatar sits in the strip along the bottom, if it is shown at all. */
  ghostBoxOf(id: string): Box | undefined {
    return this.ghostBoxes.get(id);
  }

  /** Forgets everything — a session switch replays a different room from scratch. */
  reset(): void {
    this.mem.clear();
    this.boxes.clear();
    this.deskBoxes.clear();
    this.deskPapers.clear();
    this.ghostBoxes.clear();
    this.t = 0;
    this.doorOpen = 0;
    // Not `night`: the theme belongs to the viewer, not to the session being shown. Everything
    // above is a memory of one room and has to go with it.
  }

  draw(ctx: CanvasRenderingContext2D, input: SceneInput): void {
    const dt = Number.isFinite(input.dt) ? Math.max(0, Math.min(100, input.dt)) : 0;
    // The effect clock, which stops entirely for a viewer who asked for reduced motion. The
    // *simulation's* clock is `dt` and keeps running: where somebody is standing is information,
    // and freezing that would leave the room lying about who is at their desk.
    if (!input.still) this.t += dt;
    // Ease toward the requested light level at about a second and a half for the full swing. A
    // still viewer gets the new light immediately rather than a slow dissolve across the room.
    this.night += (input.night - this.night) * (input.still ? 1 : Math.min(1, dt / 600));
    const night = this.night;
    const t = this.t;

    this.step(input, dt);
    this.doorOpen = input.still ? 0 : Math.max(0, this.doorOpen - dt / 900);

    // --- the shell ------------------------------------------------------------------
    ENV.drawWall(ctx, night, t);
    ENV.drawFloor(ctx, night);

    for (const x of WALL_FIXTURES.windows) ENV.drawWindow(ctx, x, WALL_FIXTURES.windowBase, night, t);
    ENV.drawVent(ctx, WALL_FIXTURES.vent.x, WALL_FIXTURES.vent.y);
    paintFixture(ctx, 'whiteboard', input);
    for (const a of WALL_FIXTURES.art) ENV.drawWallArt(ctx, a.x, a.y, a.variant);
    ENV.drawClock(ctx, WALL_FIXTURES.clock.x, WALL_FIXTURES.clock.y, (t / 60000) % 1);
    FUR.drawShelf(ctx, WALL_FIXTURES.shelf.x, WALL_FIXTURES.shelf.y);
    for (const x of WALL_FIXTURES.lamps) ENV.drawCeilingLamp(ctx, x, 9, night);
    ENV.drawDoor(ctx, sx(WAYPOINTS.door.x), FLOOR_Y + 1, this.doorOpen);

    // --- light on the floor, under everything that stands on it ---------------------
    // Daylight wedges by day, lamp pools by night; both are on at dusk, which is the good hour.
    const dayLight = 1 - night;
    for (const x of WALL_FIXTURES.windows) {
      if (dayLight <= 0.02) continue;
      FX.lightShaft(ctx, x, FLOOR_Y, FLOOR_Y + 78, 30, 56, PAL.day, 0.3 * dayLight);
    }
    for (const x of WALL_FIXTURES.lamps) {
      if (night <= 0.02) continue;
      pool(ctx, x, FLOOR_Y + 30, 54, 26, PAL.lmp, 0.2 * night);
    }
    // The rug's centre, in canvas pixels. It used to be written as `sx(305)`, which scaled a
    // number that was already scaled and parked the rug under the pod desks instead of under the
    // table it belongs to — the two coordinate systems look identical until one of them is wrong.
    ENV.drawRug(ctx, RUG_CENTRE.x, RUG_CENTRE.y);

    // --- everything that stands on the floor, sorted by the row it stands on --------
    const layers: Layered[] = [];
    this.dressRoom(ctx, layers, input, night, t);
    this.workstations(ctx, layers, input, night, t);
    this.people(ctx, layers, input, t);
    layers.sort((a, b) => a.y - b.y);
    for (const l of layers) l.draw();

    // --- the air --------------------------------------------------------------------
    FX.steam(ctx, KITCHEN.machine.x + 2, KITCHEN.machine.y - 15, t, 7, 0.9);
    for (let i = 0; i < WALL_FIXTURES.windows.length; i++) {
      if (dayLight <= 0.05) break;
      const x = WALL_FIXTURES.windows[i];
      FX.dust(ctx, x - 22, FLOOR_Y, 44, 62, t, 9, 0.3 * dayLight);
    }

    // --- who asked whom -------------------------------------------------------------
    // Above the floor and below the labels: a spawn edge is about the room, so it belongs over
    // the furniture, but a name has to survive crossing one.
    this.spawnLines(ctx, input);

    // --- overlays: labels and bubbles, above every body in the room -----------------
    this.overlays(ctx, input, t);

    // --- grade ----------------------------------------------------------------------
    FX.nightGrade(ctx, night);
    FX.vignette(ctx, 0.3);

    if (input.ghosts.length > 0) this.ghostDeck(ctx, input, t);
  }

  // ------------------------------------------------------------- per-frame state

  /** Advances every actor's render memory: facing, footsteps, bubble age, idle pops. */
  private step(input: SceneInput, dt: number): void {
    const live = new Set<string>();
    for (const a of input.actors) {
      live.add(a.id);
      const x = sx(a.x);
      const y = sy(a.y);
      let m = this.mem.get(a.id);
      if (!m) {
        const seed = hash(a.id);
        m = {
          px: x,
          py: y,
          dir: 'front',
          flip: false,
          stillMs: 0,
          stepAcc: 0,
          walkAcc: 0,
          speed: 0,
          turnMs: 0,
          linkAge: 0,
          resolved: a.resolved,
          puffs: [],
          sayMs: 0,
          seed,
          hairStyle: seed % Math.max(1, CH.HAIR_STYLES),
        };
        this.mem.set(a.id, m);
        this.doorOpen = 1; // somebody just came in
      }

      const dx = x - m.px;
      const dy = y - m.py;
      const moved = Math.hypot(dx, dy);

      m.turnMs = Math.max(0, m.turnMs - dt);

      if (a.pose === 'walk' && moved > 0.01) {
        // Facing from the movement itself, which is the only place the information exists.
        const dir: CH.CharDir = Math.abs(dx) >= Math.abs(dy) ? 'side' : dy < 0 ? 'back' : 'front';
        const flip = dir === 'side' ? dx < 0 : false;
        // A change of facing takes a couple of frames rather than happening between them. Turning
        // on the spot is the single cheapest thing that stops a walking crowd reading as a set of
        // sprites teleporting between orientations at every corner of the route.
        if (dir !== m.dir || flip !== m.flip) m.turnMs = TURN_MS;
        m.dir = dir;
        m.flip = flip;
        m.stillMs = 0;
        m.stepAcc += moved;
        m.walkAcc += moved;
        if (m.stepAcc >= 7) {
          m.stepAcc = 0;
          // Dust is decoration, and a still viewer gets none of it. Raising puffs that could never
          // age out — their clock is frozen — would leave a permanent trail across the floor.
          if (!input.still) m.puffs.push({ x, y, age: 0 });
        }
      } else {
        m.stillMs += dt;
        if (a.pose === 'sit') {
          if (m.dir !== 'back') m.turnMs = TURN_MS;
          m.dir = 'back';
          m.flip = false;
        } else if (a.pose === 'stand') {
          // Turned to the room to speak: face the camera, keeping whichever side they came from.
          if (m.dir !== 'front') m.turnMs = TURN_MS;
          m.dir = 'front';
        }
      }

      // Speed, as a fraction of a full walk, smoothed.
      //
      // The simulation walks at exactly one speed and stops dead, because it integrates a route
      // rather than a body. Chasing the measured speed rather than reading it gives the ramp at
      // each end of a trip for free and without touching the engine: a step or two of shortening
      // stride as somebody arrives, which is the difference between settling and being switched
      // off. It is honest about the room — the actor really is slowing to a stop — and it is the
      // renderer's business, which is where the rest of the facing derivation already lives.
      const want = dt > 0 ? Math.min(1, moved / (dt * FULL_SPEED_PX_PER_MS)) : m.speed;
      m.speed += (want - m.speed) * Math.min(1, dt / SPEED_EASE_MS);

      m.px = x;
      m.py = y;

      if (input.still) m.puffs.length = 0;
      else {
        for (const p of m.puffs) p.age += dt / 620;
        m.puffs = m.puffs.filter((p) => p.age < 1);
      }

      if (a.say !== undefined) {
        if (m.saying !== a.say) {
          m.saying = a.say;
          m.sayMs = 0;
        }
        m.sayMs += dt;
      } else {
        m.saying = undefined;
        m.sayMs = 0;
      }

      // The spawn edge ages here rather than in the engine: how old a line is, is a question about
      // drawing it, and the simulation should not be carrying a number only a paintbrush reads.
      if (a.link) {
        if (m.linkTo !== a.link.child) {
          m.linkTo = a.link.child;
          m.linkAge = 0;
        }
        m.linkAge = Math.min(1, m.linkAge + dt / LINK_MS);
      } else {
        m.linkTo = undefined;
        m.linkAge = 0;
      }

      // The moment a tool call comes back. The engine reports a monotonic count rather than an
      // edge, so the edge is found by differencing — and a reaction is a presentation decision
      // anyway: the room celebrates, the simulation just knows the number went up.
      if (a.resolved !== m.resolved) {
        const worse = a.lastOk === false;
        m.resolved = a.resolved;
        // Only a *streak* of failures is worth a reaction. One failed grep is a Tuesday.
        if (worse && a.fails >= FAILS_BEFORE_MESS) m.react = { kind: 'slump', age: 0 };
        else if (!worse && a.fails === 0 && a.act === undefined) m.react = { kind: 'cheer', age: 0 };
      }
      if (m.react) {
        m.react.age += dt / REACT_MS;
        if (m.react.age >= 1) m.react = undefined;
      }

      // An emote pop: `!` the moment a verdict comes back bad, `?` after a long idle stretch.
      const errored = input.agents[a.id]?.errored === true;
      if (m.emote) {
        m.emote.age += dt / 1400;
        if (m.emote.age >= 1) m.emote = undefined;
      } else if (errored && a.say !== undefined && a.verdict === 'err') {
        m.emote = { kind: '!', age: 0 };
      } else if (a.pose === 'sit' && a.busy === 0 && m.stillMs > 9000) {
        m.emote = { kind: '?', age: 0 };
        m.stillMs = 0;
      }
    }

    // An actor that left the roster (a session switch mid-flight) must not keep its memory, or a
    // later agent that hashes to the same id would inherit a stale position and a stale bubble.
    for (const id of [...this.mem.keys()]) if (!live.has(id)) this.mem.delete(id);
  }

  // ------------------------------------------------------------------- layers

  private dressRoom(
    ctx: CanvasRenderingContext2D,
    layers: Layered[],
    input: SceneInput,
    night: number,
    t: number,
  ): void {
    // The kitchen corner.
    layers.push({
      y: KITCHEN.fridge.y,
      draw: () => FUR.drawFridge(ctx, KITCHEN.fridge.x, KITCHEN.fridge.y),
    });
    layers.push({
      y: KITCHEN.counter.y,
      draw: () => {
        FUR.drawCounter(ctx, KITCHEN.counter.x, KITCHEN.counter.y, KITCHEN.counter.w);
        PR.drawCoffeeMachine(ctx, KITCHEN.machine.x, KITCHEN.machine.y, true, t);
        PR.drawMug(ctx, KITCHEN.machine.x + 9, KITCHEN.machine.y, false);
      },
    });
    layers.push({
      y: KITCHEN.cooler.y,
      draw: () => PR.drawWaterCooler(ctx, KITCHEN.cooler.x, KITCHEN.cooler.y),
    });

    // The break corner's furniture. Sorted into the floor layer like everything else, so somebody
    // standing behind the couch is drawn behind it and somebody in front of it is not.
    layers.push({
      y: LOUNGE.table.y,
      draw: () => FUR.drawLoungeTable(ctx, LOUNGE.table.x, LOUNGE.table.y),
    });
    // No stools drawn here: a perched character brings its own, and drawing a second one under it
    // put two stools in the same nine pixels. An unoccupied table place is simply floor.
    layers.push({ y: LOUNGE.couch.y, draw: () => FUR.drawCouch(ctx, LOUNGE.couch.x, LOUNGE.couch.y) });
    layers.push({ y: LOUNGE.ash.y, draw: () => FUR.drawAshStand(ctx, LOUNGE.ash.x, LOUNGE.ash.y) });

    for (const d of DRESSING) {
      layers.push({
        y: d.y,
        draw: () => {
          switch (d.kind) {
            case 'plant':
              return PR.drawPlant(ctx, d.x, d.y, d.size as 0 | 1 | 2, FX.sway(t, d.x));
            case 'cabinet':
              return FUR.drawCabinet(ctx, d.x, d.y, d.variant);
            case 'printer':
              return PR.drawPrinter(ctx, d.x, d.y, (Math.sin(t / 2600 + 1) + 1) / 2);
            case 'coatrack':
              return PR.drawCoatRack(ctx, d.x, d.y);
            case 'bin':
              return PR.drawBin(ctx, d.x, d.y);
            case 'box':
              return PR.drawBox(ctx, d.x, d.y);
          }
        },
      });
    }

    // The roundtable and its three chairs, on the rug. The table itself is painted through the
    // fixture record, because it is also a thing the room can be clicked on — the chairs are not.
    const { cx: tx, yBase: ty } = FIXTURES.roundtable;
    layers.push({
      y: ty - 1,
      draw: () => {
        FUR.drawTableChair(ctx, tx, ty - 22, 'back');
        paintFixture(ctx, 'roundtable', input);
      },
    });
    layers.push({ y: ty + 8, draw: () => FUR.drawTableChair(ctx, tx - 26, ty + 8, 'side') });
    layers.push({ y: ty + 8, draw: () => FUR.drawTableChair(ctx, tx + 26, ty + 8, 'side') });

    void night;
  }

  /** One workstation per seated agent, plus the clutter that makes two desks look unalike. */
  private workstations(
    ctx: CanvasRenderingContext2D,
    layers: Layered[],
    input: SceneInput,
    night: number,
    t: number,
  ): void {
    this.deskBoxes.clear();

    // Every desk the floor plan draws, occupied or not — not only the ones with somebody at them.
    //
    // Drawing one desk per actor was fine while nobody ever left. With hot-desking a chair comes
    // free part-way through a session, and a room whose furniture vanishes along with the person
    // reads as the office being dismantled around the survivors. A desk is a desk: when its agent
    // goes home it stays, tidied, chair pushed in, screen dark, with the paper they got through
    // still stacked on it — which is what an office looks like at seven in the evening, and which
    // is also the only place the room can still say what that agent cost.
    const byDesk = new Map<number, ActorState>();
    for (const a of input.actors) byDesk.set(a.deskIndex, a);

    for (const deskIndex of DESK_INDICES) {
      const a = byDesk.get(deskIndex);
      const manager = deskIndex === MANAGER_DESK_INDEX;
      const seat = manager ? WAYPOINTS.managerSeat : podSeat(deskIndex);
      const cx = Math.round(sx(seat.x));
      const base = Math.round(sy(seat.y)) - DESK_ABOVE_SEAT;
      const deskW = manager ? FUR.DESK.manager.w : FUR.DESK.pod.w;
      const surface = base - DESK_SURFACE;
      const clutterX = cx - (manager ? 24 : 16);

      if (a === undefined) {
        // An empty desk. The remembered paper stack is the one thing left of whoever had it.
        const left = this.deskPapers.get(deskIndex) ?? 0;
        layers.push({
          y: base,
          draw: () => {
            FUR.drawDesk(ctx, cx, base, manager ? 'manager' : 'pod');
            FUR.drawMonitor(ctx, cx - (manager ? 12 : 0), surface, {
              on: false,
              tint: PAL.gry,
              flicker: 0,
              t,
              screen: 'blank',
              mood: 'done',
            });
            PR.drawKeyboard(ctx, cx - (manager ? 10 : 0), surface + 6, 0);
            PR.drawMouse(ctx, cx + (manager ? 12 : 11), surface + 6);
            if (left > 0) PR.drawPapers(ctx, cx - (manager ? 24 : 16), surface + 6, left);
            FUR.drawChair(ctx, cx, base + 4, 'back', 0, true);
          },
        });
        continue;
      }

      const deskTop = deskTopOf(a);
      this.deskBoxes.set(a.id, {
        x: cx - deskW / 2,
        y: deskTop,
        w: deskW,
        h: base - deskTop + (manager ? FUR.DESK.manager.h : FUR.DESK.pod.h),
      });
      const agent = input.agents[a.id];
      const tint = agent?.look.tint ?? PAL.acc;
      // "Working" is an open tool call, not a non-empty status line. The status line also carries
      // the running token total, which never goes back to empty — read that way, every desk in the
      // room was lit and typing for the rest of the session the moment its agent said anything.
      const working = a.pose === 'sit' && a.busy > 0;
      const seed = this.mem.get(a.id)?.seed ?? hash(a.id);
      const done = a.done === true;
      const screen = screenFor(a);
      const mood = moodFor(a);
      // A desk deep in paper is a desk that has spent a lot. No number: the top bar has the
      // figure, and a figure at this size is four illegible glyphs anyway.
      const sheets = paperFor(agent?.tokens ?? 0);
      this.deskPapers.set(deskIndex, sheets);

      layers.push({
        y: base,
        draw: () => {
          // A warm pool under the lamp, on the desk and the floor around it.
          if (night > 0.05 && !done) pool(ctx, cx, base + 2, 34, 16, PAL.lmp, 0.26 * night);
          FUR.drawDesk(ctx, cx, base, manager ? 'manager' : 'pod');

          const glow = working ? FX.flicker(t, seed) : 0;
          FUR.drawMonitor(ctx, cx - (manager ? 12 : 0), surface, {
            // A monitor is on unless its owner has gone home. It used to be on only while a tool
            // call was open, which meant a room of people thinking read as a room of dead screens.
            on: !done,
            tint,
            flicker: glow,
            t,
            screen,
            mood,
          });
          if (manager) {
            FUR.drawMonitor(ctx, cx + 17, surface - 2, {
              on: !done,
              tint: PAL.ok,
              flicker: glow,
              t,
              small: true,
              screen,
              mood,
            });
          }
          if (working) FX.screenGlow(ctx, cx - (manager ? 12 : 0), surface + 2, 20, 9, 0.5 * glow);

          PR.drawKeyboard(ctx, cx - (manager ? 10 : 0), surface + 6, working ? FX.flicker(t, seed + 3) : 0);
          PR.drawMouse(ctx, cx + (manager ? 12 : 11), surface + 6);
          PR.drawDeskLamp(ctx, cx + (manager ? 26 : 18), surface + 5, night > 0.35 && !done);

          // A desk whose agent has finished and gone is *tidy*: no mug, no clutter, nothing left
          // out. That, the blank screen and the pushed-in chair are what "done" looks like from
          // across the room without a single word on screen.
          // The left-hand slot is the only clear space on a desk this size — the monitor owns the
          // middle, and the mouse and the lamp own the right. The spend gets it, because a stack
          // of paper that grows is worth more than a mug that never changes; the seeded clutter
          // keeps the slot only on desks that have not spent enough to show a stack yet, which is
          // also the only time the room needs something else to tell two desks apart.
          if (sheets > 0) PR.drawPapers(ctx, clutterX, surface + 6, sheets);
          else if (!done) {
            if (seed % 3 === 0) PR.drawMug(ctx, clutterX, surface + 6, working);
            else if (seed % 3 === 1) PR.drawBooks(ctx, clutterX, surface + 6);
            else PR.drawMug(ctx, clutterX, surface + 6, false);
          }
          if (!done && seed % 5 === 0) {
            PR.drawPlant(ctx, cx + (manager ? 22 : 15), surface + 6, 0, FX.sway(t, seed));
          }

          // The chair belongs to the desk, not to the person.
          //
          // It used to be drawn only by whoever was sitting in it, so the moment an agent stood up
          // to walk a note across the room its chair went with it and the desk was left as a slab
          // with a monitor on it. Anybody away from their own desk leaves an empty chair behind,
          // turned a little, exactly as they left it.
          if (a.pose !== 'sit') {
            FUR.drawChair(ctx, cx, base + 4, 'back', FX.sway(t, seed) * 0.6, done);
          }

          // A desk that keeps failing ends up with paper on the floor around it.
          if (a.fails >= FAILS_BEFORE_MESS) {
            PR.drawScatter(ctx, cx, base + 3, Math.min(6, a.fails - FAILS_BEFORE_MESS + 1), seed);
          }
        },
      });

      // Steam is drawn with the air, not with the desk, so it rises over the monitor behind it.
      if (working && !done && seed % 3 === 0) {
        layers.push({
          y: base + 0.5,
          draw: () => FX.steam(ctx, clutterX, surface + 1, t, seed, 0.6),
        });
      }
    }
  }

  private people(
    ctx: CanvasRenderingContext2D,
    layers: Layered[],
    input: SceneInput,
    t: number,
  ): void {
    this.boxes.clear();
    // Whoever is speaking right now, for the head-turn. One glance target for the whole room: two
    // people talking at once is rare, and everybody turning to a different one reads as chaos.
    const speaker = input.actors.find((a) => a.say !== undefined);

    for (const a of input.actors) {
      const m = this.mem.get(a.id);
      if (!m) continue;
      const agent = input.agents[a.id];
      const look = CH.lookOf(agent?.look ?? { tint: PAL.acc, color: PAL.acc, skin: '#E2A87C', hair: '#2E2A26' });
      const x = Math.round(m.px);
      const y = Math.round(m.py);
      const dim = dimmed(input, a.id);
      const seated = a.pose === 'sit';
      const act = actOf(a, m, seated, t);
      // A one-pixel head turn toward whoever is talking. It costs almost nothing and it is the
      // single clearest signal that these are people in a room rather than sprites on a grid.
      const glance: -1 | 0 | 1 =
        speaker && speaker.id !== a.id && a.say === undefined
          ? Math.abs(sx(speaker.x) - m.px) < 4
            ? 0
            : sx(speaker.x) < m.px
              ? -1
              : 1
          : 0;
      // The chair swivels only when its occupant is actually spinning it. `idleAct` reports the
      // schedule for standing people too, and a chair turning under an empty desk is a poltergeist.
      const spinning = seated && a.busy === 0 && CH.idleAct(t, m.seed) === 'spin';

      this.boxes.set(a.id, { x: x - CH.CHAR.w / 2, y: y - CH.CHAR.h, w: CH.CHAR.w, h: CH.CHAR.h });

      layers.push({
        y,
        draw: () => {
          for (const p of m.puffs) FX.footPuff(ctx, p.x, p.y, p.age);
          CH.drawShadow(ctx, x, y, 12, dim ? 0.18 : 0.32);
          CH.drawChar(ctx, x, y, {
            act,
            dir: m.dir,
            look,
            t,
            flip: m.flip,
            alpha: dim ? 0.55 : 1,
            blink: FX.blinkOn(t, m.seed),
            seed: m.seed,
            hairStyle: m.hairStyle,
            dist: m.walkAcc,
            speed: m.speed,
            turning: m.turnMs > 0,
            glance,
            seated,
            // Height varies by seed — except in a chair, where it very nearly does not.
            //
            // Two reasons, and the second is why this is a clamp and not a shrug. Sitting *does*
            // level people out in life: seated height is mostly torso, and the legs that carry
            // most of the difference are folded under the desk. And the room draws the chair back
            // in *front* of a seated person, so the only part of them anyone can see is the head
            // above it — take three pixels off a 24-pixel figure and half that face goes behind
            // the mesh, which turned a room of twelve people into a room of twelve empty chairs.
            height: seated ? Math.max(CH.CHAR.h - 1, CH.charHeight(m.seed)) : undefined,
          });
          // The chair goes in *front* of whoever is in it. Someone at their desk faces away from
          // the camera, so what you actually see of a seated person is a head and a pair of
          // shoulders over a chair back — drawing the chair behind them turned every workstation
          // into a person sitting on the floor with a chair parked politely out of the way.
          if (seated) {
            FUR.drawChair(ctx, x, y + 6, 'back', spinning ? Math.sin(t / 190) : FX.sway(t, m.seed) * 0.4);
          }
          if (input.selected === a.id) selectionRing(ctx, x, y);
        },
      });
    }
  }

  /**
   * Parent→child edges: who asked whom, and for what.
   *
   * `parentId`, `spawnDepth` and `workflowId` have been in the client's state since the first
   * build and were drawn absolutely nowhere, so the one question a fan-out actually raises — where
   * did all these people come from — had no answer anywhere in the room. This is the reference
   * mockup's "ASSIGN TASK" arrow: a dotted line from the parent to the child it just made, holding
   * the brief, for about two seconds.
   *
   * Drawn from head to head rather than desk to desk, because the child is walking in through the
   * door when its line appears and its desk is not where anybody is looking.
   */
  private spawnLines(ctx: CanvasRenderingContext2D, input: SceneInput): void {
    for (const a of input.actors) {
      if (!a.link) continue;
      const m = this.mem.get(a.id);
      const kid = this.mem.get(a.link.child);
      // No line to somebody who is not in the room: a child that landed off-site has no position
      // to point at, and an arrow into the ghost strip would be pointing at a decoration.
      if (!m || !kid) continue;
      const tint = input.agents[a.id]?.look.tint ?? PAL.acc;
      PR.drawLink(
        ctx,
        Math.round(m.px),
        Math.round(m.py) - CH.CHAR.h,
        Math.round(kid.px),
        Math.round(kid.py) - CH.CHAR.h,
        a.link.label,
        m.linkAge,
        tint,
      );
    }
  }

  /**
   * Names, statuses, bubbles and pops — all of them above every body in the room.
   *
   * Plates are laid out before any of them is drawn, because they collide. Agents converge: three
   * of them walk to the manager's desk at once and their plates land on the same twenty pixels of
   * wall, and what you get is a smear no single name survives. So each plate is nudged upward
   * until it clears the ones already placed — the same thing a person does with sticky notes.
   */
  private overlays(ctx: CanvasRenderingContext2D, input: SceneInput, t: number): void {
    const sorted = [...input.actors].sort((a, b) => a.y - b.y);

    type Plate = { a: ActorState; m: Mem; x: number; y: number; w: number; h: number; label: string };
    const placed: Plate[] = [];

    for (const a of sorted) {
      const m = this.mem.get(a.id);
      if (!m) continue;
      const selected = input.selected === a.id;
      // Nobody in the break corner gets a plate unless you ask for it.
      //
      // Nine finished agents standing within sixty pixels of each other produced nine labels in
      // the same twenty pixels of wall, and the collision nudge gave up and overlapped them — a
      // solid block of unreadable text with the office somewhere behind it. Their names are on the
      // roster, the inspector and their own accessible element; what the corner needs to say is
      // "these people are done", and it says that by being full.
      if (a.lounging && !selected) continue;
      const label = plateLabel(input.agents[a.id]?.label ?? a.id);
      const x = Math.round(m.px);
      const headY = Math.round(m.py) - CH.CHAR.h;
      // A seated agent's head is *behind* their desk and their monitor, so a plate hung over the
      // head lands on the screen. Hang it over whichever of the two is higher instead.
      //
      // `pose === 'sit'` is not the same question as "has a desk". An agent that has just finished
      // is given up its chair immediately — `deskIndex` becomes the lounge sentinel — but stays
      // sitting for the beat before it stands, and asking where its desk is during that beat is
      // asking about a desk it no longer has.
      const atDesk = a.deskIndex >= 0 || a.deskIndex === MANAGER_DESK_INDEX;
      const wantY = (a.pose === 'sit' && atDesk ? Math.min(headY, deskTopOf(a)) : headY) - 2;
      const w = textWidth(label) + 6;
      const h = selected && a.status ? 14 : 8;

      let y = wantY;
      for (let tries = 0; tries < 4; tries++) {
        const hit = placed.find(
          (p) => Math.abs(p.x - x) < (p.w + w) / 2 + 2 && y > p.y - p.h - 1 && y - h < p.y + 1,
        );
        if (!hit) break;
        y = hit.y - hit.h - 2;
      }
      // A plate that had to climb more than a couple of rows to find space has stopped being a
      // label for the person underneath it — six agents converging on the manager's desk would
      // otherwise stack their names all the way into the ceiling, perfectly legible and attached
      // to nobody. Past that, overlapping where it belongs beats readable where it does not.
      if (y < wantY - PLATE_MAX_CLIMB) y = wantY;
      placed.push({ a, m, x, y: Math.max(FONT_HEIGHT + 2, y), w, h, label });
    }

    for (const p of placed) {
      const { a, m } = p;
      const selected = input.selected === a.id;
      const dim = dimmed(input, a.id);
      // Name only, unless this is the agent the rest of the UI is looking at. A dozen two-line
      // plates in a room 270 pixels tall is a wall of text with an office somewhere behind it;
      // the status is one glance away in the rail and the inspector.
      PR.nameplate(ctx, p.x, p.y, p.label, input.agents[a.id]?.look.tint ?? PAL.wht, {
        sub: selected && a.status ? a.status : undefined,
        selected,
        dim,
      });

      const top = p.y - p.h;
      if (a.think !== undefined) {
        PR.thoughtBubble(ctx, p.x, top, a.think, t, 96);
      } else if (a.say !== undefined && m.saying) {
        // The reveal runs at roughly forty characters a second and then holds, so a long line
        // finishes well inside the five seconds the engine keeps the bubble up.
        PR.speechBubble(ctx, p.x, top, m.saying, {
          reveal: Math.min(1, m.sayMs / (m.saying.length * 25 + 200)),
          verdict: a.verdict,
          maxW: 108,
        });
      }
      if (m.emote) {
        PR.emotePop(ctx, p.x + 10, Math.round(m.py) - CH.CHAR.h - 1, m.emote.kind, m.emote.age);
      }
    }
  }

  /**
   * The off-site strip.
   *
   * The room seats twelve and a single workflow spawns forty; the surplus used to be one line of
   * text saying so. They are all in `RtState` with a live status, so they are drawn — small, in a
   * band of their own, still recognisably people rather than a number.
   */
  private ghostDeck(ctx: CanvasRenderingContext2D, input: SceneInput, t: number): void {
    const y0 = PIX.h - GHOST_BAND_H;
    rect(ctx, 0, y0, PIX.w, GHOST_BAND_H, PAL.out, 0.82);
    rect(ctx, 0, y0, PIX.w, 1, PAL.ou2);

    const label = `OFF-SITE ${input.ghosts.length}`;
    drawText(ctx, label, 4, y0 + 4, PAL.gry);
    const startX = textWidth(label) + 12;

    // Busy first, then everybody else in the order they arrived — which is also the order they
    // will be given chairs. Twenty-three anonymous heads in arrival order answered nothing; the
    // two questions a viewer actually has of this strip are "is any of that alive" and "who is
    // next in", and this sorting answers both without a word.
    const sorted = [...input.ghosts]
      .map((g, i) => ({ g, i }))
      .sort((a, b) => Number(b.g.busy) - Number(a.g.busy) || a.i - b.i)
      .map((e) => e.g);

    const pitch = CH.GHOST.w + 2;
    const room = Math.floor((PIX.w - startX - 30) / pitch);
    const shown = sorted.slice(0, Math.max(0, room));
    this.ghostBoxes.clear();
    shown.forEach((g, i) => {
      const gx = startX + i * pitch + CH.GHOST.w / 2;
      const top = y0 + GHOST_BAND_H - 5 - CH.GHOST.h;
      this.ghostBoxes.set(g.id, { x: gx - CH.GHOST.w / 2, y: top, w: CH.GHOST.w, h: CH.GHOST.h });
      CH.drawGhost(ctx, gx, y0 + GHOST_BAND_H - 5, CH.lookOf(g.look), g.busy ? t : 0, hash(g.id));
      // A mark under each head, coloured by what that agent is: working, finished, or waiting.
      // One pixel row is enough — this band is 26 pixels tall and holds up to forty people.
      const mark = g.done ? PAL.gry : g.busy ? PAL.ok : PAL.wrn;
      rect(ctx, gx - 2, y0 + GHOST_BAND_H - 4, 4, 1, mark, g.busy ? 1 : 0.7);
    });
    // Truncation is stated, never implied: a strip that quietly stopped at the edge would read as
    // the whole roster.
    if (shown.length < input.ghosts.length) {
      drawText(ctx, `+${input.ghosts.length - shown.length}`, PIX.w - 26, y0 + 4, PAL.wrn);
    }
  }
}

/**
 * Consecutive failures before the floor around a desk starts collecting paper.
 *
 * Two, not one: every long session has a `Grep` that finds nothing and a `Bash` that exits 1, and
 * a room that threw paper on the floor for each of them would be knee-deep by lunchtime and would
 * have stopped meaning anything. Two in a row is the point at which something is actually stuck.
 */
const FAILS_BEFORE_MESS = 2;

/**
 * Sheets of paper for a token total.
 *
 * Saturating rather than linear, because spend across a session's agents spans three orders of
 * magnitude: a linear scale makes every desk either bare or buried, and the interesting comparison
 * — this desk has cost noticeably more than that one — happens in the middle where a linear scale
 * has no resolution at all. 300k is the half-way point, which is roughly a busy subagent.
 */
function paperFor(tokens: number): number {
  if (!Number.isFinite(tokens) || tokens <= 0) return 0;
  return Math.round((14 * tokens) / (tokens + 300_000));
}

/**
 * The posture an actor is drawn in.
 *
 * This is the whole point of widening the command seam. The room could previously say "sitting" or
 * "typing", so twelve agents reading, editing, running builds and waiting on children were twelve
 * identical people hammering identical keyboards — the picture carried no more information than
 * the fact that something was happening. A tool *kind* is a body: somebody holding a page up is
 * doing something visibly different from somebody at a terminal, and you can tell from across the
 * room without reading a word.
 *
 * A reaction outranks the work, because a reaction is momentary and the work is not. Waiting on
 * children outranks the rest, because an agent whose only open call is a `Task` is not working —
 * it is waiting, and drawing it typing is a lie the room tells for as long as the child runs.
 */
/**
 * What somebody is doing in the break corner.
 *
 * The engine walks them to a place and stops; everything from there is presentation, so it is
 * decided here from the place they were given and their own seed. That split is deliberate — the
 * simulation should not be scripting whether a finished agent is having a cigarette, and it would
 * have to carry a field per activity if it did.
 */
function loungeAct(a: ActorState, seed: number, t: number): CH.CharAct {
  const slot = a.loungeSlot ?? 0;
  // Only the two places at the café table are somewhere to sit — and `perch` brings its own stool,
  // which is why the scene does not draw one there.
  if (slot === 0 || slot === 1) return 'perch';
  if (slot === 8) return 'smoke'; // the ash stand, which is the only reason it is there
  // Everyone else is on their feet by the counter, and they take turns holding forth. Staggered by
  // seed so a corner of six people is a conversation rather than a chorus.
  switch (Math.floor((t + (seed % 9000)) / LOUNGE_TURN_MS) % 3) {
    case 0:
      return 'chat';
    case 1:
      return 'drink';
    default:
      return 'idle';
  }
}

function actOf(a: ActorState, m: Mem, seated: boolean, t: number): CH.CharAct {
  if (m.react) return m.react.kind;
  if (a.pose === 'walk') return 'walk';
  if (a.lounging) return loungeAct(a, m.seed, t);
  if (!seated) {
    if (a.say !== undefined) return 'talk';
    // Standing and not speaking: at the window, at the table, at the coffee machine, or handing
    // work over. Only the last is knowable from the state, and only when a `Task` is open.
    if (a.act === 'delegate') return 'handoff';
    if (a.act === 'browse') return 'gaze';
    return 'idle';
  }
  // Seated.
  if (a.done) return 'sit';
  if (a.waiting > 0 && a.busy === a.waiting) return 'wait';
  switch (a.act) {
    case 'read':
    case 'browse':
      // Reading a file and reading a page are the same posture: a sheet held up. The *screen*
      // tells the two apart, which is where that distinction belongs.
      return 'read';
    case 'write':
    case 'run':
    case 'other':
      return 'type';
    case 'delegate':
      return 'wait';
    default:
      return a.busy > 0 ? 'type' : 'sit';
  }
}

/**
 * Whether an agent is outside what the viewer is currently looking at.
 *
 * A selection is a question — "what is this one doing?" — and the honest answer includes the
 * agents it spawned to do it. Dimming on `selected` alone greyed out the selected agent's own
 * children, which is the opposite of what clicking a parent asks for.
 */
function dimmed(input: SceneInput, id: string): boolean {
  if (input.selected === null) return false;
  if (input.selected === id) return false;
  return input.kin ? !input.kin.has(id) : true;
}

/** What is on an agent's screen: the shape of the work, not the name of the tool. */
function screenFor(a: ActorState): FUR.Screen {
  if (a.done) return 'blank';
  switch (a.act) {
    case 'read':
      // `Grep` and `Glob` are looking *for* something; `Read` is looking *at* something.
      return a.tool === 'Grep' || a.tool === 'Glob' ? 'search' : 'page';
    case 'write':
      return 'code';
    case 'run':
      return 'log';
    case 'browse':
      return 'page';
    case 'delegate':
      return 'link';
    case 'other':
      return 'code';
    default:
      // Between calls. The screen is still on and still has the last thing on it, quietly.
      return a.waiting > 0 ? 'wait' : 'code';
  }
}

/** How it is going: work blue, waiting amber, error red, done grey. */
function moodFor(a: ActorState): FUR.Mood {
  if (a.done) return 'done';
  if (a.fails > 0) return 'error';
  if (a.waiting > 0) return 'wait';
  return 'work';
}

/** How wide a nameplate's text may get, in canvas pixels — a little over a desk's own width. */
const PLATE_MAX_W = 58;

/** How far a nameplate may climb to dodge another one before it gives up and overlaps. */
const PLATE_MAX_CLIMB = 22;

/**
 * A label short enough to hang over a desk.
 *
 * An agent's label is the caller's own sentence for the task — "Research YouTube API upload
 * details and quota limits" — and hung over a desk at full length it is wider than the bank it
 * belongs to. Six of them at once was a stack of overlapping signs with an office somewhere
 * underneath. Cut at a word where a word is available, and at a character where one is not; the
 * full text is still on the plate's own accessible element, in the roster and in the inspector.
 */
function plateLabel(label: string): string {
  const s = label.trim();
  if (textWidth(s) <= PLATE_MAX_W) return s;
  const words = s.split(/\s+/);
  let out = '';
  for (const w of words) {
    const next = out ? `${out} ${w}` : w;
    if (textWidth(next) > PLATE_MAX_W) break;
    out = next;
  }
  if (out === '') {
    // One very long word: cut it, and say so with a trailing dot rather than pretending the name
    // simply ends there.
    out = s.slice(0, Math.max(1, Math.floor(PLATE_MAX_W / 4) - 1));
    return `${out}.`;
  }
  return out === s ? out : `${out}.`;
}

/**
 * The top row of an actor's own workstation — desk, monitor and all.
 *
 * Their nameplate hangs above this rather than above their head, because sitting at a desk means
 * being behind it: the head is lower on the screen than the screen is.
 */
function deskTopOf(a: ActorState): number {
  const manager = a.deskIndex === MANAGER_DESK_INDEX;
  const seat = manager ? WAYPOINTS.managerSeat : podSeat(a.deskIndex);
  const base = Math.round(sy(seat.y)) - DESK_ABOVE_SEAT;
  return base - DESK_SURFACE - (manager ? FUR.MONITOR.smallH + 2 : FUR.MONITOR.h);
}

/** A stepped ring under the selected actor — the room's half of the shell-wide selection. */
function selectionRing(ctx: CanvasRenderingContext2D, cx: number, y: number): void {
  for (let i = 0; i < 3; i++) {
    const w = 14 - i * 2;
    rect(ctx, cx - w / 2, y - i, w, 1, PAL.acc, 0.5 - i * 0.12);
  }
  rect(ctx, cx - 8, y - 1, 16, 1, PAL.acc, 0.65);
}

/**
 * The whiteboard: what the session was asked for, and how it is going.
 *
 * It used to be two wrapped lines of the prompt and a head count, which said what the office was
 * *for* and nothing at all about whether it was working. The tally and the spend bar are the whole
 * point: three marks and a rule are legible from across the room in a way "7/12 agents" at five
 * pixels tall never is.
 */
function boardOf(input: SceneInput): ENV.BoardState {
  const task = input.task.trim() || 'waiting for a task';
  const words = task.split(/\s+/);
  const lines: string[] = [];
  let line = '';
  for (const w of words) {
    const next = line ? `${line} ${w}` : w;
    // Narrower than the board is wide: the board draws its own frame and tray inside those pixels,
    // and wrapping to the outer width clipped the last letter off every line.
    if (textWidth(next) > 44 && line) {
      lines.push(line);
      line = w;
    } else {
      line = next;
    }
    // Two lines of task and no more. Letting the prompt have the whole board pushes off the only
    // part of it that ever changes.
    if (lines.length === 2) break;
  }
  if (lines.length < 2 && line) lines.push(line);

  let live = 0;
  let done = 0;
  let failed = 0;
  for (const a of input.actors) {
    if (!a.done) live += 1;
    else if (a.doneOk === false) failed += 1;
    else done += 1;
  }
  // Everyone who has already walked out is finished too — they are the reason the tally is worth
  // drawing at all, and counting only the people still on the floor would make the board reset
  // itself every time somebody left.
  for (const g of input.ghosts) {
    if (g.done) done += 1;
    else live += 1;
  }
  return { lines, live, done, failed, spend: input.spend };
}

/** Kept for the preview harness and for anything that needs the label font's metrics. */
export { drawText, drawTextOutlined, textWidth };
