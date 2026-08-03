/**
 * The things people work at: desks, chairs, monitors, storage, and the meeting table.
 *
 * Every object in here is a box with two faces. A surface that points up catches the room light
 * and is drawn in the light tone (`wdt` for wood, `me3` for metal); the surface that points at the
 * camera is in the dark tone (`wdf` / `met`), and the seam between them carries one lit pixel row
 * (`wdl` / `gry`). That single split is the entire 2.5D illusion at this resolution — draw a desk
 * in one tone and it reads as a brown rectangle, draw it in two and it reads as a desk. Everything
 * that stands on the floor also carries a 1px `out` silhouette down its sides, which is what keeps
 * it from dissolving into the plank floor behind it.
 *
 * Anchors follow the contract without exception: `(ctx, cx, yBase, …)` where `cx` is the
 * horizontal centre and `yBase` is the last row the object occupies — its contact point with the
 * floor, the rug, or the wall. The scene sorts by `yBase`, so an object that lies about its
 * footprint sorts wrong and gets drawn through.
 */
import { drawArt, PAL, pool, rect, type Art } from './art';
import type { PreviewItem } from './preview';

// --------------------------------------------------------------------------- shared helpers

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);
const clamp11 = (v: number): number => (v < -1 ? -1 : v > 1 ? 1 : v);

/** A contact shadow on the floor. Drawn before the object so its own feet sit on top of it. */
function contact(ctx: CanvasRenderingContext2D, cx: number, yBase: number, w: number): void {
  pool(ctx, cx, yBase, Math.round(w * 0.52), 2, PAL.shd, 0.5, 3);
}

/**
 * A horizontal slab seen from slightly above: a tapering top face, a front face, and a lit seam.
 *
 * The taper is what stops the top reading as a second front face. Three pixels of inset across
 * eight rows is barely perceptible per-row and unmistakable as a whole, which is the useful side
 * of working this small.
 */
function slab(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  topH: number,
  frontH: number,
  taper: number,
  top: string,
  far: string,
  front: string,
  lit: string,
  shade: string,
): void {
  for (let r = 0; r < topH; r++) {
    const inset = topH > 1 ? Math.round((taper * (topH - 1 - r)) / (topH - 1)) : 0;
    const rx = x + inset;
    const rw = w - inset * 2;
    const color = r === 0 ? PAL.out : r <= 2 ? far : r === topH - 1 ? lit : top;
    rect(ctx, rx, y + r, rw, 1, color);
    if (r > 0) {
      rect(ctx, rx, y + r, 1, 1, PAL.out);
      rect(ctx, rx + rw - 1, y + r, 1, 1, PAL.out);
    }
  }
  for (let r = 0; r < frontH; r++) {
    const yy = y + topH + r;
    rect(ctx, x, yy, w, 1, r === frontH - 1 ? PAL.out : front);
    rect(ctx, x, yy, 1, 1, PAL.out);
    rect(ctx, x + w - 1, yy, 1, 1, PAL.out);
  }
  // The right end faces away from the windows, so it loses a little light.
  if (frontH > 2) rect(ctx, x + w - 3, y + topH, 2, frontH - 2, shade);
}

/** A stepped cable hanging off the back of a desk — two jogs, never a straight drop. */
function cableDrop(ctx: CanvasRenderingContext2D, x: number, y: number, h: number): void {
  let px = x;
  for (let i = 0; i < h; i++) {
    if (i === Math.round(h * 0.35)) px += 1;
    if (i === Math.round(h * 0.72)) px -= 1;
    rect(ctx, px, y + i, 1, 1, PAL.out);
  }
  rect(ctx, px - 1, y + h, 3, 1, PAL.out);
}

// --------------------------------------------------------------------------- desks

export const DESK = {
  pod: { w: 44, h: 20 },
  manager: { w: 60, h: 22 },
} as const;

/** Top face rows, then the apron — the front face of the worktop itself. */
const DESK_TOP_H = 7;
const DESK_FRONT_H = 4;

/**
 * A desk. `pod` is the four-seat bullpen unit; `manager` is wider, sits a couple of pixels taller
 * and carries a return — a second wing stepped toward the camera, which is what makes an office
 * desk read as *someone's* desk rather than as more of the same furniture.
 *
 * Both carry a drawer pedestal on one side. A desk is a table until you can see where the drawers
 * are: the pedestal is the one silhouette detail that separates the two, and it also breaks the
 * long dark band under the worktop that otherwise makes a desk look like it is hovering.
 */
export function drawDesk(
  ctx: CanvasRenderingContext2D,
  cx: number,
  yBase: number,
  kind: 'pod' | 'manager',
): void {
  const spec = DESK[kind];
  const x0 = Math.round(cx - spec.w / 2);
  const y0 = yBase - spec.h + 1;
  contact(ctx, cx, yBase, spec.w);

  const topH = DESK_TOP_H;
  const frontH = DESK_FRONT_H;

  if (kind === 'pod') {
    deskUnder(ctx, x0, y0 + topH + frontH, spec.w, yBase, 1);
    slab(ctx, x0, y0, spec.w, topH, frontH, 3, PAL.wdt, PAL.wdd, PAL.wdf, PAL.wdl, PAL.wdd);
    apronShadow(ctx, x0, y0 + topH, spec.w, frontH);
    cableDrop(ctx, x0 + 10, y0 + topH + 1, frontH + 1);
    cableDrop(ctx, x0 + 24, y0 + topH + 2, frontH);
  } else {
    // Main run on the left, return stepped 4px nearer the camera on the right. Drawing the main
    // run second means the return tucks behind it, which is the way an L-desk actually joins —
    // so the main run's pedestal goes on the *left*, clear of where the two meet.
    const mainW = 42;
    const retW = 22;
    const retX = x0 + spec.w - retW;
    const retY = y0 + 4;

    deskUnder(ctx, retX, retY + topH + frontH, retW, yBase, 0);
    slab(ctx, retX, retY, retW, topH, frontH, 2, PAL.wdt, PAL.wdd, PAL.wdf, PAL.wdl, PAL.wdd);
    apronShadow(ctx, retX, retY + topH, retW, frontH);

    deskUnder(ctx, x0, y0 + topH + frontH, mainW, yBase - 3, -1);
    slab(ctx, x0, y0, mainW, topH, frontH, 3, PAL.wdt, PAL.wdd, PAL.wdf, PAL.wdl, PAL.wdd);
    apronShadow(ctx, x0, y0 + topH, mainW, frontH);

    // A brass-ish trim strip along the near edge: the one detail that says "grander".
    rect(ctx, x0 + 2, y0 + topH, mainW - 4, 1, PAL.wdl, 0.5);
    cableDrop(ctx, x0 + 20, y0 + topH + 1, frontH + 2);
    cableDrop(ctx, retX + 14, retY + topH + 1, frontH + 1);
  }
}

/** The dark line where the worktop's front face meets the air under it. */
function apronShadow(
  ctx: CanvasRenderingContext2D,
  x: number,
  yTop: number,
  w: number,
  frontH: number,
): void {
  rect(ctx, x + 1, yTop + frontH - 2, w - 2, 1, PAL.wdd);
}

/** One metal desk leg: lit on its left face, outlined on its right, footed on the floor. */
function deskLeg(
  ctx: CanvasRenderingContext2D,
  lx: number,
  yTop: number,
  h: number,
  yBase: number,
): void {
  rect(ctx, lx, yTop, 4, h, PAL.me2);
  rect(ctx, lx, yTop, 1, h, PAL.me3);
  rect(ctx, lx + 3, yTop, 1, h, PAL.out);
  rect(ctx, lx, yBase, 4, 1, PAL.out);
}

/**
 * The underside of a desk: a leg, a modesty panel that is actually visible, and — on `side` — a
 * drawer pedestal.
 *
 * The panel is drawn in `wdf`, not in the shadow tone. A panel the same colour as the dark air
 * beside it is a panel nobody can see, which is exactly what made this desk read as a table on
 * legs; two lighter rows between the legs are what turn the gap into a *front*.
 *
 * `side` is −1 for a pedestal on the left, 1 on the right, 0 for legs at both ends.
 */
function deskUnder(
  ctx: CanvasRenderingContext2D,
  x: number,
  yTop: number,
  w: number,
  yBase: number,
  side: -1 | 0 | 1,
): void {
  const h = yBase - yTop + 1;
  if (h <= 0) return;
  // The gap under the desk is not empty floor — it is floor the desk is standing over.
  rect(ctx, x + 2, yTop, w - 4, h, PAL.shd, 0.34);

  const pedW = side === 0 ? 0 : Math.min(15, Math.round(w * 0.34));
  const pedX = side < 0 ? x : x + w - pedW;

  // Modesty panel, set back a row from the floor the way a real one clears the carpet.
  const mx = side < 0 ? pedX + pedW + 1 : x + 7;
  const mEnd = side > 0 ? pedX - 1 : x + w - 7;
  const mw = mEnd - mx;
  const mh = Math.max(2, h - 1);
  if (mw >= 6) {
    rect(ctx, mx, yTop, mw, mh, PAL.wdf);
    rect(ctx, mx, yTop, mw, 1, PAL.wdd); // the worktop's own shadow lands on its top edge
    rect(ctx, mx, yTop + mh - 2, mw, 1, PAL.wdd);
    rect(ctx, mx, yTop + mh - 1, mw, 1, PAL.out);
    rect(ctx, mx, yTop, 1, mh, PAL.out);
    rect(ctx, mx + mw - 1, yTop, 1, mh, PAL.out);
  }

  if (side >= 0) deskLeg(ctx, x + 2, yTop, h, yBase);
  if (side <= 0) deskLeg(ctx, x + w - 6, yTop, h, yBase);
  if (side === 0) return;

  // The pedestal: two or three fronts, each with a lit top lip, a pull, and a seam under it.
  const drawers = h >= 9 ? 3 : 2;
  const dh = Math.floor(h / drawers);
  rect(ctx, pedX, yTop, pedW, h, PAL.wdf);
  rect(ctx, pedX, yTop, pedW, 1, PAL.wdd);
  rect(ctx, pedX + pedW - 3, yTop, 3, h, PAL.wdd); // the end that turns away from the windows
  rect(ctx, pedX, yTop, 1, h, PAL.out);
  rect(ctx, pedX + pedW - 1, yTop, 1, h, PAL.out);
  const hw = Math.max(4, pedW - 8);
  const hx = pedX + Math.round((pedW - hw) / 2);
  for (let d = 0; d < drawers; d++) {
    const dy = yTop + d * dh;
    rect(ctx, pedX + 1, dy, pedW - 2, 1, PAL.wdl, 0.4);
    rect(ctx, hx, dy + Math.max(1, dh - 2), hw, 1, PAL.me3);
    rect(ctx, pedX + 1, dy + dh - 1, pedW - 2, 1, PAL.out);
  }
  rect(ctx, pedX + 1, yBase, pedW - 2, 1, PAL.out);
}

// --------------------------------------------------------------------------- office chair

export const CHAIR = { w: 18, h: 20 } as const;

/**
 * The modern high-backed chair: mesh back, a headrest standing clear of it, armrests, a gas
 * cylinder and a five-star base on castors.
 *
 * This is the most-drawn sprite in the office — one sits behind every seated agent — so it is
 * worth more pixels than anything else in this file. Three things carry it. The headrest is
 * *separate*, joined by a four-pixel stem with daylight either side of it, because that gap is
 * the whole silhouette of a modern task chair. The back is a dark `blk`/`bl2` frame around a
 * lighter `me2` mesh panel, so the shape survives being seen against a brown floor on one side and
 * a near-black monitor bezel on the other — a chair drawn in one dark tone is a smudge at this
 * size. The mesh strands inside it run *vertically*, in `bl2`: horizontal ribs at this pitch
 * stack up with the frame rails above and below them and the whole back reads as a radiator
 * grille. And the base really is five spokes with castors on their tips,
 * drawn as stepped runs rather than as a bar, because the star is what makes a viewer read
 * "office chair" before they have read anything else.
 *
 * Three views, and `back` is the one that matters — almost every chair in the room is seen from
 * behind, because that is where a person sitting at a monitor puts it. `front` and `side` exist
 * for the empty chairs and the roundtable approaches.
 */
const CHAIR_MAP: Art['map'] = {
  o: 'out',
  k: 'blk',
  K: 'bl2',
  n: 'me2',
  M: 'me3',
};

/**
 * `swivel` (−1…1) shears the sprite rather than sliding it. The headrest moves three pixels, the
 * back and arms two, and the seat on top of the post stays where it is — so there is always a
 * fixed part to see the moving part against. A block translated whole reads as a chair sliding
 * sideways across the floor, and worse, is nearly invisible: with nothing standing still in the
 * frame there is nothing to measure the shift against.
 */
const CHAIR_HEAD_END = 5;
const CHAIR_ARMS_END = 12;
const CHAIR_ROWS = 15;

const CHAIR_BACK: Art = {
  rows: [
    '.....oooooooo.....',
    '.....oMnnnnno.....',
    '.....oKkkkkko.....',
    '.....oooooooo.....',
    '.......onno.......',
    '..oooooooooooooo..',
    '..okkkkkkkkkkkko..',
    '..oKnnKnnnnKnnKo..',
    '..oKnnKnnnnKnnKo..',
    'oMMonnKnnnnKnnonno',
    'oKKoKKKKKKKKKKokko',
    'ooookkkkkkkkkkoooo',
    '.oMMMMMMMMMMMMMMo.',
    '.oKKKKKKKKKKKkkko.',
    '.oooooooooooooooo.',
  ],
  map: CHAIR_MAP,
};

/**
 * Seen from the front you are looking at the *padded* side of everything: the headrest shows its
 * cushion face rather than its mesh backing, the backrest carries a lumbar pad down its middle, and
 * — the part that actually separates the two sprites at a glance — the seat pan is no longer hidden
 * behind the back, so it flares a full two pixels wider than the chair above it and catches the
 * light. The back view keeps its dark mesh, its narrower seat and its shadowed near edge. Same
 * chair, but at 18 pixels the silhouette has to do the telling, not the tone.
 */
const CHAIR_FRONT: Art = {
  rows: [
    '.....oooooooo.....',
    '.....oMnnnnMo.....',
    '.....onnnnnno.....',
    '.....oooooooo.....',
    '.......onno.......',
    '..oooooooooooooo..',
    '..oKnMMMMMMMMnKo..',
    '..oKnMMMMMMMMnKo..',
    '..oKnnMMMMMMnnKo..',
    'oMMonnnnnnnnnnonno',
    'oMMoKnnnnnnnnKokko',
    'ooooKKKKKKKKKKoooo',
    'oMMMMMMMMMMMMMMMMo',
    'onnnnnnnnnnnnnnnno',
    'oooooooooooooooooo',
  ],
  map: CHAIR_MAP,
};

/**
 * The side view leans.
 *
 * A task chair's back is raked five or six degrees off vertical and its shell is a good four
 * pixels thick; drawn as a straight two-pixel post it read as a signpost with a seat nailed to it.
 * Here the back is five pixels of material inside its outline and it walks two columns to the
 * right on the way down, with the headrest carried one column further back again — so the whole
 * upper half of the silhouette slants away from the seat, which is the single cue that says
 * "chair" rather than "partition".
 */
const CHAIR_SIDE: Art = {
  rows: [
    'oooooo............',
    'oMnnno............',
    'oKkkko............',
    'oooooo............',
    '..onno............',
    '.ooooooo..........',
    '.oMnnnKo..........',
    '..oMnnnKo.........',
    '..oMnnnKo.........',
    '...oMnnnKoooooooo.',
    '...oMnnnKoMMMMMno.',
    '...oMnnnKoooooooo.',
    '..oMMMMMMMMMMMMMo.',
    '..oKKKKKKKKKKkkko.',
    '..ooooooooooooooo.',
  ],
  map: CHAIR_MAP,
};

const CHAIRS = { back: CHAIR_BACK, front: CHAIR_FRONT, side: CHAIR_SIDE } as const;

const slice = (art: Art, from: number, to: number): Art => ({
  rows: art.rows.slice(from, to),
  map: art.map,
});

/**
 * The five spokes, as (dx, dy) from the hub. Two reach sideways and a touch away from the camera,
 * two come forward, and the fifth points straight back and is all but swallowed by the cylinder —
 * which is exactly how a five-star base looks from a raised three-quarter angle, and why four
 * castors read as five legs.
 */
const CHAIR_SPOKES: readonly (readonly [number, number])[] = [
  [-8, 0],
  [8, 0],
  [-5, 1],
  [5, 1],
];

/** One leg: a stepped run out to the tip, a hard row under it, and a castor on the end. */
function chairSpoke(
  ctx: CanvasRenderingContext2D,
  cx: number,
  hy: number,
  tx: number,
  ty: number,
): void {
  const n = Math.max(Math.abs(tx), Math.abs(ty), 1);
  for (let i = 1; i <= n; i++) {
    const x = cx + Math.round((tx * i) / n);
    const y = hy + Math.round((ty * i) / n);
    rect(ctx, x, y, 1, 1, PAL.blk);
    rect(ctx, x, y + 1, 1, 1, PAL.out);
    if (i <= 2) rect(ctx, x, y, 1, 1, PAL.me2, 0.7);
  }
  if (ty < 0) return; // the leg pointing away from the camera keeps its castor hidden
  const castX = tx < 0 ? cx + tx : cx + tx - 1;
  rect(ctx, castX, hy + ty, 2, 2, PAL.blk);
  rect(ctx, castX, hy + ty + 1, 2, 1, PAL.out);
  rect(ctx, castX, hy + ty, 2, 1, PAL.me2, 0.45);
}

/** Gas cylinder and star base. Never turns with the seat — that is the whole point of a swivel. */
function chairPost(ctx: CanvasRenderingContext2D, cx: number, yBase: number): void {
  const hy = yBase - 2;
  chairSpoke(ctx, cx, hy, 0, -1); // the hidden fifth leg, behind the cylinder

  rect(ctx, cx - 2, yBase - 4, 1, 3, PAL.out);
  rect(ctx, cx - 1, yBase - 4, 1, 3, PAL.me3);
  rect(ctx, cx, yBase - 4, 1, 3, PAL.me2);
  rect(ctx, cx + 1, yBase - 4, 1, 3, PAL.out);

  for (const [tx, ty] of CHAIR_SPOKES) chairSpoke(ctx, cx, hy, tx, ty);

  rect(ctx, cx - 2, hy, 4, 1, PAL.me2);
  rect(ctx, cx - 2, hy + 1, 4, 1, PAL.blk);
  rect(ctx, cx - 2, hy + 2, 4, 1, PAL.out);
}

/** How far up-screen a tucked-in chair sits. Up is away from the camera, i.e. under the desk. */
const CHAIR_PUSH = 3;

/**
 * `pushed` is the whole visual grammar of "this agent finished and left".
 *
 * A chair somebody stood up from and slid back under the worktop moves *away* from the camera,
 * which at this angle is straight up the screen, so the entire sprite — seat, post, star and
 * contact shadow together — draws three rows higher and its headrest ends up overlapping the desk
 * edge in front of it. It also stops swivelling: an empty chair rotating on its own is the room
 * telling you somebody is still sitting there. Pushed-in plus a `blank` monitor is the pair the
 * eye reads as a finished desk from right across the office.
 */
export function drawChair(
  ctx: CanvasRenderingContext2D,
  cx: number,
  yBase: number,
  view: 'back' | 'front' | 'side',
  swivel: number,
  pushed?: boolean,
): void {
  const art = CHAIRS[view];
  const tucked = pushed === true;
  const yb = tucked ? yBase - CHAIR_PUSH : yBase;
  const x0 = Math.round(cx - CHAIR.w / 2);
  const y0 = yb - CHAIR.h + 1;
  const sw = tucked ? 0 : clamp11(swivel);
  const dHead = Math.round(sw * 3);
  const dBack = Math.round(sw * 2);

  contact(ctx, cx, yb, CHAIR.w - 2);
  chairPost(ctx, cx, yb);
  drawArt(ctx, slice(art, CHAIR_ARMS_END, CHAIR_ROWS), x0, y0 + CHAIR_ARMS_END);
  drawArt(ctx, slice(art, CHAIR_HEAD_END, CHAIR_ARMS_END), x0 + dBack, y0 + CHAIR_HEAD_END);
  drawArt(ctx, slice(art, 0, CHAIR_HEAD_END), x0 + dHead, y0);
}

// --------------------------------------------------------------------------- monitors

export const MONITOR = { w: 20, h: 15, smallW: 13, smallH: 11 } as const;

/**
 * What is on the screen. Mirrors the office's tool kinds; kept as a local union because this
 * module may not import anything but ./art and ./preview.
 */
export type Screen = 'code' | 'log' | 'page' | 'search' | 'link' | 'wait' | 'blank';

/** How it is going. Colours the screen: work blue, wait amber, error red, done grey. */
export type Mood = 'work' | 'wait' | 'error' | 'done';

/**
 * How a mood paints a screen.
 *
 * The temptation here is to flood the panel in the status colour, and it is wrong: the screen is
 * sixteen pixels by seven, and sixteen by seven of solid red is an alarm klaxon, not a grep that
 * came back empty. So a mood gets a *wash* over the same blue base, a recoloured content ink, the
 * glow along the top edge, and one pixel of border — four small things that agree with each other,
 * which is far louder at a glance than one big thing shouting.
 */
type MoodPaint = {
  /** What the panel is filled with before anything is drawn on it. */
  base: string;
  /** How hard the mood colour is washed over that fill. Zero for `work` — blue is the baseline. */
  wash: number;
  /** The bright content tone. */
  ink: string;
  /** The quiet content tone, and how far it is knocked back. */
  dim: string;
  dimA: number;
  /** The spill along the screen's top edge, which is also what lights the face in front of it. */
  glow: string;
};

const MOODS: Record<Mood, MoodPaint> = {
  work: { base: PAL.scr, wash: 0, ink: PAL.sc3, dim: PAL.sc2, dimA: 1, glow: PAL.scg },
  wait: { base: PAL.scr, wash: 0.11, ink: PAL.wrn, dim: PAL.wrn, dimA: 0.5, glow: PAL.wrn },
  error: { base: PAL.scr, wash: 0.12, ink: PAL.err, dim: PAL.err, dimA: 0.5, glow: PAL.err },
  done: { base: PAL.bl2, wash: 0.07, ink: PAL.gry, dim: PAL.gry, dimA: 0.42, glow: PAL.gry },
};

/** Everything a screen painter needs: the lit rectangle, the mood, and the clock. */
type Paint = {
  ctx: CanvasRenderingContext2D;
  /** Top-left and size of the *lit area*, inside the bezel. */
  x: number;
  y: number;
  w: number;
  h: number;
  m: MoodPaint;
  /** The agent's own colour, which is what makes one desk tell itself apart from the next. */
  tint: string;
  /** Flicker, already folded into an alpha multiplier. */
  bright: number;
  t: number;
  small: boolean;
};

/** One code line: row within the screen, x offset, width, and which of the three tones. */
type CodeLine = { row: number; x: number; w: number; tone: 0 | 1 | 2 };

const BIG_CODE: readonly CodeLine[] = [
  { row: 0, x: 1, w: 9, tone: 0 },
  { row: 2, x: 1, w: 5, tone: 2 },
  { row: 2, x: 8, w: 6, tone: 1 },
  { row: 4, x: 3, w: 8, tone: 1 },
  { row: 6, x: 1, w: 6, tone: 2 },
];

const SMALL_CODE: readonly CodeLine[] = [
  { row: 0, x: 1, w: 6, tone: 0 },
  { row: 2, x: 1, w: 4, tone: 2 },
  { row: 4, x: 2, w: 5, tone: 1 },
];

/** Code: short ragged lines with a blinking cursor. The default, and the busiest-looking one. */
function screenCode(p: Paint): void {
  const lines = p.small ? SMALL_CODE : BIG_CODE;
  const tones = [p.tint, p.m.ink, p.m.dim] as const;
  const alphas = [1, 1, p.m.dimA] as const;
  for (const ln of lines) {
    if (ln.row >= p.h) continue;
    const w = Math.min(ln.w, p.w - ln.x - 1);
    rect(p.ctx, p.x + ln.x, p.y + ln.row, w, 1, tones[ln.tone], p.bright * alphas[ln.tone]);
  }
  // Cursor: a two-pixel block on the last line, on for half of each ~960ms beat.
  const last = lines[lines.length - 1];
  if (Math.floor(p.t / 480) % 2 === 0) {
    rect(p.ctx, p.x + last.x + last.w + 1, p.y + last.row, 2, 1, p.m.glow, p.bright);
  }
}

/** Line widths a terminal scrolls through. Fixed, so two identical sessions scroll identically. */
const LOG_W = [7, 4, 11, 5, 9, 3, 12, 6, 8, 4] as const;

/**
 * A terminal. Output scrolls upward a pixel at a time and the prompt never moves.
 *
 * The scroll steps in whole pixels — half a pixel per frame would just shimmer — and the buffer
 * only advances every second step, so a line spends one beat at its new row before the next one
 * arrives. A fixed prompt block at the bottom is what stops it reading as a list that happens to be
 * animating: output moves, the prompt stays, and that contrast is the whole idea of a shell.
 */
function screenLog(p: Paint): void {
  const rows = Math.max(2, Math.floor((p.h + 1) / 2));
  const step = Math.floor(p.t / 150);
  const idx = step >> 1;
  const sub = step & 1;

  for (let r = 0; r < rows - 1; r++) {
    const y = p.y + r * 2 + 1 - sub;
    if (y < p.y || y > p.y + p.h - 1) continue;
    const k = (idx + r) % LOG_W.length;
    const hot = k % 4 === 1;
    const w = Math.min(LOG_W[k], p.w - 2);
    rect(p.ctx, p.x + 1, y, w, 1, hot ? p.m.ink : p.m.dim, p.bright * (hot ? 1 : p.m.dimA));
  }

  const py = p.y + p.h - 1;
  rect(p.ctx, p.x + 1, py, 2, 1, p.tint, p.bright);
  rect(p.ctx, p.x + 4, py, Math.max(2, Math.min(6, p.w - 6)), 1, p.m.ink, p.bright * 0.75);
}

/** Per row of a page: runs of `[x, width]` that reach both margins, broken by word gaps. */
const PAGE_ROWS: readonly (readonly (readonly [number, number])[])[] = [
  [
    [1, 5],
    [7, 8],
  ],
  [
    [1, 8],
    [10, 5],
  ],
  [
    [1, 4],
    [6, 3],
    [10, 5],
  ],
];

/**
 * A document: a title bar in the agent's colour and body rows that reach both margins.
 *
 * Denser than code, and that density *is* the read — code is ragged on the right because code is
 * ragged on the right, and prose is not. Two sprites that differ only in line lengths still tell
 * a viewer which one is a file being written and which one is a file being compiled.
 */
function screenPage(p: Paint): void {
  rect(p.ctx, p.x + 1, p.y, Math.max(2, p.w - 4), 1, p.tint, p.bright);
  const bodyA = p.bright * Math.min(1, p.m.dimA * 1.6);
  for (let r = 0; r < PAGE_ROWS.length; r++) {
    const y = p.y + 2 + r * 2;
    if (y > p.y + p.h - 1) break;
    for (const [ox, ow] of PAGE_ROWS[r]) {
      const w = Math.min(ow, p.w - 1 - ox);
      if (w > 0) rect(p.ctx, p.x + ox, y, w, 1, p.m.dim, bodyA);
    }
  }
}

/**
 * A search: quiet lines with one of them struck through in the agent's colour, sitting in a lit
 * band. A magnifying glass at this size is four pixels that read as a smudge; a highlighted match
 * is unmistakable, and it is also what the agent is actually looking at.
 */
function screenSearch(p: Paint): void {
  const hit = p.y + (p.h >> 1);
  rect(p.ctx, p.x, hit - 1, p.w, 3, p.tint, p.bright * 0.26);
  for (let r = 0; r < p.h; r += 2) {
    const y = p.y + r;
    const w = Math.min(p.w - 2, 4 + ((r * 3) % 7));
    rect(p.ctx, p.x + 1, y, w, 1, p.m.dim, p.bright * p.m.dimA);
  }
  rect(p.ctx, p.x + 1, hit, Math.max(2, p.w - 4), 1, p.tint, p.bright);
  rect(p.ctx, p.x + p.w - 2, hit, 1, 1, p.m.glow, p.bright);
}

/**
 * A delegation: one box with two smaller boxes hanging off it. This is what a `Task` call looks
 * like, and it is the one screen whose shape carries meaning rather than texture — a viewer who
 * has watched the room for a minute learns that a tree on a monitor means this desk just made two
 * more desks busy.
 */
function screenLink(p: Paint): void {
  const cx = p.x + (p.w >> 1);
  const big = p.h >= 7;
  const pw = big ? 4 : 3;
  const cw = big ? 3 : 2;
  const spread = big ? 5 : 3;
  const mid = p.y + (big ? 3 : 2);
  const kid = p.y + p.h - 2;
  const wireA = p.bright * Math.min(1, p.m.dimA * 1.5);

  rect(p.ctx, cx, p.y + 2, 1, Math.max(1, mid - p.y - 1), p.m.dim, wireA);
  rect(p.ctx, cx - spread, mid, spread * 2 + 1, 1, p.m.dim, wireA);
  rect(p.ctx, cx - spread, mid, 1, Math.max(1, kid - mid), p.m.dim, wireA);
  rect(p.ctx, cx + spread, mid, 1, Math.max(1, kid - mid), p.m.dim, wireA);

  rect(p.ctx, cx - (pw >> 1), p.y, pw, 2, p.tint, p.bright);
  rect(p.ctx, cx - spread - 1, kid, cw, 2, p.m.ink, p.bright);
  rect(p.ctx, cx + spread - 1, kid, cw, 2, p.m.ink, p.bright);
}

/** Waiting: the last thing it was doing, dimmed right down, under a row of dots that walks. */
function screenWait(p: Paint): void {
  const lines = p.small ? SMALL_CODE : BIG_CODE;
  for (const ln of lines) {
    if (ln.row >= p.h) continue;
    const w = Math.min(ln.w, p.w - ln.x - 1);
    rect(p.ctx, p.x + ln.x, p.y + ln.row, w, 1, p.m.dim, p.bright * 0.3);
  }
  const on = Math.floor(p.t / 340) % 3;
  const cy = p.y + p.h - 2;
  const cx = p.x + (p.w >> 1);
  for (let i = 0; i < 3; i++) {
    rect(p.ctx, cx - 3 + i * 3, cy, 1, 1, p.m.ink, p.bright * (i === on ? 1 : 0.28));
  }
}

/**
 * A monitor. Dark bezel, a screen, a thin neck on a flat foot.
 *
 * `on: false` is not a black rectangle — an off screen in a lit room is a dark grey mirror, so it
 * gets a stepped reflection band. `on: true` lights the panel and paints `screen` onto it: code by
 * default, but also a scrolling log, a document, a search hit, a delegation tree, a wait, or the
 * dark standby of a machine somebody walked away from. The first content tone is the agent's own
 * `tint`, so a glance across the room tells you whose desk you are looking at.
 *
 * `mood` recolours the glow, the ink and one pixel of border — never the whole panel. `flicker`
 * scales how bright the content burns, and `t` drives every animation in here.
 */
export function drawMonitor(
  ctx: CanvasRenderingContext2D,
  cx: number,
  yBase: number,
  o: {
    on: boolean;
    tint: string;
    flicker: number;
    t: number;
    small?: boolean;
    screen?: Screen;
    mood?: Mood;
  },
): void {
  const small = o.small === true;
  const w = small ? MONITOR.smallW : MONITOR.w;
  const h = small ? MONITOR.smallH : MONITOR.h;
  const x0 = Math.round(cx - w / 2);
  const y0 = yBase - h + 1;

  const panelH = small ? 9 : 11; // rows 0 … panelH-1
  const sx = x0 + 2;
  const sy = y0 + 2;
  const sw = w - 4;
  const sh = panelH - 4; // one bezel row above, a chin and an outline below

  // Foot and neck first, so the panel's bottom outline sits over the neck's top.
  const footY = y0 + h - 2;
  const footW = small ? 7 : 11;
  const footX = Math.round(cx - footW / 2);
  rect(ctx, footX, footY, footW, 1, PAL.me3);
  rect(ctx, footX, footY + 1, footW, 1, PAL.me2);
  rect(ctx, footX, footY + 1, footW, 1, PAL.out);
  rect(ctx, footX, footY, 1, 2, PAL.out);
  rect(ctx, footX + footW - 1, footY, 1, 2, PAL.out);
  const neckW = small ? 3 : 4;
  const neckX = Math.round(cx - neckW / 2);
  rect(ctx, neckX, y0 + panelH, neckW, footY - (y0 + panelH), PAL.me2);
  rect(ctx, neckX, y0 + panelH, 1, footY - (y0 + panelH), PAL.out);
  rect(ctx, neckX + neckW - 1, y0 + panelH, 1, footY - (y0 + panelH), PAL.out);

  // Bezel.
  rect(ctx, x0, y0, w, panelH, PAL.blk);
  rect(ctx, x0, y0, w, 1, PAL.out);
  rect(ctx, x0, y0 + panelH - 1, w, 1, PAL.out);
  rect(ctx, x0, y0, 1, panelH, PAL.out);
  rect(ctx, x0 + w - 1, y0, 1, panelH, PAL.out);
  rect(ctx, x0 + 1, y0 + 1, 1, panelH - 2, PAL.bl2); // lit left bezel edge

  if (!o.on) {
    rect(ctx, sx, sy, sw, sh, PAL.bl2);
    // A stepped reflection: three short runs walking down and right, the cheapest way to say
    // "glass" without a gradient.
    for (let i = 0; i < 3; i++) {
      rect(ctx, sx + 1 + i * 2, sy + 1 + i * 2, Math.max(2, sw - 6 - i * 2), 1, PAL.me2, 0.5);
    }
    rect(ctx, sx, sy, sw, 1, PAL.me2, 0.3);
    return;
  }

  const m = MOODS[o.mood ?? 'work'];
  const screen = o.screen ?? 'code';

  // `blank` is not `on: false`. An off monitor is a grey mirror reflecting a lit room; a blank one
  // is a machine that is still powered and has nothing to say — near-black, no reflection, and one
  // dim standby pixel. That difference is what tells a finished desk from an unused one.
  if (screen === 'blank') {
    rect(ctx, sx, sy, sw, sh, PAL.blk);
    rect(ctx, sx, sy, sw, 1, PAL.out, 0.5);
    rect(ctx, sx + sw - 2, sy + sh - 1, 1, 1, m.ink, 0.3);
    return;
  }

  const bright = 0.5 + 0.5 * clamp01(o.flicker);
  rect(ctx, sx, sy, sw, sh, m.base);
  if (m.wash > 0) rect(ctx, sx, sy, sw, sh, m.ink, m.wash);
  rect(ctx, sx, sy, sw, 1, m.glow, 0.16 * bright); // the glow that spills onto the face in front

  const p: Paint = {
    ctx,
    x: sx,
    y: sy,
    w: sw,
    h: sh,
    m,
    // A finished agent's screen keeps no colour of its own — the point of `done` is that this desk
    // has stopped being one of the twelve you are tracking.
    tint: o.mood === 'done' ? m.ink : o.tint,
    bright,
    t: o.t,
    small,
  };

  if (screen === 'log') screenLog(p);
  else if (screen === 'page') screenPage(p);
  else if (screen === 'search') screenSearch(p);
  else if (screen === 'link') screenLink(p);
  else if (screen === 'wait') screenWait(p);
  else screenCode(p);

  // The mood border: the one bezel row that rings the lit area. A third of an alpha, because the
  // panel is twenty pixels wide and anything stronger turns a slow tool call into a fire alarm.
  if (o.mood !== undefined && o.mood !== 'work') {
    rect(ctx, sx - 1, sy - 1, sw + 2, 1, m.ink, 0.45);
    rect(ctx, sx - 1, sy + sh, sw + 2, 1, m.ink, 0.45);
    rect(ctx, sx - 1, sy - 1, 1, sh + 2, m.ink, 0.45);
    rect(ctx, sx + sw, sy - 1, 1, sh + 2, m.ink, 0.45);
  }
  // Power LED on the chin.
  rect(ctx, x0 + w - 4, y0 + panelH - 2, 1, 1, m.ink, 0.8);
}

// --------------------------------------------------------------------------- the roundtable

export const TABLE = { w: 58, h: 26 } as const;

/**
 * The meeting table on the rug: an ellipse seen from above and in front, so the top face is a
 * squashed disc with the slab's thickness showing along its lower edge.
 *
 * Drawn column by column rather than as bands — every column knows where the ellipse starts and
 * ends, so the rim follows the curve instead of being a straight bar under a curved top, which is
 * the tell that gives away a fake round table.
 */
export function drawRoundtable(ctx: CanvasRenderingContext2D, cx: number, yBase: number): void {
  const y0 = yBase - TABLE.h + 1;
  const rx = 28;
  const ry = 7;
  const cy = y0 + 8;
  const thick = 3;

  pool(ctx, cx, yBase - 1, 26, 4, PAL.shd, 0.45, 3);

  // Pedestal and foot, drawn first so the top's rim covers where they meet it.
  const footCy = y0 + 23;
  for (let dx = -11; dx <= 11; dx++) {
    const f = 1 - (dx / 11) ** 2;
    if (f <= 0) continue;
    const dy = Math.round(2 * Math.sqrt(f));
    const x = cx + dx;
    rect(ctx, x, footCy - dy, 1, dy * 2 + 1, PAL.wdd);
    rect(ctx, x, footCy - dy, 1, 1, PAL.wdf);
    rect(ctx, x, footCy + dy, 1, 1, PAL.out);
  }
  rect(ctx, cx - 4, y0 + 15, 8, 9, PAL.wdf);
  rect(ctx, cx - 4, y0 + 15, 1, 9, PAL.wdl);
  rect(ctx, cx + 2, y0 + 15, 2, 9, PAL.wdd);
  rect(ctx, cx + 3, y0 + 15, 1, 9, PAL.out);

  // The top.
  for (let dx = -rx; dx <= rx; dx++) {
    const f = 1 - (dx / rx) ** 2;
    if (f <= 0) continue;
    const dy = Math.round(ry * Math.sqrt(f));
    const x = cx + dx;
    const top = cy - dy;
    const bot = cy + dy;

    rect(ctx, x, top - 1, 1, 1, PAL.out);
    rect(ctx, x, top, 1, bot - top + 1, PAL.wdt);
    rect(ctx, x, top, 1, 2, PAL.wdd); // far edge falls away from the light
    if (dx > rx * 0.3) rect(ctx, x, bot - 2, 1, 3, PAL.wdd, 0.45);
    rect(ctx, x, bot, 1, 1, PAL.wdl); // lit near edge, the top/front seam
    // Inlaid rim groove, two pixels inside the silhouette.
    rect(ctx, x, top + 2, 1, 1, PAL.wdd, 0.5);
    rect(ctx, x, bot - 2, 1, 1, PAL.wdf, 0.6);

    rect(ctx, x, bot + 1, 1, thick, PAL.wdf);
    rect(ctx, x, bot + thick + 1, 1, 1, PAL.out);
  }

  // A laptop, lid toward the far side, and a scatter of papers. A bare table reads as unused.
  const lx = cx - 12;
  const ly = cy + 1;
  rect(ctx, lx, ly - 6, 11, 6, PAL.blk);
  rect(ctx, lx, ly - 6, 11, 1, PAL.out);
  rect(ctx, lx, ly - 6, 1, 6, PAL.bl2);
  rect(ctx, lx + 10, ly - 6, 1, 6, PAL.out);
  rect(ctx, lx + 3, ly - 4, 5, 2, PAL.me2, 0.6);
  rect(ctx, lx - 1, ly, 13, 1, PAL.me3);
  rect(ctx, lx - 1, ly + 1, 13, 1, PAL.me2);
  rect(ctx, lx - 1, ly + 2, 13, 1, PAL.out);

  for (const [px, py, pw] of [
    [cx + 5, cy - 1, 8],
    [cx + 8, cy + 2, 7],
    [cx + 4, cy + 4, 6],
  ] as const) {
    rect(ctx, px, py, pw, 3, PAL.pap);
    rect(ctx, px, py + 2, pw, 1, PAL.pa2);
    rect(ctx, px, py + 3, pw, 1, PAL.out, 0.5);
    rect(ctx, px + 1, py + 1, pw - 3, 1, PAL.pa2);
  }
}

// --------------------------------------------------------------------------- roundtable chairs

const TCHAIR_MAP: Art['map'] = {
  o: 'out',
  W: 'wdl',
  F: 'wdf',
  D: 'wdd',
  T: 'wdt',
};

const TCHAIR_BACK: Art = {
  rows: [
    '.oooooooooo.',
    '.oWWWWWWWWo.',
    '.oFFFFFFFFo.',
    '.oDDDDDDDDo.',
    '.oFFFFFFFFo.',
    '.oDDDDDDDDo.',
    '.oooooooooo.',
    'oTTTTTTTTTTo',
    'oFFFFFFFFFFo',
    'oooooooooooo',
    '.oFo....oFo.',
    '.oFo....oFo.',
    '.oFo....oFo.',
    '.oDo....oDo.',
    '.oDo....oDo.',
    '.ooo....ooo.',
  ],
  map: TCHAIR_MAP,
};

const TCHAIR_FRONT: Art = {
  rows: [
    '.oooooooooo.',
    '.oWWWWWWWWo.',
    '.oTTTTTTTTo.',
    '.oFFFFFFFFo.',
    '.oTTTTTTTTo.',
    '.oFFFFFFFFo.',
    '.oooooooooo.',
    'oWWWWWWWWWWo',
    'oTTTTTTTTTTo',
    'oFFFFFFFFFFo',
    'oooooooooooo',
    '.oFo....oFo.',
    '.oFo....oFo.',
    '.oDo....oDo.',
    '.oDo....oDo.',
    '.ooo....ooo.',
  ],
  map: TCHAIR_MAP,
};

const TCHAIR_SIDE: Art = {
  rows: [
    '..oooo......',
    '..oWWo......',
    '..oFFo......',
    '..oDDo......',
    '..oFFo......',
    '..oDDo......',
    '..oooo......',
    '..oWWWWWWWWo',
    '..oTTTTTTTTo',
    '..oFFFFFFFFo',
    '..oooooooooo',
    '..oFo...oFo.',
    '..oFo...oFo.',
    '..oDo...oDo.',
    '..oDo...oDo.',
    '..ooo...ooo.',
  ],
  map: TCHAIR_MAP,
};

const TCHAIRS = { back: TCHAIR_BACK, front: TCHAIR_FRONT, side: TCHAIR_SIDE } as const;

/** The plain four-legged chair that rings the roundtable. Same anchor rules as everything else. */
export function drawTableChair(
  ctx: CanvasRenderingContext2D,
  cx: number,
  yBase: number,
  view: 'back' | 'front' | 'side',
): void {
  const art = TCHAIRS[view];
  contact(ctx, cx, yBase, 11);
  drawArt(ctx, art, Math.round(cx - 6), yBase - 15);
}

// --------------------------------------------------------------------------- storage

/**
 * Storage against the wall. Three variants, because three identical cabinets in a row is the
 * fastest way to make a room look like a texture rather than a place.
 *
 *  0 — a steel filing cabinet, three drawers with pull handles
 *  1 — a low wooden credenza with sliding doors
 *  2 — open shelving, loaded with boxes and folders
 */
export function drawCabinet(
  ctx: CanvasRenderingContext2D,
  cx: number,
  yBase: number,
  variant: number,
): void {
  const w = 24;
  const h = 20;
  const x0 = Math.round(cx - w / 2);
  const y0 = yBase - h + 1;
  contact(ctx, cx, yBase, w);

  if (variant % 3 === 0) {
    slab(ctx, x0, y0, w, 4, 15, 2, PAL.me3, PAL.me2, PAL.met, PAL.gry, PAL.me2);
    // Drawer seams and handles.
    for (let d = 0; d < 3; d++) {
      const dy = y0 + 5 + d * 5;
      rect(ctx, x0 + 1, dy + 4, w - 2, 1, PAL.out);
      rect(ctx, x0 + 1, dy, w - 2, 1, PAL.me3, 0.35);
      rect(ctx, x0 + 8, dy + 2, 8, 1, PAL.me3);
      rect(ctx, x0 + 8, dy + 3, 8, 1, PAL.out);
    }
    rect(ctx, x0 + 2, yBase, w - 4, 1, PAL.shd);
    return;
  }

  if (variant % 3 === 1) {
    // Low credenza: it only fills the bottom two-thirds of the 24x20 footprint.
    const cy = y0 + 6;
    slab(ctx, x0, cy, w, 4, 9, 3, PAL.wdt, PAL.wdd, PAL.wdf, PAL.wdl, PAL.wdd);
    const doorY = cy + 5;
    rect(ctx, x0 + 2, doorY, 9, 7, PAL.wdd);
    rect(ctx, x0 + 13, doorY, 9, 7, PAL.wdd);
    rect(ctx, x0 + 3, doorY + 1, 7, 5, PAL.wdf);
    rect(ctx, x0 + 14, doorY + 1, 7, 5, PAL.wdf);
    rect(ctx, x0 + 11, doorY, 2, 7, PAL.out); // the sliding-door seam
    rect(ctx, x0 + 9, doorY + 2, 1, 3, PAL.me3);
    rect(ctx, x0 + 14, doorY + 2, 1, 3, PAL.me3);
    rect(ctx, x0 + 2, yBase, w - 4, 1, PAL.shd);
    return;
  }

  // Open shelving. The frame is wood; everything inside it is somebody's mess.
  rect(ctx, x0, y0, w, h, PAL.wdd);
  rect(ctx, x0, y0, w, 1, PAL.out);
  rect(ctx, x0 + 1, y0 + 1, w - 2, 1, PAL.wdl);
  rect(ctx, x0, y0, 1, h, PAL.out);
  rect(ctx, x0 + w - 1, y0, 1, h, PAL.out);
  rect(ctx, x0, yBase, w, 1, PAL.out);
  for (const sy of [y0 + 7, y0 + 13]) {
    rect(ctx, x0 + 1, sy, w - 2, 1, PAL.wdt);
    rect(ctx, x0 + 1, sy + 1, w - 2, 1, PAL.out);
  }
  rect(ctx, x0 + 1, y0 + 2, w - 2, 5, PAL.shd, 0.5);
  rect(ctx, x0 + 1, y0 + 8, w - 2, 5, PAL.shd, 0.5);
  rect(ctx, x0 + 1, y0 + 14, w - 2, 5, PAL.shd, 0.5);

  // Top shelf: two archive boxes.
  boxOn(ctx, x0 + 2, y0 + 6, 9, 4, PAL.pa2, PAL.pap);
  boxOn(ctx, x0 + 12, y0 + 6, 10, 4, PAL.wdf, PAL.wdt);
  // Middle shelf: a run of folders in mixed colours.
  const folders = [PAL.sc2, PAL.pot, PAL.lf2, PAL.pa2, PAL.me2, PAL.po2, PAL.lf3] as const;
  for (let i = 0; i < folders.length; i++) {
    const fx = x0 + 2 + i * 3;
    rect(ctx, fx, y0 + 9, 2, 4, folders[i]);
    rect(ctx, fx + 2, y0 + 9, 1, 4, PAL.out);
    rect(ctx, fx, y0 + 9, 2, 1, PAL.wht, 0.25);
  }
  // Bottom shelf: one big box and a leaning stack of paper.
  boxOn(ctx, x0 + 2, y0 + 18, 11, 5, PAL.wdf, PAL.wdt);
  rect(ctx, x0 + 15, y0 + 15, 6, 4, PAL.pap);
  rect(ctx, x0 + 15, y0 + 18, 6, 1, PAL.pa2);
  rect(ctx, x0 + 15, y0 + 19, 6, 1, PAL.out);
}

/** A closed box resting on a shelf: dark body, lit lid, taped seam. */
function boxOn(
  ctx: CanvasRenderingContext2D,
  x: number,
  yBase: number,
  w: number,
  h: number,
  body: string,
  lid: string,
): void {
  rect(ctx, x, yBase - h + 1, w, h, body);
  rect(ctx, x, yBase - h + 1, w, 1, lid);
  rect(ctx, x, yBase - h + 1, 1, h, PAL.out);
  rect(ctx, x + w - 1, yBase - h + 1, 1, h, PAL.out);
  rect(ctx, x, yBase, w, 1, PAL.out);
  rect(ctx, x + Math.floor(w / 2), yBase - h + 2, 1, h - 2, PAL.pa2, 0.5);
}

// --------------------------------------------------------------------------- wall shelf

/**
 * A shelf on the wall: plank, two brackets, and the things standing on it.
 *
 * `yBase` is the bottom of the brackets — the shelf's lowest row against the wall — so a wall
 * fixture sorts by the same rule as anything on the floor.
 */
export function drawShelf(ctx: CanvasRenderingContext2D, cx: number, yBase: number): void {
  const w = 32;
  const x0 = Math.round(cx - w / 2);
  const y0 = yBase - 14; // sprite occupies rows y0 … yBase

  const plankY = y0 + 8;
  // Books, standing on top of the plank.
  const books = [
    { c: PAL.sc2, h: 7 },
    { c: PAL.pot, h: 8 },
    { c: PAL.lf2, h: 6 },
    { c: PAL.pa2, h: 8 },
    { c: PAL.po2, h: 7 },
    { c: PAL.me2, h: 6 },
  ];
  let bx = x0 + 2;
  for (const b of books) {
    rect(ctx, bx, plankY - b.h, 2, b.h, b.c);
    rect(ctx, bx, plankY - b.h, 2, 1, PAL.wht, 0.3);
    rect(ctx, bx + 2, plankY - b.h, 1, b.h, PAL.out);
    bx += 3;
  }

  // Two folders leaning against the last book — a stepped parallelogram, not a rotated rect.
  for (let i = 0; i < 2; i++) {
    const fx = bx + 1 + i * 3;
    for (let r = 0; r < 6; r++) {
      rect(ctx, fx + Math.floor(r / 2), plankY - 6 + r, 3, 1, i === 0 ? PAL.pap : PAL.wdf);
      rect(ctx, fx + Math.floor(r / 2) + 3, plankY - 6 + r, 1, 1, PAL.out);
    }
  }

  // A small plant at the right end.
  const px = x0 + w - 7;
  rect(ctx, px + 1, plankY - 4, 5, 4, PAL.pot);
  rect(ctx, px + 1, plankY - 4, 5, 1, PAL.po2);
  rect(ctx, px + 1, plankY - 1, 5, 1, PAL.out);
  rect(ctx, px + 6, plankY - 4, 1, 4, PAL.out);
  rect(ctx, px + 2, plankY - 7, 3, 3, PAL.lf1);
  rect(ctx, px, plankY - 6, 2, 2, PAL.lf2);
  rect(ctx, px + 5, plankY - 6, 2, 2, PAL.lf2);
  rect(ctx, px + 3, plankY - 8, 2, 1, PAL.lf3);

  // The plank itself.
  rect(ctx, x0, plankY, w, 1, PAL.wdl);
  rect(ctx, x0, plankY + 1, w, 1, PAL.wdt);
  rect(ctx, x0, plankY + 2, w, 1, PAL.wdf);
  rect(ctx, x0, plankY + 3, w, 1, PAL.out);
  rect(ctx, x0, plankY, 1, 3, PAL.out);
  rect(ctx, x0 + w - 1, plankY, 1, 3, PAL.out);

  // Brackets: three stepped rows, so they read as triangles.
  for (const bxx of [x0 + 4, x0 + w - 8]) {
    rect(ctx, bxx, plankY + 4, 4, 1, PAL.blk);
    rect(ctx, bxx, plankY + 5, 3, 1, PAL.blk);
    rect(ctx, bxx, plankY + 6, 2, 1, PAL.blk);
    rect(ctx, bxx, plankY + 4, 1, 3, PAL.out);
  }
  // The shadow the shelf throws on the wall below it.
  rect(ctx, x0 + 1, plankY + 4, w - 2, 2, PAL.shd, 0.28);
}

// --------------------------------------------------------------------------- kitchen counter

const COUNTER_H = 24;
const COUNTER_SEG = 16;

/**
 * The kitchen run, tiled to `w`.
 *
 * The worktop is drawn as one continuous surface and only the cupboard fronts repeat, because a
 * counter whose *top* tiles reads as a row of separate boxes. The middle segment carries the sink
 * and the tap, which is the landmark that makes the corner read as a kitchen at all.
 */
export function drawCounter(
  ctx: CanvasRenderingContext2D,
  cx: number,
  yBase: number,
  w: number,
): void {
  const width = Math.max(COUNTER_SEG, Math.round(w));
  const x0 = Math.round(cx - width / 2);
  const y0 = yBase - COUNTER_H + 1;
  const segs = Math.max(1, Math.round(width / COUNTER_SEG));
  const segW = width / segs;
  const mid = Math.floor(segs / 2);

  // Cupboard carcass.
  rect(ctx, x0, y0 + 8, width, 13, PAL.wdf);
  rect(ctx, x0, y0 + 8, 1, 13, PAL.out);
  rect(ctx, x0 + width - 1, y0 + 8, 1, 13, PAL.out);
  rect(ctx, x0, y0 + 21, width, 1, PAL.out);
  rect(ctx, x0 + 2, y0 + 22, width - 4, 2, PAL.shd); // toe kick, set back
  rect(ctx, x0 + 2, yBase, width - 4, 1, PAL.out);

  // Doors, one pair of details per segment.
  for (let s = 0; s < segs; s++) {
    const sx = Math.round(x0 + s * segW);
    const sw = Math.round(x0 + (s + 1) * segW) - sx;
    rect(ctx, sx + 2, y0 + 10, sw - 4, 9, PAL.wdd);
    rect(ctx, sx + 3, y0 + 11, sw - 6, 7, PAL.wdf);
    rect(ctx, sx + 3, y0 + 11, sw - 6, 1, PAL.wdt, 0.4);
    rect(ctx, sx + Math.floor(sw / 2) - 2, y0 + 12, 4, 1, PAL.me3);
    rect(ctx, sx + Math.floor(sw / 2) - 2, y0 + 13, 4, 1, PAL.out);
    if (s > 0) rect(ctx, sx, y0 + 8, 1, 13, PAL.wdd);
  }

  // Worktop, laid over the carcass so its near edge overhangs.
  rect(ctx, x0 + 1, y0 + 3, width - 2, 1, PAL.out);
  rect(ctx, x0, y0 + 4, width, 2, PAL.gry);
  rect(ctx, x0, y0 + 4, width, 1, PAL.me2, 0.45);
  rect(ctx, x0, y0 + 6, width, 1, PAL.wht);
  rect(ctx, x0, y0 + 7, width, 1, PAL.me2);
  rect(ctx, x0, y0 + 8, width, 1, PAL.out);
  rect(ctx, x0, y0 + 3, 1, 5, PAL.out);
  rect(ctx, x0 + width - 1, y0 + 3, 1, 5, PAL.out);

  // Sink and tap in the middle segment.
  const mx = Math.round(x0 + mid * segW);
  const mw = Math.round(x0 + (mid + 1) * segW) - mx;
  const bx = mx + Math.max(2, Math.floor((mw - 11) / 2));
  const bw = Math.min(11, mw - 4);
  rect(ctx, bx - 1, y0 + 3, bw + 2, 4, PAL.me2);
  rect(ctx, bx, y0 + 4, bw, 3, PAL.bl2);
  rect(ctx, bx, y0 + 3, bw, 1, PAL.out);
  rect(ctx, bx + 1, y0 + 5, bw - 2, 1, PAL.me3, 0.35);
  rect(ctx, bx - 1, y0 + 7, bw + 2, 1, PAL.wht, 0.7);

  const tx = bx + Math.floor(bw / 2);
  rect(ctx, tx, y0, 1, 4, PAL.me3);
  rect(ctx, tx + 1, y0, 1, 4, PAL.me2);
  rect(ctx, tx - 3, y0, 4, 1, PAL.me3);
  rect(ctx, tx - 3, y0 + 1, 1, 2, PAL.me2);
  rect(ctx, tx - 3, y0, 1, 1, PAL.out);
  rect(ctx, tx + 2, y0, 1, 4, PAL.out);
}

// --------------------------------------------------------------------------- fridge

const FRIDGE = { w: 22, h: 42 } as const;

/** The kitchen fridge: two doors, a seam, vertical handles, and exactly one magnet. */
export function drawFridge(ctx: CanvasRenderingContext2D, cx: number, yBase: number): void {
  const { w, h } = FRIDGE;
  const x0 = Math.round(cx - w / 2);
  const y0 = yBase - h + 1;
  contact(ctx, cx, yBase, w);

  slab(ctx, x0, y0, w, 4, h - 5, 2, PAL.me3, PAL.me2, PAL.met, PAL.gry, PAL.me2);

  // Left edge catches the window light; right edge falls away.
  rect(ctx, x0 + 1, y0 + 4, 1, h - 6, PAL.me3);
  rect(ctx, x0 + w - 3, y0 + 4, 2, h - 6, PAL.me2);

  // The seam between freezer and fridge.
  const seam = y0 + 15;
  rect(ctx, x0 + 1, seam, w - 2, 1, PAL.out);
  rect(ctx, x0 + 1, seam + 1, w - 2, 1, PAL.me3, 0.4);

  // Handles, both on the opening side.
  for (const [hy, hh] of [
    [y0 + 8, 6],
    [seam + 4, 12],
  ] as const) {
    rect(ctx, x0 + w - 7, hy, 2, hh, PAL.blk);
    rect(ctx, x0 + w - 7, hy, 1, hh, PAL.bl2);
    rect(ctx, x0 + w - 5, hy, 1, hh, PAL.out);
    rect(ctx, x0 + w - 7, hy + hh, 2, 1, PAL.out);
  }

  // One magnet holding one note. More than one and it stops being a detail.
  rect(ctx, x0 + 4, seam + 6, 6, 7, PAL.pap);
  rect(ctx, x0 + 4, seam + 12, 6, 1, PAL.pa2);
  rect(ctx, x0 + 4, seam + 13, 6, 1, PAL.out, 0.6);
  rect(ctx, x0 + 5, seam + 8, 4, 1, PAL.gry, 0.7);
  rect(ctx, x0 + 5, seam + 10, 3, 1, PAL.gry, 0.7);
  rect(ctx, x0 + 6, seam + 5, 2, 2, PAL.pot);
  rect(ctx, x0 + 6, seam + 5, 2, 1, PAL.po2);

  // Plinth.
  rect(ctx, x0 + 1, yBase - 1, w - 2, 2, PAL.blk);
  rect(ctx, x0 + 1, yBase, w - 2, 1, PAL.out);
}

// --------------------------------------------------------------------------- the break corner

/**
 * The furniture agents gather around once their work is done.
 *
 * The break corner is the one part of the office that is not laid out on a grid: a café table with
 * nothing but mugs on it, stools that can be dragged anywhere, a couch shoved against the wall and
 * an ash stand nobody empties. Everything in here is deliberately *lower* than the working
 * furniture — a stool is eleven pixels where a task chair is twenty — because a corner of squat,
 * scattered shapes is what tells a viewer, from right across the room, that this is where people go
 * when they stop working.
 */

/** The café table's real footprint: 21 wide across the top, 16 tall including the pedestal. */
export const LOUNGE = { w: 21, h: 16 } as const;

/**
 * A small round café table for two or three people to stand around with mugs.
 *
 * Not a shrunk `drawRoundtable`: that one is a 58-wide meeting table with chairs at it, and the
 * same construction at a third of the width turns into a brown lozenge. What survives the scale is
 * the column-by-column ellipse — every column knows where the top starts and ends, so the rim
 * follows the curve instead of being a straight bar under a curved top — and the pedestal. Four
 * legs at this size are four one-pixel sticks that read as a smudge under the table; a single
 * column on a disc foot is three clean shapes and reads as a café table from across the room.
 */
export function drawLoungeTable(
  ctx: CanvasRenderingContext2D,
  cx: number,
  yBase: number,
): void {
  const y0 = yBase - LOUNGE.h + 1;
  const rx = 11;
  const ry = 3;
  const cy = y0 + 4;
  const thick = 2;

  contact(ctx, cx, yBase, 15);

  // Foot first, then the column, then the top over both — the same order the parts occlude in.
  const footCy = yBase - 1;
  for (let dx = -6; dx <= 6; dx++) {
    const f = 1 - (dx / 6) ** 2;
    if (f <= 0) continue;
    const dy = Math.round(1.2 * Math.sqrt(f));
    const x = cx + dx;
    rect(ctx, x, footCy - dy, 1, dy * 2 + 1, PAL.wdd);
    rect(ctx, x, footCy - dy, 1, 1, PAL.wdf);
    rect(ctx, x, footCy + dy, 1, 1, PAL.out);
  }

  const colTop = y0 + 8;
  const colH = yBase - 2 - colTop + 1;
  rect(ctx, cx - 2, colTop, 4, colH, PAL.wdf);
  rect(ctx, cx - 2, colTop, 1, colH, PAL.wdl); // the column's lit left face
  rect(ctx, cx, colTop, 1, colH, PAL.wdd);
  rect(ctx, cx + 1, colTop, 1, colH, PAL.out);
  // A one-row flare where the column meets the foot, so the join is not a butt seam.
  rect(ctx, cx - 3, yBase - 3, 6, 1, PAL.wdf);
  rect(ctx, cx - 3, yBase - 3, 1, 1, PAL.out);
  rect(ctx, cx + 2, yBase - 3, 1, 1, PAL.out);

  for (let dx = -rx; dx <= rx; dx++) {
    const f = 1 - (dx / rx) ** 2;
    if (f <= 0) continue;
    const dy = Math.round(ry * Math.sqrt(f));
    const x = cx + dx;
    const top = cy - dy;
    const bot = cy + dy;

    rect(ctx, x, top - 1, 1, 1, PAL.out);
    rect(ctx, x, top, 1, bot - top + 1, PAL.wdt);
    rect(ctx, x, top, 1, 1, PAL.wdd); // the far edge falls away from the light
    if (dx > rx * 0.35) rect(ctx, x, bot - 1, 1, 2, PAL.wdd, 0.4);
    rect(ctx, x, bot, 1, 1, PAL.wdl); // lit near edge — the top/front seam
    rect(ctx, x, bot + 1, 1, thick, PAL.wdf);
    rect(ctx, x, bot + thick + 1, 1, 1, PAL.out);
  }

  // A mug somebody put down and a plate somebody left. A bare café table reads as stock.
  //
  // The top is seven rows deep at its centre, so the mug gets four of them and no more: a taller
  // one stops being an object standing *on* a surface and becomes a hole punched through it.
  rect(ctx, cx - 7, cy + 1, 5, 1, PAL.pa2);
  rect(ctx, cx - 6, cy, 3, 1, PAL.pap);

  const mx = cx + 3;
  rect(ctx, mx + 2, cy - 1, 1, 1, PAL.gry); // handle
  rect(ctx, mx + 3, cy - 1, 1, 1, PAL.out);
  rect(ctx, mx - 2, cy - 2, 4, 4, PAL.out);
  rect(ctx, mx - 2, cy - 1, 3, 2, PAL.wht);
  rect(ctx, mx, cy - 1, 1, 2, PAL.gry);
  rect(ctx, mx - 2, cy - 1, 2, 1, PAL.wdd, 0.7); // what is in it
}

/** The stool's real footprint. A task chair is 18 x 20; this is deliberately half its height. */
export const STOOL = { w: 9, h: 11 } as const;

/** One splayed leg: a stepped run from `xTop` to `xBot`, lit on its left, footed on the floor. */
function stoolLeg(
  ctx: CanvasRenderingContext2D,
  xTop: number,
  xBot: number,
  yTop: number,
  yBase: number,
): void {
  const n = yBase - yTop;
  let x = xTop;
  for (let i = 0; i < n; i++) {
    x = Math.round(xTop + ((xBot - xTop) * i) / (n - 1));
    rect(ctx, x, yTop + i, 1, 1, PAL.me3);
    rect(ctx, x + 1, yTop + i, 1, 1, PAL.out);
  }
  rect(ctx, x, yBase, 2, 1, PAL.out);
}

/**
 * A backless stool.
 *
 * `view` changes the leg spread and nothing else. A round pad has no front and no back — turning
 * one would be a lie the sprite cannot tell at nine pixels — but the *frame* under it does read
 * differently: seen square-on the legs splay wide and you see the footrest ring across them, seen
 * from the side they collapse toward each other and the ring shortens to a stub. That is the whole
 * difference, and it is enough, because a stool's silhouette is its legs.
 */
export function drawStool(
  ctx: CanvasRenderingContext2D,
  cx: number,
  yBase: number,
  view: 'front' | 'side',
): void {
  const y0 = yBase - STOOL.h + 1;
  const wide = view === 'front';
  const legTop = y0 + 5;

  contact(ctx, cx, yBase, STOOL.w);

  // The far leg, drawn first and kept dark — it is the pixel that stops four legs reading as two.
  rect(ctx, cx - 1, legTop, 2, yBase - legTop, PAL.me2);
  rect(ctx, cx, legTop, 1, yBase - legTop, PAL.out);

  const spread = wide ? 3 : 1;
  stoolLeg(ctx, cx - 3, cx - 3 - spread, legTop, yBase);
  stoolLeg(ctx, cx + 2, cx + 2 + spread, legTop, yBase);

  // The footrest ring, two rows above the floor and only as wide as the legs are at that height.
  const ringY = yBase - 3;
  const ringHalf = wide ? 4 : 3;
  rect(ctx, cx - ringHalf, ringY, ringHalf * 2 + 1, 1, PAL.me3);
  rect(ctx, cx - ringHalf, ringY + 1, ringHalf * 2 + 1, 1, PAL.out);

  // The pad: six rows that widen and then narrow again, so it reads round rather than square.
  rect(ctx, cx - 2, y0, 5, 1, PAL.out);
  rect(ctx, cx - 3, y0 + 1, 7, 1, PAL.wdd);
  rect(ctx, cx - 4, y0 + 2, 9, 1, PAL.wdt);
  rect(ctx, cx - 4, y0 + 3, 9, 1, PAL.wdl); // lit near edge
  rect(ctx, cx - 3, y0 + 4, 7, 1, PAL.wdf);
  rect(ctx, cx - 2, y0 + 5, 5, 1, PAL.out);
  for (const [ry, rw] of [
    [y0 + 1, 7],
    [y0 + 2, 9],
    [y0 + 3, 9],
    [y0 + 4, 7],
  ] as const) {
    const rx0 = cx - ((rw - 1) >> 1);
    rect(ctx, rx0, ry, 1, 1, PAL.out);
    rect(ctx, rx0 + rw - 1, ry, 1, 1, PAL.out);
  }
}

/** The couch's real footprint: 34 wide, 18 tall, feet included. */
export const COUCH = { w: 34, h: 18 } as const;

/** Row-by-row inset and tone for the backrest. Row 0 is the rounded `out` cap over the top. */
const COUCH_BACK: readonly (readonly [number, string])[] = [
  [3, PAL.out],
  [2, PAL.me3],
  [1, PAL.me3],
  [1, PAL.met],
  [0, PAL.met],
  [0, PAL.met],
  [0, PAL.me2],
  [0, PAL.me2],
  [0, PAL.me2],
  [0, PAL.bl2],
];

/** One arm: rounded over three rows, then a flat front face down to the frame. */
function couchArm(ctx: CanvasRenderingContext2D, x: number, y0: number): void {
  const aw = 6;
  rect(ctx, x + 2, y0 + 5, 2, 1, PAL.out);
  rect(ctx, x + 1, y0 + 6, 4, 1, PAL.me3);
  rect(ctx, x + 1, y0 + 6, 1, 1, PAL.out);
  rect(ctx, x + 4, y0 + 6, 1, 1, PAL.out);
  rect(ctx, x, y0 + 7, aw, 1, PAL.me3);
  rect(ctx, x, y0 + 8, aw, 1, PAL.met);
  rect(ctx, x, y0 + 9, aw, 5, PAL.me2);
  rect(ctx, x, y0 + 14, aw, 1, PAL.bl2);
  rect(ctx, x + 1, y0 + 8, 1, 6, PAL.me3, 0.3); // the roll of the arm catching the light
  rect(ctx, x, y0 + 7, 1, 8, PAL.out);
  rect(ctx, x + aw - 1, y0 + 7, 1, 8, PAL.out);
  rect(ctx, x, y0 + 15, aw, 1, PAL.out);
}

/**
 * A two-seat couch against a wall.
 *
 * Everything here is aimed at *soft*. The back and the arms are capped with insets rather than
 * square corners, so no silhouette edge meets another at ninety degrees; the arms roll over a lit
 * top row instead of stopping at one; and the seat is a tone darker than the back, because a
 * cushion somebody has been sitting on is compressed and in the back's shadow, and two identical
 * tones stacked read as one slab of foam. The seam down the middle is the one hard line in the
 * whole sprite, which is exactly why it reads as the join between two cushions.
 */
export function drawCouch(ctx: CanvasRenderingContext2D, cx: number, yBase: number): void {
  const { w, h } = COUCH;
  const x0 = Math.round(cx - w / 2);
  const y0 = yBase - h + 1;
  contact(ctx, cx, yBase, w - 2);

  // Backrest.
  for (let r = 0; r < COUCH_BACK.length; r++) {
    const [ins, tone] = COUCH_BACK[r];
    const rx0 = x0 + ins;
    const rw = w - ins * 2;
    rect(ctx, rx0, y0 + r, rw, 1, tone);
    if (r > 0) {
      rect(ctx, rx0, y0 + r, 1, 1, PAL.out);
      rect(ctx, rx0 + rw - 1, y0 + r, 1, 1, PAL.out);
    }
  }
  rect(ctx, x0 + 2, y0 + 3, w - 4, 1, PAL.me3, 0.25); // piping along the top of the cushions
  rect(ctx, cx, y0 + 3, 1, 6, PAL.bl2, 0.75); // the seam between them
  rect(ctx, cx + 1, y0 + 3, 1, 6, PAL.me3, 0.2);

  // Seat, between the arms. Darker than the back, and sitting in its shadow along the far edge.
  const sx = x0 + 6;
  const sw = w - 12;
  rect(ctx, sx, y0 + 10, sw, 1, PAL.me2);
  rect(ctx, sx, y0 + 10, sw, 1, PAL.bl2, 0.4);
  rect(ctx, sx, y0 + 11, sw, 1, PAL.me2);
  rect(ctx, sx, y0 + 12, sw, 1, PAL.me3); // lit near top corner
  rect(ctx, sx, y0 + 13, sw, 1, PAL.me2);
  rect(ctx, sx, y0 + 14, sw, 1, PAL.bl2);
  rect(ctx, sx, y0 + 15, sw, 1, PAL.out);
  rect(ctx, cx, y0 + 10, 1, 5, PAL.bl2, 0.7);

  // A cushion nobody has put back. One is a detail; two would be a pattern.
  rect(ctx, x0 + 7, y0 + 6, 6, 5, PAL.out);
  rect(ctx, x0 + 8, y0 + 7, 4, 3, PAL.po2);
  rect(ctx, x0 + 8, y0 + 7, 4, 1, PAL.pot);
  rect(ctx, x0 + 8, y0 + 8, 1, 2, PAL.pot, 0.5);

  couchArm(ctx, x0, y0);
  couchArm(ctx, x0 + w - 6, y0);

  // Feet: short, dark, and set in from the ends, so the couch sits rather than rests on the floor.
  for (const fx of [x0 + 2, x0 + w - 5]) {
    rect(ctx, fx, y0 + 16, 3, 1, PAL.blk);
    rect(ctx, fx, y0 + 17, 3, 1, PAL.out);
  }
}

/** The ash stand's real footprint. */
export const ASH = { w: 7, h: 14 } as const;

/**
 * A standing ashtray on a post, for the smokers.
 *
 * Three shapes stacked — bowl, post, weighted base — and the whole thing works because the middle
 * one is thin. The bowl is seven pixels across and the post is three, so the silhouette pinches in
 * the middle and flares at both ends, which is a shape nothing else in the office has. Fill the
 * post out to five and it becomes a bin; leave the sand out of the bowl and it becomes a lamp.
 */
export function drawAshStand(ctx: CanvasRenderingContext2D, cx: number, yBase: number): void {
  const y0 = yBase - ASH.h + 1;
  contact(ctx, cx, yBase, ASH.w);

  // Weighted base: three rows that step out and then stop hard.
  rect(ctx, cx - 2, y0 + 11, 5, 1, PAL.me3);
  rect(ctx, cx - 3, y0 + 12, 7, 1, PAL.me2);
  rect(ctx, cx - 3, y0 + 12, 1, 1, PAL.out);
  rect(ctx, cx + 3, y0 + 12, 1, 1, PAL.out);
  rect(ctx, cx - 3, y0 + 13, 7, 1, PAL.out);

  // Post.
  rect(ctx, cx - 1, y0 + 6, 1, 5, PAL.me3);
  rect(ctx, cx, y0 + 6, 1, 5, PAL.met);
  rect(ctx, cx + 1, y0 + 6, 1, 5, PAL.out);

  // Bowl: a rim, a bed of sand seen from above, and an underside that turns away from the light.
  rect(ctx, cx - 3, y0, 7, 1, PAL.out);
  rect(ctx, cx - 2, y0 + 1, 5, 1, PAL.gry);
  rect(ctx, cx - 2, y0 + 2, 5, 1, PAL.pa2);
  rect(ctx, cx - 3, y0 + 1, 1, 2, PAL.out);
  rect(ctx, cx + 3, y0 + 1, 1, 2, PAL.out);
  rect(ctx, cx - 2, y0 + 3, 5, 1, PAL.me3); // lit near rim
  rect(ctx, cx - 3, y0 + 3, 1, 1, PAL.out);
  rect(ctx, cx + 3, y0 + 3, 1, 1, PAL.out);
  rect(ctx, cx - 1, y0 + 4, 3, 1, PAL.me2);
  rect(ctx, cx - 2, y0 + 4, 1, 1, PAL.out);
  rect(ctx, cx + 2, y0 + 4, 1, 1, PAL.out);
  rect(ctx, cx - 2, y0 + 5, 5, 1, PAL.out);

  // One stub. Two would be litter; none would be a plant pot.
  rect(ctx, cx - 1, y0 + 2, 2, 1, PAL.wht);
  rect(ctx, cx + 1, y0 + 2, 1, 1, PAL.out, 0.7);
}

// --------------------------------------------------------------------------- preview

const TINT = '#e0855a';

/** One monitor in a 24x18 cell, so every screen and every mood is compared on the same panel. */
const screenDemo = (
  ctx: CanvasRenderingContext2D,
  screen: Screen,
  mood: Mood,
  t: number,
): void => drawMonitor(ctx, 12, 16, { on: true, tint: TINT, flicker: 1, t, screen, mood });

export const PREVIEW: PreviewItem[] = [
  { name: 'desk-pod', w: 48, h: 24, draw: (c) => drawDesk(c, 24, 22, 'pod') },
  { name: 'desk-mgr', w: 64, h: 26, draw: (c) => drawDesk(c, 32, 24, 'manager') },

  { name: 'chair-bk', w: 24, h: 22, draw: (c) => drawChair(c, 12, 20, 'back', 0) },
  { name: 'chair-fr', w: 24, h: 22, draw: (c) => drawChair(c, 12, 20, 'front', 0) },
  { name: 'chair-sd', w: 24, h: 22, draw: (c) => drawChair(c, 12, 20, 'side', 0) },
  // The stools sit between the chairs on purpose: same cell, same floor line. A break-corner stool
  // that comes up to a task chair's headrest is not a stool, and this is where that shows.
  { name: 'stool-fr', w: 24, h: 22, draw: (c) => drawStool(c, 12, 20, 'front') },
  { name: 'stool-sd', w: 24, h: 22, draw: (c) => drawStool(c, 12, 20, 'side') },
  // Pushed in, against the same floor line, so the three-pixel step back is measurable here.
  { name: 'chair-in', w: 24, h: 22, draw: (c) => drawChair(c, 12, 20, 'back', 0, true) },
  {
    // A straight sweep from −1 to 1, so two neighbouring frames in the strip are never the same
    // shear. If they look identical here, the swivel is not doing anything in the room either.
    name: 'swivel',
    w: 24,
    h: 22,
    frames: 5,
    frameMs: 200,
    draw: (c, t) => drawChair(c, 12, 20, 'back', t / 400 - 1),
  },

  {
    name: 'mon-on',
    w: 24,
    h: 18,
    frames: 4,
    frameMs: 480,
    draw: (c, t) => drawMonitor(c, 12, 16, { on: true, tint: TINT, flicker: 1, t }),
  },
  {
    name: 'mon-dim',
    w: 24,
    h: 18,
    draw: (c) => drawMonitor(c, 12, 16, { on: true, tint: TINT, flicker: 0.15, t: 0 }),
  },
  {
    name: 'mon-off',
    w: 24,
    h: 18,
    draw: (c) => drawMonitor(c, 12, 16, { on: false, tint: TINT, flicker: 0, t: 0 }),
  },
  {
    name: 'mon-sml',
    w: 17,
    h: 14,
    draw: (c) => drawMonitor(c, 8, 12, { on: true, tint: TINT, flicker: 1, t: 0, small: true }),
  },

  // --- what is on the screen. All seven, on the same floor line, so they can be told apart.
  { name: 'sc-code', w: 24, h: 18, draw: (c) => screenDemo(c, 'code', 'work', 0) },
  {
    name: 'sc-log',
    w: 24,
    h: 18,
    frames: 6,
    frameMs: 150,
    draw: (c, t) => screenDemo(c, 'log', 'work', t),
  },
  { name: 'sc-page', w: 24, h: 18, draw: (c) => screenDemo(c, 'page', 'work', 0) },
  { name: 'sc-find', w: 24, h: 18, draw: (c) => screenDemo(c, 'search', 'work', 0) },
  { name: 'sc-link', w: 24, h: 18, draw: (c) => screenDemo(c, 'link', 'work', 0) },
  {
    name: 'sc-wait',
    w: 24,
    h: 18,
    frames: 3,
    frameMs: 340,
    draw: (c, t) => screenDemo(c, 'wait', 'wait', t),
  },
  { name: 'sc-blank', w: 24, h: 18, draw: (c) => screenDemo(c, 'blank', 'done', 0) },
  {
    name: 'sc-sml-lg',
    w: 17,
    h: 14,
    frames: 4,
    frameMs: 150,
    draw: (c, t) =>
      drawMonitor(c, 8, 12, { on: true, tint: TINT, flicker: 1, t, small: true, screen: 'log' }),
  },
  {
    name: 'sc-sml-lk',
    w: 17,
    h: 14,
    draw: (c) =>
      drawMonitor(c, 8, 12, { on: true, tint: TINT, flicker: 1, t: 0, small: true, screen: 'link' }),
  },

  // --- how it is going. Same content in all four, so the only variable is the mood.
  { name: 'md-work', w: 24, h: 18, draw: (c) => screenDemo(c, 'code', 'work', 0) },
  { name: 'md-wait', w: 24, h: 18, draw: (c) => screenDemo(c, 'code', 'wait', 0) },
  { name: 'md-err', w: 24, h: 18, draw: (c) => screenDemo(c, 'code', 'error', 0) },
  { name: 'md-done', w: 24, h: 18, draw: (c) => screenDemo(c, 'code', 'done', 0) },
  { name: 'md-err-lg', w: 24, h: 18, draw: (c) => screenDemo(c, 'log', 'error', 0) },

  { name: 'table', w: 62, h: 30, draw: (c) => drawRoundtable(c, 31, 28) },
  { name: 'tch-bk', w: 16, h: 19, draw: (c) => drawTableChair(c, 8, 17, 'back') },
  { name: 'tch-fr', w: 16, h: 19, draw: (c) => drawTableChair(c, 8, 17, 'front') },
  { name: 'tch-sd', w: 16, h: 19, draw: (c) => drawTableChair(c, 8, 17, 'side') },

  { name: 'cab-file', w: 28, h: 23, draw: (c) => drawCabinet(c, 14, 21, 0) },
  { name: 'cab-cred', w: 28, h: 23, draw: (c) => drawCabinet(c, 14, 21, 1) },
  { name: 'cab-open', w: 28, h: 23, draw: (c) => drawCabinet(c, 14, 21, 2) },

  { name: 'shelf', w: 36, h: 18, bg: PAL.wal, draw: (c) => drawShelf(c, 18, 16) },

  // --- the break corner, on one floor line so the three of them can be compared as a group.
  { name: 'lounge', w: 26, h: 20, draw: (c) => drawLoungeTable(c, 13, 18) },
  { name: 'couch', w: 38, h: 22, draw: (c) => drawCouch(c, 19, 20) },
  { name: 'ash', w: 13, h: 18, draw: (c) => drawAshStand(c, 6, 16) },
  // The lounge table with a stool at it, so the seat height can be read against the top.
  {
    name: 'lounge-set',
    w: 40,
    h: 20,
    draw: (c) => {
      drawStool(c, 6, 18, 'side');
      drawLoungeTable(c, 19, 18);
      drawStool(c, 33, 18, 'front');
    },
  },

  { name: 'counter48', w: 52, h: 27, draw: (c) => drawCounter(c, 26, 25, 48) },
  { name: 'counter80', w: 84, h: 27, draw: (c) => drawCounter(c, 42, 25, 80) },
  { name: 'fridge', w: 26, h: 45, draw: (c) => drawFridge(c, 13, 43) },
];
