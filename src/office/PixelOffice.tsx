/**
 * The room: a pixel-art canvas, the loop that drives it, and a transparent layer of real DOM
 * elements sitting exactly on top of the people it draws.
 *
 * Two things make this different from the DOM room it replaces.
 *
 * **React is not in the frame loop.** The simulation ticks and the scene repaints sixty times a
 * second; making that a `setState` would re-render the whole tree every frame for a walk across
 * the floor. The engine lives in a ref, the loop writes straight to the canvas, and React only
 * re-renders when the *cast* changes — someone new arrives, or the selection moves.
 *
 * **The canvas is not the accessibility story.** A canvas is a picture: a screen reader sees
 * nothing in it, a keyboard cannot reach into it, and a test cannot assert on it. So every actor
 * also gets a real focusable element, labelled and positioned over its sprite, updated
 * imperatively from the same loop. Clicking a person, tabbing to one, or asserting one is on
 * screen all work on those, not on pixels — the canvas is the paint, and the DOM is the room.
 *
 * The same argument is why the interaction layer — hover cards, desks, the whiteboard, the
 * roundtable — is DOM rather than hit-tested pixels. A painted tooltip is unreadable to everything
 * that is not an eye; a positioned `<div>` with text in it is readable by all three audiences at
 * once. Everything here is placed by `blitOf`, the one function that maps the buffer's coordinate
 * space onto the screen, and it is also the function the blit itself uses.
 *
 * That used to be written down as "there is no second copy of that arithmetic to drift", which was
 * not quite true and was nowhere asserted. There *is* a second copy: `toBuffer` is the inverse, and
 * an inverse is a copy in the only sense that matters, because it can stop inverting. It is what
 * the wheel zooms about and what a click on a person is resolved through, so if it and `blitOf`
 * ever disagree the room becomes unclickable in exactly the way that is hardest to see. So the two
 * are now held to each other by a round-trip property in `tests/pixel.test.ts` — buffer point to
 * screen and back — and that, rather than this paragraph, is what keeps them honest. The pure units
 * below are exported for it: nothing in this file's public surface exists for the tests' sake
 * alone, but nothing is hidden from them either.
 */
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type MutableRefObject } from 'react';
import { evSession } from '../../shared/events';
import { agentLook, type RtAgent } from '../store';
import { duration, money, tokens as fmtTokens, clip } from '../ui/format';
import type { EvSink } from '../ws';
import { Engine, type ActorState } from './engine';
import { mapEvent } from './mapping';
import { Recorder, Replay } from './replay';
import { PAL, PIX } from './pixel/art';
import { CEILING_H, fixtureBox, Scene, type Box, type Ghost, type SceneAgent } from './pixel/scene';
import {
  blitOf,
  CAM_HOME,
  clampCam,
  headroomBlits,
  toBuffer,
  ZOOM_MAX,
  ZOOM_MIN,
  type Blit,
  type Cam,
  type Geo,
} from './pixel/stage';
import './pixel.css';

/**
 * The longest frame the simulation is allowed to see. A backgrounded tab stops firing
 * `requestAnimationFrame` entirely, so the first frame after it returns carries the whole
 * absence — minutes of it — and every queued walk would resolve in one jump.
 */
const MAX_FRAME_MS = 100;

/**
 * The tick used when the viewer has asked for reduced motion: long enough that every queued walk
 * completes inside one step, so people appear at their desks rather than gliding there.
 */
const SETTLE_TICK_MS = 500;

/** One notch of wheel, and the coarser step the keyboard and the buttons take. */
const WHEEL_STEP = 1.12;
const KEY_STEP = 1.25;

/** Where a double-click lands you: close enough to read a nameplate, wide enough to keep context. */
const ZOOM_TO = 2.2;

/** Buffer pixels an arrow key moves the camera, before the zoom divides it. */
const PAN_STEP = 28;

/**
 * How far a pointer may travel before the gesture stops being a click and becomes a pan.
 *
 * A few pixels rather than zero because a mouse always moves a little between press and release,
 * and a room you cannot click because your hand shook is worse than one you cannot drag.
 */
const DRAG_SLOP = 4;

/** How often the live region is allowed to speak, so a busy room does not become a stream. */
const SAY_ANNOUNCE_MS = 900;

/**
 * What a full whiteboard spend bar means, in dollars.
 *
 * A display reference, not a budget — nothing here knows what a session is *supposed* to cost, and
 * the room should not pretend otherwise. The bar's job is to make "this is getting expensive"
 * legible from across the office without a figure; the exact figure lives in the top bar.
 */
const SPEND_FULL_USD = 25;

/**
 * The two fixtures the room can be clicked on, in buffer pixels — asked of the scene, not restated
 * here.
 *
 * They used to be two literals written as if each draw function's second argument were the
 * fixture's centre. It is its *base*: `drawWhiteboard` puts the board's bottom row on the row it is
 * handed, so a box centred there hung fourteen rows below the board, over the skirting and the
 * floorboards, and the task written on the board could not be clicked at all. The roundtable's was
 * wrong the same way in the other direction. Both are now one call each into the arithmetic that
 * does the painting, and there is no number left here to drift.
 *
 * Resolved once, at module scope: a fixture cannot move, and the frame loop should not be asking.
 */
const BOARD_BOX: Box = fixtureBox('whiteboard');
const TABLE_BOX: Box = fixtureBox('roundtable');

type Sim = {
  engine: Engine;
  roster: Set<string>;
  /**
   * Every command the office has been given, stamped with when it happened.
   *
   * This is the whole of what replay needs. The engine is deterministic by construction and takes
   * time through one door, so any moment of the session can be rebuilt by handing a fresh engine
   * the same commands and the real gaps between them — no snapshots, no undo log, no second copy
   * of the simulation.
   */
  log: Recorder;
  /** The scrubber's own engine, built lazily and only while somebody is actually scrubbing. */
  replay: Replay | null;
  /** The `Recorder.revision` `replay` was built from, so a stale snapshot is noticed. */
  replayRev: number;
  /**
   * The seating revision this room last told React about.
   *
   * It lives on the room rather than in the frame loop's closure because there is now a room per
   * session and only one loop: a counter held by the loop would be the *visible* room's, and
   * switching tabs would compare one room's revision against another's.
   */
  seatingSeen: number;
};

const freshSim = (): Sim => ({
  engine: new Engine(),
  roster: new Set<string>(),
  log: new Recorder(),
  replay: null,
  replayRev: -1,
  seatingSeen: -1,
});

const simOf = (ref: MutableRefObject<Sim | null>): Sim => (ref.current ??= freshSim());

/** One session's room, as the renderer needs it. */
export type OfficeRoom = {
  /** Read by the renderer's loop every frame; never state, so a tick costs no render. */
  sim: MutableRefObject<Sim | null>;
  /** The cast on the floor, as state — it changes when someone arrives or leaves, not when someone moves. */
  cast: readonly string[];
  /** Agents queued outside for a chair, longest-waiting first. */
  offsite: readonly string[];
};

/** Where a session with no id at all parks its room — before the first `sessionSeen` lands. */
const NO_SESSION = '';
const NO_IDS: readonly string[] = [];

export type OfficeFeed = {
  feed: EvSink;
  /** The room for one session, created the first time it is asked for. */
  room: (sessionId: string | null) => OfficeRoom;
  /**
   * Every room that exists, by session id.
   *
   * The frame loop needs all of them, not just the one on screen: a session you switched away
   * from still has agents walking around in it, and an engine that froze while its tab was hidden
   * would have to catch up in one jump the moment you looked back at it. Ticking a room is pure
   * arithmetic over a handful of actors, so the cheap and honest thing is to tick them all and
   * paint one.
   */
  rooms: MutableRefObject<Map<string, MutableRefObject<Sim | null>>>;
  /**
   * Told by the renderer's loop when a room's seating changes.
   *
   * Seating used to be decided at the moment an event arrived, and that was only tenable while
   * nobody ever left: with hot-desking a chair comes free part-way through a walk to the door,
   * which is a *simulation* event and happens in a tick, not in a socket frame. The engine owns
   * the seats and this is how React hears about it — on the frames it changes, which is a handful
   * per session, and never on the sixty a second where it does not.
   */
  sync: (sessionId: string, cast: readonly string[], offsite: readonly string[]) => void;
};

/**
 * The office half of the client: an event sink to hand to `useRtStream`, and one simulation per
 * session for the renderer to drive.
 *
 * There used to be exactly one room, because the client followed exactly one session. It now holds
 * one per session the hub is streaming, keyed by the session id every event already carries —
 * which is what lets a tab switch be a change of *view* rather than a demolition.
 *
 * `feed.reset` exists because the hub replays a session's whole backlog to every new connection,
 * so a reconnect replays history the office has already acted on. It takes a session id now: a
 * rewound transcript invalidates one room, and only that one should be rebuilt.
 */
export function useOffice(): OfficeFeed {
  const rooms = useRef(new Map<string, MutableRefObject<Sim | null>>());
  const feed = useRef<EvSink | null>(null);
  const [seats, setSeats] = useState<Record<string, { cast: readonly string[]; offsite: readonly string[] }>>({});

  /** The room's ref box, made on demand. Stable per session, so the loop can hold on to it. */
  const boxOf = (sessionId: string): MutableRefObject<Sim | null> => {
    let box = rooms.current.get(sessionId);
    if (!box) {
      box = { current: null };
      rooms.current.set(sessionId, box);
    }
    return box;
  };

  feed.current ??= {
    ev: (ev) => {
      const s = simOf(boxOf(evSession(ev)));
      for (const cmd of mapEvent(ev, s.roster)) {
        // The roster is every agent the office has heard of, seated or not: it is what
        // `mapEvent` resolves a confront's target against, and an agent waiting outside for a
        // chair is still an agent whose name can appear in somebody else's verdict.
        s.roster.add(cmd.agentId);
        s.log.record(ev.ts, cmd);
        s.engine.apply(cmd);
      }
    },
    reset: (sessionId) => {
      if (sessionId === null) {
        rooms.current.clear();
        setSeats({});
        return;
      }
      rooms.current.delete(sessionId);
      setSeats((prev) => {
        if (!(sessionId in prev)) return prev;
        const out = { ...prev };
        delete out[sessionId];
        return out;
      });
    },
  };

  const sync = useCallback(
    (sessionId: string, nextCast: readonly string[], nextOffsite: readonly string[]) => {
      // Returning the previous record when nothing moved is what makes this free: React bails out
      // of the render entirely when a setter returns the identical reference.
      setSeats((prev) => {
        const was = prev[sessionId];
        if (was && sameIds(was.cast, nextCast) && sameIds(was.offsite, nextOffsite)) return prev;
        return { ...prev, [sessionId]: { cast: nextCast, offsite: nextOffsite } };
      });
    },
    [],
  );

  const room = (sessionId: string | null): OfficeRoom => {
    const id = sessionId ?? NO_SESSION;
    const seat = seats[id];
    return { sim: boxOf(id), cast: seat?.cast ?? NO_IDS, offsite: seat?.offsite ?? NO_IDS };
  };

  return { feed: feed.current, room, rooms, sync };
}

const sameIds = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((id, i) => id === b[i]);

/*
 * The camera, the blit, its inverse and the strip above the room all moved to
 * `./pixel/stage.ts`. Not for tidiness: this file imports a stylesheet, so nothing inside it can be
 * loaded by the offline renderer that writes the review PNGs — and the arithmetic that decides
 * where the room lands on a screen is exactly the arithmetic a rendered picture is evidence about.
 * The strip above the ceiling was wrong for as long as it was, in part, because no sheet could show
 * it. Everything below still reads those functions; none of it owns them.
 */

// -------------------------------------------------------- the imperative layer

/**
 * What was last written to one DOM mark.
 *
 * The loop used to write `transform`, `width`, `height` and `aria-label` on every mark on every
 * frame — around eight hundred style writes a second for a room of thirteen, nearly all of them
 * setting a property to the value it already had. Comparing first is free; the write is not.
 * Keyed by the element itself and weak, so a mark that unmounts takes its record with it.
 */
type Wrote = {
  t: string;
  w: number;
  h: number;
  /** The last stacking order written, so depth costs one comparison rather than a style write. */
  z: number;
  label: string;
  /** The bubbles, resolved once rather than re-queried sixty times a second. */
  bubbles?: { say: HTMLElement | null; think: HTMLElement | null };
  sayTxt?: string;
  sayOn?: boolean;
  thinkTxt?: string;
  thinkOn?: boolean;
};

const wrote = new WeakMap<HTMLElement, Wrote>();

export function wroteOf(el: HTMLElement): Wrote {
  let w = wrote.get(el);
  if (!w) {
    w = { t: '', w: -1, h: -1, z: -1, label: '' };
    wrote.set(el, w);
  }
  return w;
}

/**
 * Moves a mark over its box in the buffer, writing only what actually changed.
 *
 * Exported for `tests/dom.test.ts`, which is the only cheap place the accessibility layer is
 * asserted: the Playwright test that fires `elementFromPoint` at an actor proves the same thing,
 * but the e2e job is manual-only in CI, so on an ordinary push this is the coverage.
 */
export function place(el: HTMLElement, box: Box, b: Blit): Wrote {
  const w = wroteOf(el);
  const left = Math.round(b.dx + (box.x - b.srcX) * b.px);
  const top = Math.round(b.dy + (box.y - b.srcY) * b.px);
  const t = `translate(${left}px, ${top}px)`;
  if (w.t !== t) {
    el.style.transform = t;
    w.t = t;
  }
  const width = Math.max(1, Math.round(box.w * b.px));
  if (w.w !== width) {
    el.style.width = `${width}px`;
    w.w = width;
  }
  const height = Math.max(1, Math.round(box.h * b.px));
  if (w.h !== height) {
    el.style.height = `${height}px`;
    w.h = height;
  }
  // Stacked by depth, exactly as the canvas paints them.
  //
  // The floor layer is drawn in row order so that nearer things occlude farther ones; the DOM over
  // it was in engine order, which is arrival order, so a pointer over two people standing close
  // together — a huddle, or the break corner — could land on whichever of them happened to have
  // been created first, including the one drawn *behind*. Clicking the person you can see is the
  // minimum a hit layer owes the picture it sits on.
  const z = Math.max(0, Math.round(box.y));
  if (w.z !== z) {
    el.style.zIndex = String(z);
    w.z = z;
  }
  return w;
}

/** Writes a bubble's text without re-rendering: `on` is what the e2e and the reader both read. */
export function setBubble(w: Wrote, cls: 'say' | 'think', text: string | undefined): void {
  const el = cls === 'say' ? w.bubbles?.say : w.bubbles?.think;
  if (!el) return;
  const on = text !== undefined;
  const seen = cls === 'say' ? w.sayTxt : w.thinkTxt;
  if (on && seen !== text) {
    el.textContent = text!;
    if (cls === 'say') w.sayTxt = text;
    else w.thinkTxt = text;
  }
  const was = cls === 'say' ? w.sayOn : w.thinkOn;
  if (was !== on) {
    el.classList.toggle('on', on);
    if (cls === 'say') w.sayOn = on;
    else w.thinkOn = on;
  }
}

/** Sets one text node, if and only if it is not already what it should be. */
function setText(el: Element | null | undefined, text: string): void {
  if (el && el.textContent !== text) el.textContent = text;
}

// ------------------------------------------------------------------ the tree

/**
 * Every agent at or below `root` in the spawn tree.
 *
 * `parentId` is the only edge there is, so the tree is rebuilt from it rather than cached: an
 * agent's parent is learned when its sidecar joins the two halves of a spawn, which can be long
 * after the child first appeared. Guarded against a cycle, because a malformed transcript is
 * allowed to be malformed and this is not allowed to hang the room.
 */
export function subtreeOf(agents: Readonly<Record<string, RtAgent>>, root: string): Set<string> {
  const kids = new Map<string, string[]>();
  for (const id of Object.keys(agents)) {
    const parent = agents[id]?.parentId;
    if (parent === undefined) continue;
    const list = kids.get(parent);
    if (list) list.push(id);
    else kids.set(parent, [id]);
  }
  const out = new Set<string>([root]);
  const stack = [root];
  while (stack.length > 0) {
    const id = stack.pop()!;
    for (const kid of kids.get(id) ?? []) {
      if (out.has(kid)) continue;
      out.add(kid);
      stack.push(kid);
    }
  }
  return out;
}

// -------------------------------------------------------------------- office

export type PixelOfficeProps = {
  office: OfficeFeed;
  /**
   * Which session's room to paint.
   *
   * Every other room keeps running; this only chooses the one on screen. `null` before the first
   * session is known, which is the room events with no session of their own fall into.
   */
  sessionId: string | null;
  agents: Readonly<Record<string, RtAgent>>;
  /** The session's opening prompt, for the whiteboard. */
  task: string;
  turns: number;
  selected: string | null;
  onSelect: (id: string | null) => void;
  /** Pixels of the stage's left edge covered by the roster rail, excluded from the fit. */
  insetLeft?: number;
  /** 0 by day, 1 after hours. The room re-lights itself rather than swapping a stylesheet. */
  night: number;
  /** Estimated USD spent so far, for the whiteboard's bar. */
  cost?: number;
  /**
   * A moment to show the room at, instead of now.
   *
   * `null` is live. Anything else rebuilds the office from the recorded command stream and paints
   * the room as it stood at that timestamp — the same simulation, wound back, which is what the
   * whole engine was kept deterministic for.
   */
  replayAt?: number | null;
  /** Clicking the whiteboard. Supplied or not; the hit target only exists when it is. */
  onOpenSession?: () => void;
  /** Clicking the roundtable — the fixture the cross-talk between agents belongs to. */
  onFilterCrossTalk?: () => void;
};

export const PixelOffice = memo(function PixelOffice({
  office,
  sessionId,
  agents,
  task,
  turns,
  selected,
  onSelect,
  insetLeft = 0,
  night,
  cost,
  replayAt = null,
  onOpenSession,
  onFilterCrossTalk,
}: PixelOfficeProps) {
  const wrap = useRef<HTMLDivElement | null>(null);
  const view = useRef<HTMLCanvasElement | null>(null);
  const layer = useRef<HTMLDivElement | null>(null);
  const marks = useRef(new Map<string, HTMLDivElement>());
  const desks = useRef(new Map<string, HTMLDivElement>());
  const ghostMarks = useRef(new Map<string, HTMLDivElement>());
  const peek = useRef<HTMLDivElement | null>(null);
  const board = useRef<HTMLButtonElement | null>(null);
  const table = useRef<HTMLButtonElement | null>(null);
  const crier = useRef<HTMLDivElement | null>(null);

  // Everything the loop reads but does not own, parked in refs so that changing any of it never
  // restarts the loop — a restarted loop drops the frame delta and jolts the room.
  const scene = useRef<Scene | null>(null);
  const buffer = useRef<HTMLCanvasElement | null>(null);
  /**
   * The ceiling, on its own small buffer: the room continued past its own first row.
   *
   * A second canvas rather than a taller first one, because the room's coordinate space is load
   * bearing. `toBuffer` inverts a placement written in it, `clampCam` bounds a camera written in
   * it, and every box the scene publishes is measured in it — growing the buffer upward would move
   * the origin and quietly invalidate all three. Rows above the room have no coordinates anybody
   * needs, so they get a buffer of their own and are blitted with the same scale, which is what
   * keeps their pixel grid on the room's.
   */
  const ceiling = useRef<HTMLCanvasElement | null>(null);
  const cam = useRef<Cam>({ ...CAM_HOME });
  const camWant = useRef<Cam>({ ...CAM_HOME });
  /** The stage's own measurements, so the handlers can invert the blit without the loop. */
  const geo = useRef<Geo>({ w: 0, h: 0, dpr: 1, insetLeft });
  /** One frame's worth of "point the camera at this person", consumed and cleared. */
  const look = useRef<string | null>(null);

  const [follow, setFollow] = useState(false);
  const [hover, setHover] = useState<string | null>(null);
  /**
   * The zoom, as the readout shows it.
   *
   * State, but never per frame: it is written when the *viewer* changes the zoom, which is a
   * handful of times a session. The camera itself eases toward `camWant` inside the loop and
   * React is not told about the frames in between.
   */
  const [zoom, setZoom] = useState(1);

  const roomId = sessionId ?? NO_SESSION;
  const room = office.room(sessionId);
  const cast = room.cast;
  /**
   * The room being painted, as the frame loop reads it.
   *
   * A ref rather than a captured value, because switching tabs must not restart the loop — a
   * restarted loop drops the frame delta and jolts every room, not only the one you switched to.
   */
  const sim = useRef(room.sim);
  sim.current = room.sim;
  const visibleId = useRef(roomId);
  visibleId.current = roomId;

  /**
   * The scene remembers one room, so switching to another one has to wipe what it remembers.
   *
   * It keeps a desk's accumulated paper stacks by *desk index* — deliberately, so clutter outlives
   * the agent that earned it — and each actor's last position by agent id. Neither survives a
   * change of session honestly: a brand-new session's empty desks would open already piled with the
   * previous session's work, and `main` exists in every session, so its remembered position would
   * be the other room's and the first frame would fling it across the office, raising a footstep
   * puff and a facing flip for a step nobody took.
   */
  useEffect(() => {
    scene.current?.reset();
  }, [roomId]);

  /** The selected agent's spawn tree. Everyone outside it is dimmed; `null` dims nobody. */
  const kin = useMemo(() => (selected === null ? null : subtreeOf(agents, selected)), [agents, selected]);

  /**
   * The spend bar's reading, 0..1.
   *
   * `SPEND_FULL_USD` is a *display reference*, not a budget and not a limit — nothing in this app
   * knows what a session is supposed to cost. The bar exists to make "this is getting expensive"
   * visible from across the room without a number; the number itself is in the top bar, exact, and
   * always one glance away.
   */
  const spend = Math.min(1, Math.max(0, (cost ?? 0) / SPEND_FULL_USD));

  const live = useRef({
    agents, task, turns, selected, kin, spend, insetLeft, night, replayAt,
    offsite: room.offsite, follow, hover,
  });
  live.current = {
    agents, task, turns, selected, kin, spend, insetLeft, night, replayAt,
    offsite: room.offsite, follow, hover,
  };
  const sync = useRef(office.sync);
  sync.current = office.sync;

  // A selection is a request to look at someone; clearing it hands the room back.
  useEffect(() => {
    if (selected === null) {
      setFollow(false);
      camWant.current = { ...CAM_HOME };
      setZoom(1);
      look.current = null;
      return;
    }
    // Point the camera at them once, on the next frame — the scene knows where they are and this
    // does not. At the default zoom the whole room is already in view and `clampCam` pins the
    // camera to its centre, so this is a no-op until somebody has actually zoomed in.
    look.current = selected;
  }, [selected]);

  useLayoutEffect(() => {
    const el = wrap.current;
    const canvas = view.current;
    if (!el || !canvas) return;

    buffer.current ??= (() => {
      const c = document.createElement('canvas');
      c.width = PIX.w;
      c.height = PIX.h;
      return c;
    })();
    ceiling.current ??= (() => {
      const c = document.createElement('canvas');
      c.width = PIX.w;
      c.height = CEILING_H;
      return c;
    })();
    scene.current ??= new Scene();

    const ctx = canvas.getContext('2d');
    const bctx = buffer.current.getContext('2d');
    const cctx = ceiling.current.getContext('2d');
    if (!ctx || !bctx || !cctx) return;
    bctx.imageSmoothingEnabled = false;
    cctx.imageSmoothingEnabled = false;

    let size = { w: 0, h: 0, dpr: 1 };
    const measure = (): void => {
      const r = el.getBoundingClientRect();
      const dpr = Math.min(3, Math.max(1, window.devicePixelRatio || 1));
      const w = Math.max(1, Math.round(r.width));
      const h = Math.max(1, Math.round(r.height));
      const g = geo.current;
      g.w = w;
      g.h = h;
      g.dpr = dpr;
      if (size.w === w && size.h === h && size.dpr === dpr) return;
      size = { w, h, dpr };
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;
      ctx.imageSmoothingEnabled = false;
    };
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    measure();

    const still =
      typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

    // The seating revision the DOM layer was last told about. A counter rather than a comparison
    // of two id lists, because this runs sixty times a second and must allocate nothing at all on
    // the frames — nearly all of them — where nobody arrived and nobody left.
    let seatingSeen = -1;
    /** Whether the previous frame was showing the past, so returning to live can restore the cast. */
    let wasScrubbing = false;

    // What the live region has already said, and when. A screen reader user is told what was
    // spoken, once, after it settled — never the typewriter's half-finished line, and never
    // sixty times a second.
    const saidLast = new Map<string, string | undefined>();
    const queued: string[] = [];
    let clock = 0;
    let spokeAt = -SAY_ANNOUNCE_MS;

    // The hover card's parts, re-read only when the card itself is a different element.
    let cardEl: HTMLElement | null = null;
    let card: {
      act: Element | null;
      tok: Element | null;
      cost: Element | null;
      age: Element | null;
      note: Element | null;
    } | null = null;

    /** One frame: advance every simulation, repaint the visible one, blit it, move the DOM marks. */
    const paint = (dt: number): void => {
      const visible = sim.current;
      const s = simOf(visible);
      const cur = live.current;
      clock += dt;

      // Every *other* session's room ticks too, on the same delta. A tab you are not looking at is
      // still a session with agents in it, and an engine that froze while its tab was hidden would
      // have to catch up in one jump the moment you looked back — the same reason the live room
      // keeps ticking while the scrubber is held in the past, applied across rooms rather than
      // across time. Their seating is still reported, or their tab would show the cast it had when
      // you last looked at it.
      for (const [id, box] of office.rooms.current) {
        const other = box.current;
        if (!other || box === visible) continue;
        const moved = other.engine.tick(dt);
        const seatingNow = other.engine.seating();
        if (seatingNow === other.seatingSeen) continue;
        other.seatingSeen = seatingNow;
        sync.current(id, moved.map((a) => a.id), other.engine.offsite());
      }

      // The live simulation ticks whether or not anybody is watching it. Events keep arriving
      // while the scrubber is held in the past, and an engine paused for all of them would have to
      // catch up in one jump the moment the viewer let go of the timeline.
      let actors = s.engine.tick(dt);

      const at = cur.replayAt;
      const scrubbing = at !== null && at !== undefined;
      if (scrubbing) {
        // Scrubbing. A fresh engine is wound over the recorded command stream to the moment asked
        // for; the room this paints is the room that actually stood there, not a reconstruction
        // from aggregates.
        // Rebuilt whenever the log has moved, because `entries()` is a snapshot: a `Replay` built
        // from an older one would be missing every command recorded since, and the scrubber would
        // quietly stop at the moment the scrub began however far forward it was dragged.
        if (!s.replay || s.replayRev !== s.log.revision) {
          s.replay = new Replay(s.log.entries());
          s.replayRev = s.log.revision;
        }
        // Clamped into the span the log can honestly rebuild. The activity strip is drawn from the
        // *store's* history, which reaches back further than the office's own recording whenever a
        // truncated backlog gave the store events the office never turned into commands — and an
        // unclamped seek into that gap painted an empty room, which reads as "nobody was here"
        // rather than as "this is as far back as the room goes".
        actors = s.replay.seek(Math.max(s.replay.from, Math.min(s.replay.to, at)));
        // Seeking rebuilds a different room on every frame the scrubber moves, so there is no
        // revision to lean on and the cast is compared instead. `sync` bails when it matches.
        sync.current(visibleId.current, actors.map((a) => a.id), s.replay.offsite());
      } else {
        // Hot-desking means the cast changes inside a tick — somebody reaches the door, and the
        // agent who has been waiting longest walks in and takes the chair they gave up.
        //
        // `wasScrubbing` is not a nicety: the live path only syncs when *seating* changes, and
        // coming back from a scrub the engine's seating is usually exactly what it was before the
        // viewer wandered off. Without this the room returned to live holding the cast the replay
        // had left in the DOM — which, if the scrub had reached back before anybody arrived, was
        // nobody at all, for the rest of the session.
        const seating = s.engine.seating();
        if (seating !== seatingSeen || wasScrubbing) {
          seatingSeen = seating;
          sync.current(visibleId.current, actors.map((a) => a.id), s.engine.offsite());
        }
      }
      wasScrubbing = scrubbing;

      const sceneAgents: Record<string, SceneAgent> = {};
      for (const a of actors) {
        const meta = cur.agents[a.id];
        sceneAgents[a.id] = {
          label: meta?.label ?? a.id,
          look: agentLook(a.id),
          status: a.status,
          errored: (meta?.errors ?? 0) > 0,
          tokens: meta?.tokens ?? 0,
        };
      }
      const ghosts: Ghost[] = cur.offsite.map((id) => ({
        id,
        label: cur.agents[id]?.label ?? id,
        look: agentLook(id),
        busy: (cur.agents[id]?.activeTools ?? 0) > 0,
        done: cur.agents[id]?.phase === 'done',
      }));

      scene.current!.draw(bctx, {
        actors,
        agents: sceneAgents,
        task: cur.task,
        turns: cur.turns,
        selected: cur.selected,
        kin: cur.kin,
        ghosts,
        night: cur.night,
        spend: cur.spend,
        // The canvas freezes its own decoration for a viewer who asked for reduced motion. The
        // simulation keeps its slowed tick either way: where somebody is standing is information.
        still,
        dt,
        // The moment the room is showing, for the clock on the wall: the second being rebuilt
        // while the timeline holds a seek, otherwise now. Reading the system clock inside the
        // renderer would have put the present time on the wall of a room rebuilt from the past.
        clockMs: cur.replayAt ?? Date.now(),
      });

      // --- camera ---------------------------------------------------------------
      const want = camWant.current;
      if (look.current !== null) {
        // A one-shot glance, from a fresh selection or a double-click.
        const box = scene.current!.boxOf(look.current);
        if (box) {
          want.x = box.x + box.w / 2;
          want.y = box.y + box.h / 2;
        }
        look.current = null;
      } else if (cur.follow && cur.selected !== null) {
        // Following, and only when following: a camera that chased the selection regardless made
        // the toggle a decoration and made panning while somebody was selected impossible.
        const box = scene.current!.boxOf(cur.selected);
        if (box) {
          want.x = box.x + box.w / 2;
          want.y = box.y + box.h / 2;
        }
      }
      const k = Math.min(1, dt / 220);
      const c = cam.current;
      c.x += (want.x - c.x) * k;
      c.y += (want.y - c.y) * k;
      c.z += (want.z - c.z) * k;
      const cl = clampCam(c);
      cam.current = cl;

      // --- blit ------------------------------------------------------------------
      const { w, h, dpr } = size;
      const g = geo.current;
      g.w = w;
      g.h = h;
      g.dpr = dpr;
      g.insetLeft = cur.insetLeft;
      const b = blitOf(cl, g);

      // The surround — the gutters either side of the room when the stage is *shorter* than 16:9 —
      // is the wall's own darkest tone rather than black. Nothing in this room is black.
      ctx.fillStyle = PAL.wa3;
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      // The strip above the room, which bottom-alignment leaves and the rail guarantees. It used to
      // be filled with `PAL.out` and `PAL.shd` — the near-blacks the art draws outlines with — on
      // the theory that space above the ceiling reads as a taller room. The theory is right; those
      // two colours are not a room. It is now the room's own ceiling: real buffer rows wherever the
      // camera has any above the view, and the ceiling strip above those.
      const pieces = headroomBlits(b, CEILING_H);
      if (pieces.length > 0) {
        // Repainted only when some of the strip is actually ceiling. A stage with no headroom at
        // all costs nothing, and neither does one zoomed far enough in that the strip is filled
        // with room — which is the case a viewer looking closely at somebody is in.
        if (pieces.some((p) => p.from === 'ceiling')) scene.current!.paintCeiling(cctx);
        for (const p of pieces) {
          const src = p.from === 'room' ? buffer.current! : ceiling.current!;
          ctx.drawImage(src, p.sx, p.sy, p.sw, p.sh, p.dx, p.dy, p.dw, p.dh);
        }
      }
      ctx.drawImage(buffer.current!, b.srcX, b.srcY, b.viewW, b.viewH, b.destX, b.destY, b.destW, b.destH);

      // --- the DOM layer, moved to match ------------------------------------------
      // The off-site strip first: forty small heads along the bottom with no names on them is a
      // decoration, and the canvas cannot be hovered, focused or read aloud. These marks give the
      // strip the same treatment the floor already has.
      for (const id of cur.offsite) {
        const ghost = ghostMarks.current.get(id);
        const gbox = scene.current!.ghostBoxOf(id);
        // A ghost past the strip's width is genuinely not drawn — the canvas says so with a `+N`
        // — so it gets no hit target either rather than an invisible one over the wrong pixels.
        if (ghost) ghost.style.display = gbox ? '' : 'none';
        if (ghost && gbox) place(ghost, gbox, b);
      }

      let hovered: ActorState | undefined;
      for (const a of actors) {
        if (a.id === cur.hover) hovered = a;

        const desk = desks.current.get(a.id);
        const deskBox = scene.current!.deskBoxOf(a.id);
        if (desk && deskBox) place(desk, deskBox, b);

        const mark = marks.current.get(a.id);
        const box = scene.current!.boxOf(a.id);
        if (!mark || !box) continue;
        const wr = place(mark, box, b);
        wr.bubbles ??= {
          say: mark.querySelector<HTMLElement>('.say'),
          think: mark.querySelector<HTMLElement>('.think'),
        };
        const meta = cur.agents[a.id];
        const name = meta?.label ?? a.id;
        const label = a.status ? `${name} — ${a.status}` : name;
        if (wr.label !== label) {
          mark.setAttribute('aria-label', label);
          wr.label = label;
        }
        setBubble(wr, 'say', a.say);
        setBubble(wr, 'think', a.think);

        // Said out loud, for anyone not looking at the room. The engine hands over a settled
        // line, not a growing one, so this fires once per thing anybody says.
        if (saidLast.get(a.id) !== a.say) {
          saidLast.set(a.id, a.say);
          if (a.say !== undefined) queued.push(`${name} says: ${a.say}`);
        }
      }
      if (queued.length > 0 && clock - spokeAt >= SAY_ANNOUNCE_MS) {
        spokeAt = clock;
        setText(crier.current, queued.join('. '));
        queued.length = 0;
      }

      if (board.current) place(board.current, BOARD_BOX, b);
      if (table.current) place(table.current, TABLE_BOX, b);

      // --- the hover card ----------------------------------------------------------
      const cardNow = peek.current;
      if (cardNow !== cardEl) {
        cardEl = cardNow;
        card = cardNow
          ? {
              act: cardNow.querySelector('.peek-act'),
              tok: cardNow.querySelector('.peek-tok'),
              cost: cardNow.querySelector('.peek-cost'),
              age: cardNow.querySelector('.peek-age'),
              note: cardNow.querySelector('.peek-note'),
            }
          : null;
      }
      if (cardNow && card && cur.hover !== null) {
        const meta = cur.agents[cur.hover];
        // An off-site agent has no sprite on the floor and no desk — its box is its ghost's, and
        // without that third fallback hovering the strip named nobody: the card existed, was never
        // placed, and so was never shown.
        const box =
          scene.current!.boxOf(cur.hover) ??
          scene.current!.deskBoxOf(cur.hover) ??
          scene.current!.ghostBoxOf(cur.hover);
        if (box) {
          const cx = b.dx + (box.x + box.w / 2 - b.srcX) * b.px;
          const top = b.dy + (box.y - b.srcY) * b.px;
          const bottom = b.dy + (box.y + box.h - b.srcY) * b.px;
          const half = cardNow.offsetWidth / 2 + 6;
          const x = Math.round(Math.min(Math.max(cx, half), Math.max(half, w - half)));
          const below = top - cardNow.offsetHeight < 8;
          const y = Math.round(below ? bottom + 8 : top - 8);
          const t = below
            ? `translate(${x}px, ${y}px) translate(-50%, 0)`
            : `translate(${x}px, ${y}px) translate(-50%, -100%)`;
          const wr = wroteOf(cardNow);
          if (wr.t !== t) {
            cardNow.style.transform = t;
            wr.t = t;
          }
          // Shown only once it has been put somewhere: a card that renders at the stage's corner
          // for one frame before the loop places it reads as a flicker in the wrong place.
          if (!cardNow.classList.contains('on')) cardNow.classList.add('on');
        }
        // A finished agent's clock stops at its last event; a live one's runs to now. A hovered
        // ghost has no ActorState at all — it is off the floor — so its phase comes from the
        // store, or the card would age a finished agent for ever and call a queued one "off the
        // floor" while pointing straight at its head in the strip.
        const done = hovered ? hovered.done : meta?.phase === 'done';
        const end = done ? meta?.lastTs ?? 0 : Date.now();
        setText(card.act, hovered ? actLine(hovered) : done ? 'finished' : 'waiting for a desk');
        setText(card.tok, `${fmtTokens(meta?.tokens ?? 0)} tokens`);
        setText(card.cost, money(meta?.cost));
        setText(card.age, meta && meta.firstTs > 0 ? duration(end - meta.firstTs) : '—');
        setText(card.note, noteLine(hovered));
      }
    };

    if (still) {
      const id = setInterval(() => paint(SETTLE_TICK_MS), SETTLE_TICK_MS);
      paint(0);
      return () => {
        ro.disconnect();
        clearInterval(id);
      };
    }

    let raf = 0;
    let prev = 0;
    const frame = (now: number): void => {
      raf = requestAnimationFrame(frame);
      const dt = prev === 0 ? 0 : Math.min(MAX_FRAME_MS, now - prev);
      prev = now;
      paint(dt);
    };
    raf = requestAnimationFrame(frame);
    return () => {
      ro.disconnect();
      cancelAnimationFrame(raf);
    };
  }, [sim]);

  // ----------------------------------------------------------------- controls

  /** Sends the camera somewhere, keeping the readout and the autopilot honest. */
  const aim = useCallback((next: Cam, autopilot?: boolean): void => {
    const cl = clampCam(next);
    camWant.current = cl;
    setZoom(cl.z);
    if (autopilot === false) setFollow(false);
  }, []);

  const home = useCallback((): void => {
    look.current = null;
    aim({ ...CAM_HOME }, false);
  }, [aim]);

  /**
   * Zooms, keeping the buffer pixel under `client` under `client`.
   *
   * The blit is bottom-aligned, inset on the left by the rail, and drawn at device resolution, so
   * the map from a client point to a buffer point is not `x / z` — it is the inverse of `blitOf`,
   * which is why that lives in one function and both directions use it. Without an anchor (the
   * buttons, the keyboard) the room's own centre is used.
   */
  const zoomBy = useCallback(
    (factor: number, client?: { x: number; y: number }): void => {
      const el = wrap.current;
      const from = camWant.current;
      const z = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, from.z * factor));
      if (z === from.z) return;
      if (!el || !client || geo.current.w === 0) {
        aim({ ...from, z });
        return;
      }
      const r = el.getBoundingClientRect();
      const sx = client.x - r.left;
      const sy = client.y - r.top;
      const anchor = toBuffer(blitOf(from, geo.current), sx, sy);
      const after = blitOf({ ...from, z }, geo.current);
      // Solve for the source origin that puts `anchor` back under the pointer, then recentre.
      aim(
        {
          z,
          x: anchor.x - (sx - after.dx) / after.px + after.viewW / 2,
          y: anchor.y - (sy - after.dy) / after.px + after.viewH / 2,
        },
        false,
      );
    },
    [aim],
  );

  const onWheel = useCallback(
    (e: React.WheelEvent) => {
      if (Math.abs(e.deltaY) < 1) return;
      zoomBy(e.deltaY < 0 ? WHEEL_STEP : 1 / WHEEL_STEP, { x: e.clientX, y: e.clientY });
    },
    [zoomBy],
  );

  /**
   * The drag.
   *
   * Nothing is captured and nothing is panned until the pointer has travelled past `DRAG_SLOP`:
   * before that the gesture is still a click, and clicking a person is the room's primary verb.
   * Once it *is* a drag, the click that follows is swallowed — otherwise letting go over somebody
   * would select them, and the room would be undraggable in exactly the places worth dragging it.
   */
  const drag = useRef({ id: -1, on: false, moved: false, swallow: false, x: 0, y: 0, cx: 0, cy: 0 });

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    // Pressing a camera button is not the start of a pan, however much the hand shakes on it.
    if ((e.target as HTMLElement).closest('.cam-ctl')) return;
    const d = drag.current;
    d.id = e.pointerId;
    d.on = true;
    d.moved = false;
    d.swallow = false;
    d.x = e.clientX;
    d.y = e.clientY;
    d.cx = camWant.current.x;
    d.cy = camWant.current.y;
  }, []);

  const onPointerMove = useCallback((e: React.PointerEvent) => {
    const d = drag.current;
    if (!d.on || e.pointerId !== d.id) return;
    const dx = e.clientX - d.x;
    const dy = e.clientY - d.y;
    if (!d.moved) {
      if (Math.abs(dx) < DRAG_SLOP && Math.abs(dy) < DRAG_SLOP) return;
      d.moved = true;
      look.current = null;
      setFollow(false);
      wrap.current?.setAttribute('data-drag', 'on');
      try {
        wrap.current?.setPointerCapture(e.pointerId);
      } catch {
        // A pointer that ended between the move and here cannot be captured; the drag still works
        // off the events already in flight.
      }
    }
    const px = blitOf(cam.current, geo.current).px || 1;
    const next = clampCam({ ...camWant.current, x: d.cx - dx / px, y: d.cy - dy / px });
    camWant.current = next;
    // A drag is direct manipulation: the room has to sit under the finger, not ease toward it.
    // A copy, not the same object — the loop eases `cam` toward `camWant` and aliasing the two
    // would quietly make the easing a no-op for every later move as well.
    cam.current = { ...next };
  }, []);

  const endDrag = useCallback((e: React.PointerEvent) => {
    const d = drag.current;
    if (!d.on || e.pointerId !== d.id) return;
    d.on = false;
    if (!d.moved) return;
    d.swallow = true;
    wrap.current?.setAttribute('data-drag', 'off');
    try {
      wrap.current?.releasePointerCapture(e.pointerId);
    } catch {
      // Already released by the browser's implicit capture rules.
    }
  }, []);

  /** Every click in the room goes through here first, so a pan can eat the one it ended on. */
  const swallowed = useCallback((): boolean => {
    const d = drag.current;
    if (!d.swallow) return false;
    d.swallow = false;
    return true;
  }, []);

  const pick = useCallback(
    (id: string | null) => {
      if (swallowed()) return;
      onSelect(id);
    },
    [onSelect, swallowed],
  );

  const zoomTo = useCallback(
    (id: string) => {
      const box = scene.current?.boxOf(id) ?? scene.current?.deskBoxOf(id);
      look.current = box ? null : id;
      aim(box ? { x: box.x + box.w / 2, y: box.y + box.h / 2, z: ZOOM_TO } : { ...camWant.current, z: ZOOM_TO });
      setFollow(true);
      // The two clicks inside a double-click have already toggled the selection twice and left it
      // exactly where it started; saying it outright is what makes "follow" have something to
      // follow, and a double-click mean "this one" rather than "this one, briefly".
      onSelect(id);
    },
    [aim, onSelect],
  );

  const onClick = useCallback(
    (e: React.MouseEvent) => {
      // Anything with its own meaning has already handled this and stopped it; what is left is
      // the floor, the walls and the furniture nobody wired up — all of which mean "nobody".
      if (swallowed()) return;
      if ((e.target as HTMLElement).closest('.actor, .desk, .ghost, .fixture, .cam-ctl')) return;
      onSelect(null);
    },
    [onSelect, swallowed],
  );

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      const step = PAN_STEP / camWant.current.z;
      const pan = (dx: number, dy: number): void => {
        look.current = null;
        aim({ ...camWant.current, x: camWant.current.x + dx * step, y: camWant.current.y + dy * step }, false);
      };
      switch (e.key) {
        case 'ArrowLeft':
          pan(-1, 0);
          break;
        case 'ArrowRight':
          pan(1, 0);
          break;
        case 'ArrowUp':
          pan(0, -1);
          break;
        case 'ArrowDown':
          pan(0, 1);
          break;
        case '+':
        case '=':
          zoomBy(KEY_STEP);
          break;
        case '-':
        case '_':
          zoomBy(1 / KEY_STEP);
          break;
        case 'f':
        case 'F':
          setFollow((v) => !v);
          break;
        case 'Escape':
          // Not stopped: the shell's own Escape clears the selection, and "home" means both.
          home();
          return;
        default:
          return;
      }
      e.preventDefault();
      // The shell binds bare letters and digits at the document; a key the room has just spent
      // must not also cycle the theme or swap the dock's tab on its way past.
      e.stopPropagation();
    },
    [aim, home, zoomBy],
  );

  const register = useCallback((id: string, el: HTMLDivElement | null) => {
    if (el) marks.current.set(id, el);
    else marks.current.delete(id);
  }, []);

  const registerDesk = useCallback((id: string, el: HTMLDivElement | null) => {
    if (el) desks.current.set(id, el);
    else desks.current.delete(id);
  }, []);

  const registerGhost = useCallback((id: string, el: HTMLDivElement | null) => {
    if (el) ghostMarks.current.set(id, el);
    else ghostMarks.current.delete(id);
  }, []);

  const hoverAgent = useCallback((id: string | null) => setHover(id), []);

  const hoveredName = hover === null ? '' : (agents[hover]?.label ?? hover);
  const hoveredModel = hover === null ? undefined : agents[hover]?.model;

  return (
    <div
      className="office pixel"
      ref={wrap}
      role="group"
      tabIndex={0}
      aria-label="the office — drag to pan, arrow keys pan, plus and minus zoom, F follows the selected agent"
      onWheel={onWheel}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onClick={onClick}
      onKeyDown={onKeyDown}
      onDoubleClick={(e) => {
        if ((e.target as HTMLElement).closest('.actor, .desk, .ghost, .fixture, .cam-ctl')) return;
        home();
      }}
      data-follow={follow ? 'on' : 'off'}
      data-drag="off"
    >
      <canvas ref={view} className="pixel-canvas" aria-hidden="true" />

      {/*
        The workstations. A desk is where an agent's work lives whether or not they are sitting at
        it, which makes it the stable thing to point at — people walk, desks do not. Below the
        people in both paint order and stacking order, so a pointer over somebody's head still
        finds the person.
      */}
      <div className="desk-layer" aria-hidden="false">
        {cast.map((id) => (
          <DeskMark
            key={id}
            id={id}
            name={agents[id]?.label ?? id}
            dim={kin !== null && !kin.has(id)}
            kin={kin !== null && kin.has(id) && id !== selected}
            hovered={hover === id}
            onHover={hoverAgent}
            onPick={pick}
            register={registerDesk}
          />
        ))}
      </div>

      {/*
        The off-site strip's names. The room seats thirteen and a workflow spawns forty; the
        surplus is drawn along the bottom as small heads, which without this is twenty-three
        anonymous silhouettes — present, which is the point, but unidentifiable, which is not.
        Hovering one names it; tabbing reaches it; a screen reader reads it.
      */}
      <div className="ghost-layer" role="list" aria-label="waiting for a desk">
        {room.offsite.map((id) => (
          <GhostMark
            key={id}
            id={id}
            name={agents[id]?.label ?? id}
            status={agents[id]?.status ?? ''}
            hovered={hover === id}
            onHover={hoverAgent}
            onPick={pick}
            register={registerGhost}
          />
        ))}
      </div>

      {/*
        The room, as anything that is not an eye sees it. These sit exactly over the sprites the
        canvas paints and carry the label, the state and the text; they are transparent because
        the picture is already there, not because they are decorative.
      */}
      <div className="actor-layer" ref={layer} role="group" aria-label="office">
        {cast.map((id) => (
          <ActorMark
            key={id}
            id={id}
            name={agents[id]?.label ?? id}
            selected={selected === id}
            dim={kin !== null && !kin.has(id)}
            kin={kin !== null && kin.has(id) && id !== selected}
            hovered={hover === id}
            onHover={hoverAgent}
            onPick={pick}
            onZoomTo={zoomTo}
            register={register}
          />
        ))}
      </div>

      {/*
        The fixtures the room draws but the canvas cannot be clicked on. Each exists only when
        somebody upstream has something for it to do.
      */}
      {onOpenSession && (
        <button
          type="button"
          ref={board}
          className="fixture fixture-board"
          aria-label="Open the session brief"
          onClick={(e) => {
            e.stopPropagation();
            if (!swallowed()) onOpenSession();
          }}
        />
      )}
      {onFilterCrossTalk && (
        <button
          type="button"
          ref={table}
          className="fixture fixture-table"
          aria-label="Show what the agents said to each other"
          onClick={(e) => {
            e.stopPropagation();
            if (!swallowed()) onFilterCrossTalk();
          }}
        />
      )}

      {/*
        The peek. A hover is not a selection — it commits nothing and clears itself — so this is
        the one place the room answers "who is that and what are they doing" without changing what
        the rest of the app is filtered to. Real text, so a reader and a test see what an eye sees.
      */}
      {hover !== null && (
        <div className="peek" ref={peek} role="note" aria-label={`${hoveredName} at a glance`}>
          <span className="peek-name">{hoveredName}</span>
          {hoveredModel && <span className="peek-model">{hoveredModel}</span>}
          <span className="peek-act" />
          <span className="peek-note" />
          <span className="peek-nums">
            <span className="peek-tok" />
            <span className="peek-cost" />
            <span className="peek-age" />
          </span>
        </div>
      )}

      {/* The camera, as a thing you can see and press rather than a gesture you have to guess. */}
      <div className="cam-ctl" role="group" aria-label="camera">
        <button
          type="button"
          className="cam-btn"
          aria-label="Zoom out"
          disabled={zoom <= ZOOM_MIN}
          onClick={() => zoomBy(1 / KEY_STEP)}
        >
          −
        </button>
        <span className="cam-z" aria-label={`zoom ${zoom.toFixed(1)} times`}>{`${zoom.toFixed(1)}×`}</span>
        <button
          type="button"
          className="cam-btn"
          aria-label="Zoom in"
          disabled={zoom >= ZOOM_MAX}
          onClick={() => zoomBy(KEY_STEP)}
        >
          +
        </button>
        <button type="button" className="cam-btn" aria-label="Reset the camera" onClick={home}>
          ⌂
        </button>
        <button
          type="button"
          className="cam-btn cam-follow"
          aria-label="Follow the selected agent"
          aria-pressed={follow}
          onClick={() => setFollow((v) => !v)}
        >
          ⦿
        </button>
      </div>

      {/*
        What was said, for anyone not watching. Polite, throttled, and only ever the settled line:
        a live region that repeated every frame of a typewriter would be unusable.
      */}
      <div className="rt-crier" ref={crier} role="status" aria-live="polite" aria-atomic="true" />
    </div>
  );
});

/** The one-line answer to "what is this agent doing", from the state the stream actually knows. */
export function actLine(a: ActorState | undefined): string {
  if (!a) return 'off the floor';
  if (a.done) return a.doneOk === false ? 'finished — failed' : 'finished';
  if (a.waiting > 0) return `waiting on ${a.waiting} agent${a.waiting === 1 ? '' : 's'}`;
  if (a.tool) return clip(a.target ? `${a.tool} ${a.target}` : a.tool, 42);
  if (a.busy > 0) return 'working';
  return a.status ? clip(a.status, 42) : 'idle';
}

/** The second line, when there is one worth spending: what this agent has done to the repo. */
export function noteLine(a: ActorState | undefined): string {
  if (!a) return '';
  const bits: string[] = [];
  if (a.edits > 0) bits.push(`${a.edits} edit${a.edits === 1 ? '' : 's'}${a.edit ? ` · ${clip(a.edit, 26)}` : ''}`);
  if (a.fails > 0) bits.push(`${a.fails} failing in a row`);
  return bits.join(' · ');
}

/** The classes a mark carries, which are all about the spawn tree and the pointer. */
const markClass = (base: string, on: { selected?: boolean; dim: boolean; kin: boolean; hovered: boolean }): string =>
  `${base}${on.selected ? ' sel' : ''}${on.dim ? ' dim' : ''}${on.kin ? ' kin' : ''}${on.hovered ? ' hov' : ''}`;

/**
 * One person's DOM presence. Position, size, label and bubble text are all written by the frame
 * loop; this only has to exist, be focusable, and stay mounted while its agent is in the room.
 */
const ActorMark = memo(function ActorMark({
  id,
  name,
  selected,
  dim,
  kin,
  hovered,
  onHover,
  onPick,
  onZoomTo,
  register,
}: {
  id: string;
  name: string;
  selected: boolean;
  dim: boolean;
  kin: boolean;
  hovered: boolean;
  onHover: (id: string | null) => void;
  onPick: (id: string | null) => void;
  onZoomTo: (id: string) => void;
  register: (id: string, el: HTMLDivElement | null) => void;
}) {
  return (
    <div
      className={markClass('actor', { selected, dim, kin, hovered })}
      ref={(el) => register(id, el)}
      data-agent={id}
      role="button"
      tabIndex={0}
      aria-pressed={selected}
      aria-label={name}
      onPointerEnter={() => onHover(id)}
      onPointerLeave={() => onHover(null)}
      onFocus={() => onHover(id)}
      onBlur={() => onHover(null)}
      onClick={(e) => {
        // Selection lands on the click rather than on the press, so that a drag which started on
        // somebody's head can pan the room and swallow the click it ends with.
        e.stopPropagation();
        onPick(selected ? null : id);
      }}
      onDoubleClick={(e) => {
        e.stopPropagation();
        onZoomTo(id);
      }}
      onKeyDown={(e) => {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        e.preventDefault();
        e.stopPropagation();
        onPick(selected ? null : id);
      }}
    >
      <span className="say" />
      <span className="think" />
    </div>
  );
});

/**
 * One workstation's DOM presence.
 *
 * Not a tab stop: an agent already has one, and doubling every agent in the tab order to reach a
 * second control that does the same thing is a worse room to navigate, not a better one. It is
 * still labelled, still hoverable, still clickable, and still readable by a screen reader moving
 * through the room by hand.
 */
/**
 * One waiting agent's presence in the strip along the bottom.
 *
 * The canvas draws it as ten pixels of head and shoulders, which is the right amount of room to
 * give somebody who is not in the room — but ten pixels cannot carry a name, be tabbed to, or be
 * read out. This can, and it sits exactly over those pixels.
 */
const GhostMark = memo(function GhostMark({
  id,
  name,
  status,
  hovered,
  onHover,
  onPick,
  register,
}: {
  id: string;
  name: string;
  status: string;
  hovered: boolean;
  onHover: (id: string | null) => void;
  onPick: (id: string) => void;
  register: (id: string, el: HTMLDivElement | null) => void;
}) {
  return (
    <div
      className={`ghost${hovered ? ' hov' : ''}`}
      ref={(el) => register(id, el)}
      data-agent={id}
      role="listitem"
      tabIndex={0}
      aria-label={status ? `${name} — waiting for a desk — ${status}` : `${name} — waiting for a desk`}
      onPointerEnter={() => onHover(id)}
      onPointerLeave={() => onHover(null)}
      onFocus={() => onHover(id)}
      onBlur={() => onHover(null)}
      onClick={() => onPick(id)}
      onKeyDown={(e) => {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        e.preventDefault();
        onPick(id);
      }}
    />
  );
});

const DeskMark = memo(function DeskMark({
  id,
  name,
  dim,
  kin,
  hovered,
  onHover,
  onPick,
  register,
}: {
  id: string;
  name: string;
  dim: boolean;
  kin: boolean;
  hovered: boolean;
  onHover: (id: string | null) => void;
  onPick: (id: string | null) => void;
  register: (id: string, el: HTMLDivElement | null) => void;
}) {
  return (
    <div
      className={markClass('desk', { dim, kin, hovered })}
      ref={(el) => register(id, el)}
      data-desk={id}
      role="button"
      tabIndex={-1}
      aria-label={`${name}'s desk`}
      onPointerEnter={() => onHover(id)}
      onPointerLeave={() => onHover(null)}
      onClick={(e) => {
        e.stopPropagation();
        onPick(id);
      }}
    />
  );
});
