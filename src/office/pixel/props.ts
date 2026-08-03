/**
 * The clutter, the bubbles and the labels.
 *
 * Two very different jobs live in one module because they share one rule: everything here is small,
 * and everything here has to read instantly. A desk with nothing on it looks like a render of a
 * desk; a desk with a mug, a keyboard and a leaning stack of paper looks like somebody's desk. And
 * the bubbles carry every word the room ever says, so they matter more than all the clutter put
 * together — a mug that reads as a blob is a shame, a caption that reads as mush is a broken app.
 *
 * Three things are non-negotiable in here:
 *
 *  - **Two faces and a silhouette.** Every solid object gets a lighter top face, a darker front
 *    face, and a 1px `out` edge down its sides and along its bottom. A single-tone blob is the most
 *    common way to make a pixel prop look like a typo.
 *  - **The box never resizes while it fills.** `speechBubble` measures the *whole* string and then
 *    reveals characters into a box of that fixed size. Measuring the revealed prefix instead makes
 *    every bubble in the room grow a pixel at a time, and the whole scene jitters.
 *  - **Animation is a pure function of `t` / `age`.** No `Math.random`, no `Date.now`. The
 *    simulation is replayable and the air in the room has to be replayable with it.
 *
 * Anchors follow the contract: `(ctx, cx, yBase, …)`, `cx` the horizontal centre and `yBase` the
 * bottom row the object occupies. `drawHangingPlant` is the single exception — a plant on a ceiling
 * hook is defined by where it is nailed up, not by where its longest vine happens to end.
 */
import { drawArt, drawText, FONT_HEIGHT, PAL, PIX, pool, rect, textWidth, type Art } from './art';
import type { PreviewItem } from './preview';

// --------------------------------------------------------------------------- shared helpers

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);
const clamp11 = (v: number): number => (v < -1 ? -1 : v > 1 ? 1 : v);

/** A contact shadow, drawn before the object so the object's own base sits on top of it. */
function contact(ctx: CanvasRenderingContext2D, cx: number, yBase: number, w: number): void {
  pool(ctx, cx, yBase, Math.round(w * 0.55), 2, PAL.shd, 0.45, 3);
}

/** The 1px `out` edge down the sides and along the bottom that every standing object carries. */
function silhouette(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
): void {
  rect(ctx, x, y, 1, h, PAL.out);
  rect(ctx, x + w - 1, y, 1, h, PAL.out);
  rect(ctx, x, y + h - 1, w, 1, PAL.out);
}

/** The same, closed at the top — for anything whose top face is not the light source's problem. */
function ring(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number): void {
  silhouette(ctx, x, y, w, h);
  rect(ctx, x, y, w, 1, PAL.out);
}

/**
 * A small box seen from slightly above.
 *
 * `topH` rows of the lit top face, one lit seam row, and the rest as the darker front — the
 * cheapest possible statement of "this object has a top and a front", which is the whole 2.5D
 * illusion at this size.
 */
function block(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  topH: number,
  top: string,
  front: string,
  lit: string,
  shade: string,
): void {
  rect(ctx, x, y, w, h, front);
  rect(ctx, x, y, w, topH, top);
  if (h > topH) rect(ctx, x, y + topH, w, 1, lit);
  if (w > 4) rect(ctx, x + w - 3, y + topH + 1, 2, h - topH - 2, shade);
  ring(ctx, x, y, w, h);
}

/**
 * A hard-edged filled disc. Circles at this size are four or five stepped runs, and stepping them
 * by hand per radius is how a "round" bubble ends up a different shape at every size.
 */
function disc(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number, color: string): void {
  const rr = Math.max(0, Math.round(r));
  for (let dy = -rr; dy <= rr; dy++) {
    const half = Math.round(Math.sqrt(Math.max(0, rr * rr - dy * dy)));
    rect(ctx, cx - half, cy + dy, half * 2 + 1, 1, color);
  }
}

/** A run on one row: `[dx from the shape's left, width]`. */
type Span = readonly [number, number];

/**
 * The three circles a thought trail is allowed to use: the fill rows, and the ring around them.
 *
 * Both are written out by hand, and the ring is written out *separately* — which is the whole
 * point. The two-pass "grow every row by a pixel" trick that outlines the plants and the cloud
 * gives the union of a set of grown rectangles, and the union of the grown rows of a circle is a
 * rounded square: that is exactly why the trailing puffs on the thought bubble have never read as
 * round. At three pixels the failure is worse still — a 1,3,1 diamond grown by a pixel is a plus
 * sign, so the fill there is a solid 3x3 and the ring's corners are simply left out.
 *
 * `edge` starts one row *above* the fill, so `edge[0]` is row −1.
 */
const PUFFS: Record<3 | 4 | 5, { edge: readonly (readonly Span[])[]; fill: readonly Span[] }> = {
  3: {
    edge: [[[0, 3]], [[-1, 1], [3, 1]], [[-1, 1], [3, 1]], [[-1, 1], [3, 1]], [[0, 3]]],
    fill: [
      [0, 3],
      [0, 3],
      [0, 3],
    ],
  },
  4: {
    edge: [
      [[1, 2]],
      [[0, 1], [3, 1]],
      [[-1, 1], [4, 1]],
      [[-1, 1], [4, 1]],
      [[0, 1], [3, 1]],
      [[1, 2]],
    ],
    fill: [
      [1, 2],
      [0, 4],
      [0, 4],
      [1, 2],
    ],
  },
  5: {
    edge: [
      [[1, 3]],
      [[0, 1], [4, 1]],
      [[-1, 1], [5, 1]],
      [[-1, 1], [5, 1]],
      [[-1, 1], [5, 1]],
      [[0, 1], [4, 1]],
      [[1, 3]],
    ],
    fill: [
      [1, 3],
      [0, 5],
      [0, 5],
      [0, 5],
      [1, 3],
    ],
  },
};

/** One circular puff: the ring, then the paper inside it. `x, y` is the fill's top-left. */
function puff(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  d: 3 | 4 | 5,
  color: string,
): void {
  const art = PUFFS[d];
  for (let r = 0; r < art.edge.length; r++) {
    for (const [dx, w] of art.edge[r]) rect(ctx, x + dx, y + r - 1, w, 1, PAL.out);
  }
  for (let r = 0; r < art.fill.length; r++) {
    const [dx, w] = art.fill[r];
    rect(ctx, x + dx, y + r, w, 1, color);
  }
}

/**
 * Draws a set of rectangles as one silhouetted mass: every rect grown by a pixel in `out` first,
 * then every rect in its own colour.
 *
 * Outlining each rectangle individually would draw internal edges wherever two of them overlap,
 * which is exactly the "scattered pixels" failure that makes foliage look like static. Two passes
 * over the same list gives an outline around the *union* and nothing inside it, for free.
 */
type Mass = { x: number; y: number; w: number; h: number; c: string; lit?: string };

function massed(ctx: CanvasRenderingContext2D, parts: readonly Mass[], alpha = 1): void {
  for (const p of parts) rect(ctx, p.x - 1, p.y - 1, p.w + 2, p.h + 2, PAL.out, alpha);
  for (const p of parts) {
    rect(ctx, p.x, p.y, p.w, p.h, p.c, alpha);
    if (p.lit) rect(ctx, p.x, p.y, p.w, 1, p.lit, alpha);
  }
}

// --------------------------------------------------------------------------- mug

/**
 * A mug. Six pixels of body and a two-pixel handle, which is the smallest thing in the room that
 * still has to be recognisable — the handle is the entire silhouette cue, so it never gets dropped.
 */
const MUG_ROWS = [
  '.oooo...',
  'oRLLRo..',
  'oPPPPooo',
  'oPPPQo.o',
  'oPPPQooo',
  '.oooo...',
] as const;

const MUG_BASE = { o: 'out', R: 'wht', P: 'pap', Q: 'pa2' } as const;
const MUG_HOT: Art = { rows: MUG_ROWS, map: { ...MUG_BASE, L: 'wdd' } };
const MUG_COLD: Art = { rows: MUG_ROWS, map: { ...MUG_BASE, L: 'pa2' } };

export function drawMug(
  ctx: CanvasRenderingContext2D,
  cx: number,
  yBase: number,
  hot: boolean,
): void {
  // The body is cols 0…5 of an 8-wide sprite; the handle hangs off the right and does not count
  // toward the centre, or a row of mugs would read as visibly misaligned.
  drawArt(ctx, hot ? MUG_HOT : MUG_COLD, Math.round(cx - 3), yBase - 5);
}

// --------------------------------------------------------------------------- papers

/** Deterministic left/right jitter, so a stack looks handled rather than machined. */
const PAPER_JIT = [0, 1, -1, 1, 0, -1, 1, -1] as const;

/** Tallest a stack is ever drawn, in rows. Past this it starts climbing the monitor behind it. */
const PAPER_MAX_H = 8;

/**
 * A stack of loose sheets. Each sheet shows one row of lit face and one row of near edge, and each
 * sits a row above the last, so the stack reads as a stack of *edges* — which is all you ever
 * actually see of paper on a desk from this angle.
 *
 * `n` is what the desk has spent, and it runs from nothing to about fourteen. The height is
 * deliberately **saturating** rather than linear: paper compresses, and more to the point a linear
 * stack would either be invisible at the low end or through the ceiling at the high end. `n / (n +
 * 6)` gives two rows for one sheet and seven for fourteen, so the difference between a quiet desk
 * and an expensive one is obvious across the room while the difference between eleven and twelve is
 * — correctly — not readable at all. No numbers anywhere: this is a quantity you feel, and the
 * moment it can be counted somebody starts treating it as a budget report.
 *
 * The lean and the widening jitter are the other half of it. A tall stack is *handled* paper, so it
 * drifts two pixels sideways on the way up and its top three sheets sit visibly proud of each
 * other; a short one is square and tidy.
 */
export function drawPapers(
  ctx: CanvasRenderingContext2D,
  cx: number,
  yBase: number,
  n: number,
): void {
  const count = Math.max(0, Math.min(14, Math.round(n)));
  if (count === 0) return;
  const rows = Math.min(PAPER_MAX_H, 1 + Math.round((8 * count) / (count + 6)));
  const lean = count > 8 ? 2 : count > 3 ? 1 : 0;
  const w = 9;
  const base = Math.round(cx - w / 2);
  let topX = base;
  let topY = yBase - 1;

  for (let i = 0; i < rows; i++) {
    const u = rows > 1 ? i / (rows - 1) : 0;
    // The top three sheets get the full jitter, the buried ones are pressed flat under them.
    const loose = i >= rows - 3;
    const x = base + (loose ? PAPER_JIT[i % PAPER_JIT.length] : 0) + Math.round(lean * u);
    const y = yBase - 1 - i;
    rect(ctx, x, y, w, 2, PAL.out);
    rect(ctx, x + 1, y, w - 2, 1, loose ? PAL.pap : PAL.pa2);
    rect(ctx, x + 1, y + 1, w - 2, 1, PAL.pa2);
    topX = x;
    topY = y;
  }

  // Two dashes of writing on the one face that is actually visible.
  rect(ctx, topX + 2, topY, 3, 1, PAL.gry, 0.75);
  rect(ctx, topX + 6, topY, 2, 1, PAL.gry, 0.55);
}

// --------------------------------------------------------------------------- scattered paper

/**
 * A small integer hash. Everything scattered in this module is placed by `(seed, index)` and never
 * by a random number, because two identical sessions have to paint identical rooms — the test suite
 * feeds two Scenes the same ticks and compares the buffers byte for byte.
 */
function hash2(a: number, b: number): number {
  let h = (Math.round(a) * 374761393 + Math.round(b) * 668265263) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return (h ^ (h >>> 16)) >>> 0;
}

/**
 * Four sheets, as `[dx, width]` per row.
 *
 * At four pixels across there is no such thing as rotation — a rotated rectangle is the same
 * rectangle with anti-aliasing you cannot draw. What you *can* vary is which row is the long one
 * and which corner steps in, and four of those read as four sheets lying at four angles.
 */
const SCATTER_SHAPES: readonly (readonly (readonly [number, number])[])[] = [
  [
    [0, 4],
    [0, 5],
    [1, 3],
  ],
  [
    [1, 4],
    [0, 5],
    [0, 4],
  ],
  [
    [0, 5],
    [1, 4],
    [1, 3],
  ],
  [
    [1, 3],
    [0, 4],
    [0, 5],
  ],
];

/** One loose sheet: an outline pass over the union of its rows, then the paper on top of it. */
function loose(ctx: CanvasRenderingContext2D, x: number, y: number, kind: number): void {
  const shape = SCATTER_SHAPES[kind % SCATTER_SHAPES.length];
  for (let r = 0; r < shape.length; r++) {
    const [dx, w] = shape[r];
    rect(ctx, x + dx - 1, y + r - 1, w + 2, 3, PAL.out);
  }
  for (let r = 0; r < shape.length; r++) {
    const [dx, w] = shape[r];
    rect(ctx, x + dx, y + r, w, 1, r === shape.length - 1 ? PAL.pa2 : PAL.pap);
  }
}

/** Scattered sheets on the floor at a desk that keeps failing. `n` 1..6, `seed` places them. */
export function drawScatter(
  ctx: CanvasRenderingContext2D,
  cx: number,
  yBase: number,
  n: number,
  seed: number,
): void {
  const count = Math.max(1, Math.min(6, Math.round(n)));
  const cxi = Math.round(cx);

  const sheets = [];
  for (let i = 0; i < count; i++) {
    const h = hash2(seed, i);
    sheets.push({
      x: cxi - 8 + (h % 15),
      // Sheets stack up-screen from the anchor, which is the nearest one's bottom row.
      // `>>>`, never `>>`: the hash fills all 32 bits, and a signed shift of anything past 2^31
      // comes back negative, which indexes the shape table off the end and draws nothing at all.
      y: yBase - 2 - ((h >>> 5) % 6),
      kind: (h >>> 11) % SCATTER_SHAPES.length,
    });
  }
  // Nearest last, so the sheet closest to the camera overlaps the ones behind it rather than the
  // other way round — paper on a floor is the one prop where the overlap *is* the depth cue.
  sheets.sort((a, b) => a.y - b.y);

  pool(ctx, cx, yBase, 11, 3, PAL.shd, 0.3, 3);
  for (const s of sheets) loose(ctx, s.x, s.y, s.kind);
}

// --------------------------------------------------------------------------- keyboard and mouse

/** Which keys light, in the order they light as `pressed` climbs. Fixed, never random. */
const KEY_LIT = [
  [4, 1],
  [8, 2],
  [2, 2],
  [10, 1],
] as const;

/**
 * A keyboard: a shallow wedge with two rows of keycaps and a spacebar.
 *
 * `pressed` is not a per-key state — the scene has no idea what anyone is typing. It is an
 * intensity, and it lights progressively more caps, which at twelve pixels wide is the only
 * difference between "typing" and "not typing" that survives.
 */
export function drawKeyboard(
  ctx: CanvasRenderingContext2D,
  cx: number,
  yBase: number,
  pressed: number,
): void {
  const w = 13;
  const h = 4;
  const x = Math.round(cx - w / 2);
  const y = yBase - h + 1;

  rect(ctx, x, y, w, h, PAL.me2);
  rect(ctx, x + 1, y, w - 2, 1, PAL.me3); // the top face catches the room light
  for (let r = 0; r < 2; r++) {
    for (let k = 0; k < 5; k++) rect(ctx, x + 2 + k * 2 + r, y + 1 + r, 1, 1, PAL.blk);
  }
  rect(ctx, x + 4, y + 2, 5, 1, PAL.bl2); // spacebar
  silhouette(ctx, x, y, w, h);

  const lit = Math.round(clamp01(pressed) * KEY_LIT.length);
  for (let i = 0; i < lit; i++) {
    const [kx, ky] = KEY_LIT[i];
    rect(ctx, x + kx, y + ky, 1, 1, PAL.scg, 0.9);
  }
}

const MOUSE: Art = {
  rows: ['.ooo.', 'oMWMo', 'oNNNo', '.ooo.'],
  map: { o: 'out', M: 'me3', W: 'blk', N: 'me2' },
};

export function drawMouse(ctx: CanvasRenderingContext2D, cx: number, yBase: number): void {
  drawArt(ctx, MOUSE, Math.round(cx - 2), yBase - 3);
}

// --------------------------------------------------------------------------- desk lamp

/**
 * An architect's lamp: a shade over a bulb, a jointed arm stepping down to a weighted base.
 *
 * The arm is drawn as a stair rather than a straight post because a vertical line at this size
 * reads as a pipe; two jogs read as a hinge.
 */
const LAMP_ROWS = [
  '.ooooo....',
  'oMMMMMo...',
  'oNNNNNo...',
  '.oGGGo....',
  '..ooo.....',
  '...oAo....',
  '...oAo....',
  '....oAo...',
  '....oAo...',
  '.....oAo..',
  '..ooooooo.',
  '.oMMMMMMMo',
  '.ooooooooo',
] as const;

const LAMP_BASE = { o: 'out', M: 'me3', N: 'me2', A: 'met' } as const;
const LAMP_ON: Art = { rows: LAMP_ROWS, map: { ...LAMP_BASE, G: 'lmp' } };
const LAMP_OFF: Art = { rows: LAMP_ROWS, map: { ...LAMP_BASE, G: 'bl2' } };

export function drawDeskLamp(
  ctx: CanvasRenderingContext2D,
  cx: number,
  yBase: number,
  on: boolean,
): void {
  const x = Math.round(cx - 5);
  const y = yBase - 12;
  if (on) {
    // The warm pool goes down *first*, so the lamp's own outline stays crisp on top of it.
    pool(ctx, x + 3, yBase - 1, 13, 5, PAL.lm2, 0.4, 4);
  }
  drawArt(ctx, on ? LAMP_ON : LAMP_OFF, x, y);
  if (on) {
    rect(ctx, x + 2, y + 4, 3, 1, PAL.lmp, 0.7); // the spill under the shade's lip
    rect(ctx, x + 1, y + 1, 5, 1, PAL.wht, 0.25);
  }
}

// --------------------------------------------------------------------------- books

const BOOK_COVERS = [PAL.sc2, PAL.pot, PAL.lf2] as const;
const BOOK_JIT = [0, -1, 1] as const;

/** Three hardbacks lying flat: a coloured cover row and a `pap` block of pages under each. */
export function drawBooks(ctx: CanvasRenderingContext2D, cx: number, yBase: number): void {
  const w = 11;
  const base = Math.round(cx - w / 2);
  for (let i = 0; i < 3; i++) {
    const y = yBase - 1 - i * 2;
    const x = base + BOOK_JIT[i];
    rect(ctx, x, y, w, 2, PAL.out);
    rect(ctx, x + 1, y, w - 2, 1, BOOK_COVERS[i]);
    rect(ctx, x + 1, y + 1, w - 2, 1, PAL.pap);
    rect(ctx, x + 1, y, 3, 1, PAL.wht, 0.2); // a highlight along the spine's near corner
  }
  // A bookmark, because a stack of three identical bricks reads as one brick.
  rect(ctx, base + w - 3, yBase - 5, 1, 3, PAL.err, 0.85);
}

// --------------------------------------------------------------------------- bin

/**
 * A wastebasket: a tapering mesh cylinder with a lit rim and something spilling out of the top.
 *
 * Drawn column-free and row-by-row so the taper is a real taper — a straight-sided box with a wider
 * lid on it is the shape of a bucket, not a bin.
 */
export function drawBin(ctx: CanvasRenderingContext2D, cx: number, yBase: number): void {
  const h = 12;
  const topW = 11;
  const botW = 8;
  contact(ctx, cx, yBase, topW);

  // The crumpled ball riding on top, first, so the rim's outline cuts across it.
  massed(ctx, [
    { x: Math.round(cx) - 1, y: yBase - h - 2, w: 5, h: 3, c: PAL.pap, lit: PAL.wht },
    { x: Math.round(cx) - 4, y: yBase - h - 1, w: 4, h: 2, c: PAL.pa2 },
  ]);

  for (let r = 0; r < h; r++) {
    const w = Math.round(topW - ((topW - botW) * r) / (h - 1));
    const x = Math.round(cx - w / 2);
    const y = yBase - h + 1 + r;
    rect(ctx, x, y, w, 1, r < 2 ? PAL.me3 : PAL.me2);
    if (r >= 2) {
      // Vertical slats. Two-pixel pitch, offset so they never line up with the outline.
      for (let s = 2; s < w - 2; s += 3) rect(ctx, x + s, y, 1, 1, PAL.blk, 0.6);
      rect(ctx, x + w - 3, y, 2, 1, PAL.met, 0.5);
    }
    rect(ctx, x, y, 1, 1, PAL.out);
    rect(ctx, x + w - 1, y, 1, 1, PAL.out);
  }
  rect(ctx, Math.round(cx - botW / 2), yBase, botW, 1, PAL.out);
  rect(ctx, Math.round(cx - topW / 2) + 1, yBase - h + 1, topW - 2, 1, PAL.gry, 0.5);
}

// --------------------------------------------------------------------------- cardboard box

/**
 * A closed archive box. The lid's top face tapers back over four rows, which is what tells the eye
 * it is being seen from above rather than head-on.
 */
export function drawBox(ctx: CanvasRenderingContext2D, cx: number, yBase: number): void {
  const w = 15;
  const h = 13;
  const topH = 4;
  const x0 = Math.round(cx - w / 2);
  const y0 = yBase - h + 1;
  contact(ctx, cx, yBase, w);

  for (let r = 0; r < topH; r++) {
    const inset = Math.round((2 * (topH - 1 - r)) / (topH - 1));
    rect(ctx, x0 + inset, y0 + r, w - inset * 2, 1, r === 0 ? PAL.wdd : PAL.wdt);
    rect(ctx, x0 + inset, y0 + r, 1, 1, PAL.out);
    rect(ctx, x0 + w - inset - 1, y0 + r, 1, 1, PAL.out);
  }
  rect(ctx, x0, y0 + topH, w, h - topH, PAL.wdf);
  rect(ctx, x0, y0 + topH, w, 1, PAL.wdl); // the lit lid/front seam
  rect(ctx, x0 + w - 4, y0 + topH + 1, 3, h - topH - 2, PAL.wdd);
  silhouette(ctx, x0, y0 + topH, w, h - topH);

  rect(ctx, x0 + 7, y0 + 1, 1, h - 2, PAL.pa2, 0.55); // packing tape, over the lid and down
  rect(ctx, x0 + 2, y0 + topH + 3, 6, 4, PAL.pap);
  rect(ctx, x0 + 2, y0 + topH + 6, 6, 1, PAL.pa2);
  rect(ctx, x0 + 3, y0 + topH + 4, 4, 1, PAL.gry, 0.6);
  ring(ctx, x0 + 2, y0 + topH + 3, 6, 4);
}

// --------------------------------------------------------------------------- plants

const LEAF_TONE = [PAL.lf1, PAL.lf2, PAL.lf3] as const;

/** `[dx from cx, dy from the pot's top row, w, h, tone, sway group]`. */
type Frond = readonly [number, number, number, number, 0 | 1 | 2, 0 | 1 | 2];

type PlantSpec = { potW: number; potH: number; fronds: readonly Frond[] };

/**
 * Three plants, and the difference between them is not scale — it is how many masses they have.
 * Scaling one shape up gives you a big version of a small plant; a floor plant needs a lower fan,
 * a mid tier and a crown, which is what makes it read as something that has been growing a while.
 */
const PLANTS: Record<0 | 1 | 2, PlantSpec> = {
  0: {
    potW: 7,
    potH: 5,
    fronds: [
      [-3, -2, 3, 2, 1, 1],
      [0, -2, 3, 2, 0, 1],
      [-2, -4, 4, 3, 2, 2],
    ],
  },
  1: {
    potW: 9,
    potH: 6,
    fronds: [
      [-6, -3, 5, 3, 1, 1],
      [1, -3, 5, 3, 1, 1],
      [-5, -6, 5, 3, 0, 1],
      [0, -6, 5, 3, 0, 1],
      [-3, -8, 6, 3, 2, 2],
      [-1, -10, 3, 3, 0, 2],
    ],
  },
  2: {
    potW: 13,
    potH: 8,
    fronds: [
      [-8, -4, 6, 4, 1, 1],
      [2, -4, 6, 4, 1, 1],
      [-7, -8, 6, 4, 0, 1],
      [1, -8, 6, 4, 0, 1],
      [-4, -10, 8, 4, 2, 2],
      [-6, -12, 5, 3, 0, 2],
      [1, -12, 5, 3, 0, 2],
      [-2, -14, 4, 3, 2, 2],
    ],
  },
};

/** A terracotta pot: a two-row rim over a tapering body, with soil showing above the rim. */
function terracotta(
  ctx: CanvasRenderingContext2D,
  cx: number,
  yBase: number,
  w: number,
  h: number,
): void {
  const bot = Math.max(4, w - 4);
  const top = yBase - h + 1;
  for (let r = 0; r < h; r++) {
    const ww = r < 2 ? w : Math.round(w - ((w - bot) * (r - 1)) / (h - 2));
    const x = Math.round(cx - ww / 2);
    const y = top + r;
    rect(ctx, x, y, ww, 1, r === 0 ? PAL.pot : PAL.po2);
    if (r >= 2) {
      rect(ctx, x, y, ww, 1, PAL.pot);
      rect(ctx, x + ww - 3, y, 2, 1, PAL.po2);
    }
    rect(ctx, x, y, 1, 1, PAL.out);
    rect(ctx, x + ww - 1, y, 1, 1, PAL.out);
  }
  rect(ctx, Math.round(cx - bot / 2), yBase, bot, 1, PAL.out);
  rect(ctx, Math.round(cx - w / 2) + 1, top, w - 2, 1, PAL.wdd); // soil
  rect(ctx, Math.round(cx - w / 2) + 1, top + 1, w - 2, 1, PAL.pot);
}

/**
 * A potted plant. `sway` (−1…1) shifts whole leaf masses by one or two pixels depending on how
 * high up the plant they sit — the crown moves two, the lower fan moves one, and the pot never
 * moves at all. Shifting individual pixels instead produces a shimmer that reads as noise.
 */
export function drawPlant(
  ctx: CanvasRenderingContext2D,
  cx: number,
  yBase: number,
  size: 0 | 1 | 2,
  sway: number,
): void {
  const spec = PLANTS[size] ?? PLANTS[0];
  const s = clamp11(sway);
  if (size > 0) contact(ctx, cx, yBase, spec.potW + 2);
  terracotta(ctx, cx, yBase, spec.potW, spec.potH);

  const potTop = yBase - spec.potH + 1;
  const parts: Mass[] = spec.fronds.map(([dx, dy, w, h, tone, g]) => ({
    x: Math.round(cx + dx + s * g),
    y: potTop + dy,
    w,
    h,
    c: LEAF_TONE[tone],
    lit: tone === 1 ? undefined : PAL.lf3,
  }));
  massed(ctx, parts);
  // One stem tying the crown back to the pot, or a big plant reads as leaves floating over a pot.
  if (size === 2) rect(ctx, Math.round(cx + s), potTop - 5, 1, 5, PAL.lf2);
}

/**
 * A plant hanging from the ceiling. The one function in the module anchored by its **top row** —
 * a ceiling hook is fixed where it is screwed in, and its vines get longer as it grows.
 */
export function drawHangingPlant(
  ctx: CanvasRenderingContext2D,
  cx: number,
  yTop: number,
  sway: number,
): void {
  const s = clamp11(sway);
  const cxi = Math.round(cx);
  // The pot hangs low enough that the cords stay visible above the foliage. Tucking it up under the
  // crown saves three pixels and costs the one detail that says "hanging" rather than "floating".
  const potTop = yTop + 10;
  const potH = 6;
  const potBot = potTop + potH - 1;

  // Hook and the two cords, splaying out to the pot's rim.
  rect(ctx, cxi - 1, yTop, 3, 1, PAL.out);
  rect(ctx, cxi, yTop + 1, 1, 1, PAL.out);
  for (let r = 2; r < 10; r++) {
    const u = (r - 1) / 8;
    rect(ctx, cxi - Math.round(5 * u), yTop + r, 1, 1, PAL.out);
    rect(ctx, cxi + Math.round(5 * u), yTop + r, 1, 1, PAL.out);
  }

  // The pot hangs mouth-up, so it is widest at the top — the opposite taper to a floor pot.
  for (let r = 0; r < potH; r++) {
    const w = 12 - Math.round((r * 4) / (potH - 1));
    const x = Math.round(cx - w / 2);
    const y = potTop + r;
    rect(ctx, x, y, w, 1, r === 0 ? PAL.po2 : PAL.pot);
    if (r > 1) rect(ctx, x + w - 3, y, 2, 1, PAL.po2);
    rect(ctx, x, y, 1, 1, PAL.out);
    rect(ctx, x + w - 1, y, 1, 1, PAL.out);
  }
  rect(ctx, cxi - 4, potBot + 1, 8, 1, PAL.out);

  // The crown spilling over the rim, then the vines.
  massed(ctx, [
    { x: cxi - 7 + Math.round(s), y: potTop - 3, w: 6, h: 3, c: PAL.lf2 },
    { x: cxi + 1 + Math.round(s), y: potTop - 3, w: 6, h: 3, c: PAL.lf1, lit: PAL.lf3 },
    { x: cxi - 3 + Math.round(s * 2), y: potTop - 4, w: 6, h: 3, c: PAL.lf1, lit: PAL.lf3 },
  ]);

  const vines = [
    { dx: -4, len: 11 },
    { dx: 0, len: 15 },
    { dx: 4, len: 8 },
  ] as const;
  const leaves: Mass[] = [];
  const stem: { x: number; y: number }[] = [];
  for (const v of vines) {
    for (let r = 0; r < v.len; r++) {
      const drift = Math.round((s * 2 * (r + 1)) / v.len);
      const x = cxi + v.dx + drift;
      const y = potBot + 2 + r;
      stem.push({ x, y });
      if (r % 3 === 2) {
        const side = (((r / 3) | 0) + (v.dx > 0 ? 1 : 0)) % 2 === 0 ? -3 : 1;
        leaves.push({ x: x + side, y: y - 1, w: 3, h: 2, c: r % 2 ? PAL.lf1 : PAL.lf2, lit: PAL.lf3 });
      }
    }
  }
  massed(ctx, leaves);
  for (const p of stem) rect(ctx, p.x, p.y, 1, 1, PAL.lf2);
}

// --------------------------------------------------------------------------- coffee machine

const COFFEE_ROWS = [
  '.ooooooooooo.',
  'oMMMMMMMMMMMo',
  'oNNNNNNNNNNNo',
  'oKKKKKKKKKKKo',
  'oKoooooooKKKo',
  'oKoSSSSSoKPKo',
  'oKoSSSSSoKKKo',
  'oKoooooooKKKo',
  'oKKKKKKKKKKKo',
  'oKoooooooKKKo',
  'oKoNNNNNoKKKo',
  'oKoooDoooKKKo',
  'oKoddddd oKKo',
  'oKoddddd oKKo',
  'oKoddddd oKKo',
  'oKoWWWWWoKKKo',
  'oKoowwwooKKKo',
  'oKKKKKKKKKKKo',
  'oNNNNNNNNNNNo',
  'ooooooooooooo',
] as const;

const COFFEE: Art = {
  rows: COFFEE_ROWS,
  map: {
    o: 'out',
    M: 'me3',
    N: 'me2',
    K: 'bl2',
    S: 'scr',
    P: 'me2',
    D: 'blk',
    d: 'shd',
    W: 'wht',
    w: 'pa2',
  },
};

/**
 * The espresso machine in the kitchen corner. Dark body, a brew group over a recess, a cup under
 * the spout, and — when it is on — a lit readout, a warm standby light and a drip that actually
 * falls, stepped in whole pixels so it never shimmers.
 */
export function drawCoffeeMachine(
  ctx: CanvasRenderingContext2D,
  cx: number,
  yBase: number,
  on: boolean,
  t: number,
): void {
  const x0 = Math.round(cx - 6);
  const y0 = yBase - 19;
  contact(ctx, cx, yBase, 13);
  drawArt(ctx, COFFEE, x0, y0);

  if (!on) return;
  rect(ctx, x0 + 3, y0 + 5, 5, 1, PAL.sc3, 0.9);
  rect(ctx, x0 + 3, y0 + 6, 3, 1, PAL.sc2, 0.9);
  rect(ctx, x0 + 10, y0 + 5, 1, 1, PAL.lm2);
  rect(ctx, x0 + 10, y0 + 5, 1, 1, PAL.lmp, 0.6);
  // One drip per ~540ms, falling three rows into the cup.
  const phase = Math.floor(t / 180) % 3;
  rect(ctx, x0 + 6, y0 + 12 + phase, 1, 1, PAL.wdd);
}

// --------------------------------------------------------------------------- printer

/**
 * The shared printer. A lid with a stack of blank stock standing up behind it, and an output slot
 * along the front that a sheet feeds out of as `busy` climbs — the sheet grows downward and toward
 * the camera, so a printer mid-job is legible from across the room.
 */
export function drawPrinter(
  ctx: CanvasRenderingContext2D,
  cx: number,
  yBase: number,
  busy: number,
): void {
  const w = 21;
  const h = 13;
  const x0 = Math.round(cx - w / 2);
  const y0 = yBase - h + 1;
  contact(ctx, cx, yBase, w);

  // Blank stock in the rear tray, leaning back behind the body.
  rect(ctx, x0 + 5, y0 - 4, 11, 4, PAL.pap);
  rect(ctx, x0 + 5, y0 - 4, 11, 1, PAL.wht);
  ring(ctx, x0 + 5, y0 - 4, 11, 4);
  rect(ctx, x0 + 4, y0 - 1, 13, 1, PAL.me2);
  rect(ctx, x0 + 4, y0 - 1, 13, 1, PAL.out, 0.5);

  block(ctx, x0, y0, w, h, 4, PAL.me3, PAL.met, PAL.gry, PAL.me2);
  rect(ctx, x0 + 2, y0 + 1, w - 4, 1, PAL.wht, 0.18); // the lid's near highlight
  rect(ctx, x0 + 2, y0 + 6, w - 4, 1, PAL.out); // output slot
  rect(ctx, x0 + 2, y0 + 7, w - 4, 1, PAL.me2);
  rect(ctx, x0 + w - 6, y0 + 3, 2, 1, PAL.lm2, 0.9); // ready light
  rect(ctx, x0 + 3, y0 + 9, 5, 1, PAL.blk); // control strip
  rect(ctx, x0 + 3, y0 + 10, 5, 1, PAL.bl2);

  const fed = Math.round(clamp01(busy) * 5);
  if (fed > 0) {
    const sx = x0 + 4;
    const sw = w - 8;
    rect(ctx, sx, y0 + 7, sw, fed, PAL.pap);
    rect(ctx, sx, y0 + 6 + fed, sw, 1, PAL.pa2);
    silhouette(ctx, sx, y0 + 7, sw, fed);
    if (fed > 2) rect(ctx, sx + 2, y0 + 9, sw - 6, 1, PAL.gry, 0.55);
  }
}

// --------------------------------------------------------------------------- water cooler

/**
 * The water cooler: a big inverted bottle over a white cabinet with two taps and a drip tray.
 *
 * The bottle is the landmark — it is the one blue mass in the room that is not a screen, so it gets
 * a bright highlight column down its left side and a dark one down its right, which is how a
 * cylinder is drawn when gradients are not available.
 */
export function drawWaterCooler(ctx: CanvasRenderingContext2D, cx: number, yBase: number): void {
  const cxi = Math.round(cx);
  const bodyW = 14;
  const bodyH = 17;
  const bodyTop = yBase - bodyH + 1;
  contact(ctx, cx, yBase, bodyW + 2);

  // Bottle: a 12-wide barrel with a shouldered neck.
  const botH = 12;
  const botTop = bodyTop - botH - 2;
  for (let r = 0; r < botH; r++) {
    const w = r < 1 ? 6 : r < 2 ? 8 : r > botH - 3 ? 10 : 12;
    const x = Math.round(cx - w / 2);
    const y = botTop + r;
    rect(ctx, x, y, w, 1, PAL.sc2);
    rect(ctx, x + 1, y, 2, 1, PAL.sc3); // the lit side
    rect(ctx, x + w - 3, y, 2, 1, PAL.scr); // the side that turns away
    rect(ctx, x, y, 1, 1, PAL.out);
    rect(ctx, x + w - 1, y, 1, 1, PAL.out);
  }
  rect(ctx, cxi - 3, botTop, 6, 1, PAL.out);
  rect(ctx, cxi - 5, botTop + botH, 10, 1, PAL.me2);
  ring(ctx, cxi - 5, botTop + botH, 10, 2);
  rect(ctx, cxi - 4, botTop + botH + 1, 8, 1, PAL.me3);

  // Cabinet.
  block(ctx, cxi - bodyW / 2, bodyTop, bodyW, bodyH, 3, PAL.wht, PAL.gry, PAL.wht, PAL.me2);
  rect(ctx, cxi - bodyW / 2 + 1, bodyTop + 4, bodyW - 2, 1, PAL.me2, 0.4);

  // Two taps and their levers, then the grille tray under them.
  for (const [dx, c] of [
    [-4, PAL.sc2],
    [1, PAL.pot],
  ] as const) {
    rect(ctx, cxi + dx, bodyTop + 6, 3, 2, PAL.blk);
    rect(ctx, cxi + dx, bodyTop + 6, 3, 1, c);
    rect(ctx, cxi + dx + 1, bodyTop + 8, 1, 2, PAL.me3);
    rect(ctx, cxi + dx + 1, bodyTop + 10, 1, 1, PAL.out);
  }
  rect(ctx, cxi - 5, bodyTop + 12, 10, 2, PAL.me2);
  for (let i = 0; i < 5; i++) rect(ctx, cxi - 4 + i * 2, bodyTop + 12, 1, 2, PAL.blk, 0.7);
  ring(ctx, cxi - 5, bodyTop + 12, 10, 2);
  rect(ctx, cxi - bodyW / 2 + 1, yBase - 1, bodyW - 2, 2, PAL.blk);
  rect(ctx, cxi - bodyW / 2 + 1, yBase, bodyW - 2, 1, PAL.out);
}

// --------------------------------------------------------------------------- coat rack

/**
 * The coat rack by the door: a weighted foot, a post, four pegs, and exactly one coat and one
 * scarf. Loading it up with five coats turns a silhouette into a lump.
 */
export function drawCoatRack(ctx: CanvasRenderingContext2D, cx: number, yBase: number): void {
  const cxi = Math.round(cx);
  const h = 34;
  const top = yBase - h + 1;
  contact(ctx, cx, yBase, 13);

  // Foot: a stepped ellipse, so it reads as three splayed legs rather than a puck.
  for (let r = 0; r < 3; r++) {
    const w = 13 - r * 3;
    rect(ctx, cxi - Math.floor(w / 2), yBase - 2 + r, w, 1, r === 0 ? PAL.me3 : PAL.me2);
    rect(ctx, cxi - Math.floor(w / 2), yBase - 2 + r, 1, 1, PAL.out);
    rect(ctx, cxi + Math.ceil(w / 2) - 1, yBase - 2 + r, 1, 1, PAL.out);
  }
  rect(ctx, cxi - 4, yBase, 9, 1, PAL.out);

  // Post.
  rect(ctx, cxi - 1, top + 2, 3, h - 4, PAL.me2);
  rect(ctx, cxi - 1, top + 2, 1, h - 4, PAL.me3);
  rect(ctx, cxi + 1, top + 2, 1, h - 4, PAL.out);

  // Pegs: two long, two short, stepped up so the head is a cross and not a blob.
  for (const [dx, dy, len] of [
    [-1, 2, -4],
    [1, 2, 4],
    [-1, 5, -3],
    [1, 5, 3],
  ] as const) {
    const x = len < 0 ? cxi + dx + len : cxi + dx + 1;
    rect(ctx, x, top + dy, Math.abs(len), 1, PAL.met);
    rect(ctx, x, top + dy + 1, Math.abs(len), 1, PAL.out);
    rect(ctx, len < 0 ? x : x + Math.abs(len) - 1, top + dy, 1, 2, PAL.out);
  }
  rect(ctx, cxi - 1, top, 3, 2, PAL.me3);
  rect(ctx, cxi - 1, top, 3, 1, PAL.out);

  // The coat: shoulders, body, and a hem that flares one pixel.
  massed(ctx, [
    { x: cxi - 6, y: top + 6, w: 7, h: 3, c: PAL.sc2, lit: PAL.sc3 },
    { x: cxi - 7, y: top + 9, w: 8, h: 9, c: PAL.sc2 },
    { x: cxi - 8, y: top + 14, w: 9, h: 4, c: PAL.scr },
  ]);
  rect(ctx, cxi - 4, top + 9, 1, 8, PAL.scr, 0.8); // the button placket

  // The scarf, on the other side so the rack is not symmetric.
  massed(ctx, [
    { x: cxi + 2, y: top + 6, w: 4, h: 3, c: PAL.pot, lit: PAL.wdl },
    { x: cxi + 3, y: top + 9, w: 3, h: 6, c: PAL.po2 },
  ]);
}

// --------------------------------------------------------------------------- cable

/**
 * A slack cable between two points, drawn as a stepped catenary.
 *
 * Sampled per column and filled vertically between samples: a cable plotted as isolated pixels
 * breaks into a dotted line wherever it drops faster than one row per column, which is exactly
 * where a real cable looks most like a cable.
 */
export function drawCable(
  ctx: CanvasRenderingContext2D,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
): void {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const steps = Math.max(1, Math.round(Math.max(Math.abs(dx), Math.abs(dy))));
  const sag = Math.max(2, Math.round(Math.abs(dx) * 0.26));
  let prevX = Math.round(x0);
  let prevY = Math.round(y0);

  for (let i = 0; i <= steps; i++) {
    const u = i / steps;
    const x = Math.round(x0 + dx * u);
    const y = Math.round(y0 + dy * u + sag * 4 * u * (1 - u));
    const a = Math.min(prevY, y);
    const b = Math.max(prevY, y);
    rect(ctx, x, a, 1, b - a + 1, PAL.out);
    // A sheen along the lowest stretch, where a real cable catches the room light.
    if (i % 5 === 0 && u > 0.25 && u < 0.75) rect(ctx, x, y, 1, 1, PAL.ou2);
    prevX = x;
    prevY = y;
  }
  rect(ctx, prevX, prevY, 1, 1, PAL.out);
}

// --------------------------------------------------------------------------- spawn edge

/** How much of the edge's life is spent drawing in, and how much fading out. */
const LINK_IN = 0.25;
const LINK_OUT = 0.28;
/** Every third pixel of the walk is lit. Two is a line, four is a row of unrelated dots. */
const LINK_PITCH = 3;

/**
 * A parent→child line: dotted, with a small label near its midpoint.
 * `age` is 0..1 over the edge's life — the line draws in from the parent end and fades out.
 *
 * The walk is a Bresenham-ish march in whole pixels, and it has to be: a diagonal plotted at
 * fractional positions and rounded per-frame crawls sideways as the endpoints move, and a dotted
 * line that crawls looks like a rendering bug rather than like an arrow. Each dot also drops a
 * shadow pixel underneath it, because the line's whole job is to be legible over a plank floor and
 * over furniture at the same time, and a bare 1px dot in an agent's tint is neither.
 *
 * The label rides a 1px-padded `out` plate for the same reason. The arrowhead is a chevron at the
 * child end, and it only appears once the line has finished arriving — an arrow pointing at
 * somewhere it has not reached yet reads as a glitch.
 */
export function drawLink(
  ctx: CanvasRenderingContext2D,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  label: string,
  age: number,
  color: string,
): void {
  const u = clamp01(age);
  const alpha = u > 1 - LINK_OUT ? clamp01((1 - u) / LINK_OUT) : 1;
  if (alpha <= 0) return;
  const grow = clamp01(u / LINK_IN);

  const ax = Math.round(x0);
  const ay = Math.round(y0);
  const bx = Math.round(x1);
  const by = Math.round(y1);
  const dx = bx - ax;
  const dy = by - ay;
  const steps = Math.max(Math.abs(dx), Math.abs(dy), 1);
  const lit = Math.round(steps * grow);

  for (let i = 0; i <= lit; i += LINK_PITCH) {
    const x = ax + Math.round((dx * i) / steps);
    const y = ay + Math.round((dy * i) / steps);
    rect(ctx, x, y + 1, 1, 1, PAL.out, alpha * 0.55);
    rect(ctx, x, y, 1, 1, color, alpha);
  }

  if (grow >= 1) {
    // A chevron, not a filled triangle: five single pixels stay a pointer at this size, where a
    // solid head turns into a blob the moment the line is not axis-aligned.
    const horiz = Math.abs(dx) >= Math.abs(dy);
    const sx = horiz ? (dx >= 0 ? 1 : -1) : 0;
    const sy = horiz ? 0 : dy >= 0 ? 1 : -1;
    const px = horiz ? 0 : 1;
    const py = horiz ? 1 : 0;
    rect(ctx, bx, by, 1, 1, color, alpha);
    for (let k = 1; k <= 2; k++) {
      rect(ctx, bx - sx * k + px * k, by - sy * k + py * k, 1, 1, color, alpha);
      rect(ctx, bx - sx * k - px * k, by - sy * k - py * k, 1, 1, color, alpha);
    }
  }

  if (label === '' || grow < 0.5) return;
  const tw = textWidth(label);
  const plateW = tw + 2;
  const plateH = FONT_HEIGHT + 2;
  // Above the midpoint rather than on it, so the plate never sits on the dots it is labelling.
  const lx = clampX(Math.round((ax + bx) / 2) - plateW / 2, plateW);
  const ly = Math.round((ay + by) / 2) - plateH - 2;
  rect(ctx, lx, ly, plateW, plateH, PAL.out, alpha);
  drawText(ctx, label, lx + 1, ly + 1, color, alpha);
}

// --------------------------------------------------------------------------- bubbles

const PAD_X = 3;
const PAD_Y = 3;
/** One text row plus the two-pixel leading that keeps two lines from touching. */
const LINE_H = FONT_HEIGHT + 2;
/** Past this a bubble stops being a caption and starts being a wall of text. */
const MAX_LINES = 6;

/**
 * Wraps `text` to `maxW` and reports the box it needs.
 *
 * Exported because `speechBubble` has to measure the **full** string and then reveal into a box of
 * that size — measuring the revealed prefix instead is what makes a typewriter bubble grow a pixel
 * per character and shake the entire room while anyone is talking.
 */
export function measureBubble(
  text: string,
  maxW: number,
): { w: number; h: number; lines: string[] } {
  const inner = Math.max(12, Math.round(maxW) - PAD_X * 2 - 2);
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let cur = '';

  const flushLong = (): void => {
    // A single unbreakable token wider than the box gets cut, rather than overflowing the border.
    while (textWidth(cur) > inner && cur.length > 1) {
      let cut = cur.length;
      while (cut > 1 && textWidth(cur.slice(0, cut)) > inner) cut -= 1;
      lines.push(cur.slice(0, cut));
      cur = cur.slice(cut);
    }
  };

  for (const word of words) {
    const next = cur === '' ? word : `${cur} ${word}`;
    if (cur !== '' && textWidth(next) > inner) {
      lines.push(cur);
      cur = word;
    } else {
      cur = next;
    }
    flushLong();
  }
  if (cur !== '' || lines.length === 0) lines.push(cur);

  if (lines.length > MAX_LINES) {
    lines.length = MAX_LINES;
    let last = lines[MAX_LINES - 1];
    while (last.length > 1 && textWidth(`${last}...`) > inner) last = last.slice(0, -1);
    lines[MAX_LINES - 1] = `${last}...`;
  }

  const widest = lines.reduce((m, l) => Math.max(m, textWidth(l)), 0);
  return {
    w: widest + PAD_X * 2 + 2,
    h: lines.length * LINE_H - 2 + PAD_Y * 2 + 2,
    lines,
  };
}

/** Keeps a bubble on the canvas without moving its tail, which stays pinned to the speaker. */
const clampX = (x: number, w: number): number => Math.max(2, Math.min(PIX.w - w - 2, Math.round(x)));

/** Draws `lines` into a panel, stopping after `shown` characters. */
function bubbleText(
  ctx: CanvasRenderingContext2D,
  lines: readonly string[],
  x: number,
  y: number,
  shown: number,
): void {
  let left = shown;
  for (let i = 0; i < lines.length; i++) {
    if (left <= 0) return;
    const line = lines[i];
    const part = left >= line.length ? line : line.slice(0, Math.max(0, Math.floor(left)));
    if (part !== '') drawText(ctx, part, x, y + i * LINE_H, PAL.out);
    left -= line.length;
  }
}

/**
 * A speech balloon whose tail tip lands on `(cx, yBase)` — put `yBase` just above the speaker's
 * head and the geometry takes care of itself.
 *
 * `reveal` is the typewriter: 0 shows nothing, 1 shows everything, and the box is the same size at
 * both. `verdict` recolours the border, which is the only place a status colour is allowed to touch
 * a prop.
 */
export function speechBubble(
  ctx: CanvasRenderingContext2D,
  cx: number,
  yBase: number,
  text: string,
  o: { reveal?: number; verdict?: 'ok' | 'err'; maxW?: number } = {},
): void {
  const m = measureBubble(text, o.maxW ?? 108);
  const tailH = 3;
  // Offset rather than centred: the tail comes off the box's left third, which is what a comic
  // balloon does and what stops two neighbours' bubbles from stacking exactly on top of each other.
  const x0 = clampX(cx - m.w * 0.38, m.w);
  const bot = yBase - tailH;
  const y0 = bot - m.h + 1;
  const border = o.verdict === 'ok' ? PAL.ok : o.verdict === 'err' ? PAL.err : PAL.out;

  rect(ctx, x0 + 1, y0 + 1, m.w, m.h, PAL.shd, 0.3); // it sits over the room, so it casts
  rect(ctx, x0, y0, m.w, m.h, border);
  rect(ctx, x0 + 1, y0 + 1, m.w - 2, m.h - 2, PAL.pap);
  rect(ctx, x0 + 1, y0 + m.h - 2, m.w - 2, 1, PAL.pa2); // the panel's own thickness
  rect(ctx, x0 + m.w - 2, y0 + 1, 1, m.h - 2, PAL.pa2);

  // Tail: a compact wedge narrowing to the tip, which is always the anchor. Kept steep — a tail
  // that travels far sideways per row reads as a stray diagonal streak rather than as a tail, and
  // in `verdict` colours that streak is the first thing the eye lands on.
  const tipX = Math.max(x0 + 3, Math.min(x0 + m.w - 4, Math.round(cx)));
  for (let i = 1; i <= tailH; i++) {
    const tw = tailH + 1 - i;
    rect(ctx, tipX - tw, bot + i, tw + 3, 1, border);
  }
  for (let i = 1; i < tailH; i++) {
    const tw = tailH + 1 - i;
    rect(ctx, tipX - tw + 1, bot + i, tw, 1, PAL.pap);
  }
  rect(ctx, tipX - 2, bot, 4, 1, PAL.pap); // punch the border so the tail joins the balloon

  const total = m.lines.reduce((n, l) => n + l.length, 0);
  const shown = o.reveal === undefined ? total : Math.ceil(clamp01(o.reveal) * total);
  bubbleText(ctx, m.lines, x0 + 1 + PAD_X, y0 + 1 + PAD_Y, shown);
}

/**
 * The cloud kind, for what an agent is thinking rather than saying: a lumpy panel over two puffs
 * that shrink as they trail down toward the thinker, and an ellipsis inside that keeps moving so a
 * long silence still looks alive.
 *
 * The dots are measured into the box at their full three-character width and only *drawn* short, so
 * the panel does not breathe once a second.
 */
export function thoughtBubble(
  ctx: CanvasRenderingContext2D,
  cx: number,
  yBase: number,
  text: string,
  t: number,
  maxW = 96,
): void {
  const m = measureBubble(`${text} ...`, maxW);
  const x0 = clampX(cx - m.w / 2, m.w);
  const bot = yBase - 12;
  const y0 = bot - m.h + 1;
  const cxi = Math.round(cx);

  massed(ctx, [
    { x: x0 + 3, y: y0, w: m.w - 6, h: m.h, c: PAL.pap },
    { x: x0 + 1, y: y0 + 2, w: m.w - 2, h: m.h - 4, c: PAL.pap },
    { x: x0, y: y0 + 4, w: m.w, h: m.h - 8, c: PAL.pap },
    // Two bumps on top, off-centre, so the cloud is not a rounded rectangle.
    { x: x0 + 6, y: y0 - 1, w: 5, h: 3, c: PAL.pap },
    { x: x0 + m.w - 14, y: y0 - 1, w: 6, h: 3, c: PAL.pap },
  ]);
  rect(ctx, x0 + 2, y0 + m.h - 3, m.w - 4, 1, PAL.pa2, 0.8);

  // The trailing puffs get their own pass: in the cloud's pass the outlines would touch and the
  // whole thing would fuse into one lumpy panel with a chin instead of reading as a trail.
  puff(ctx, cxi - 3, yBase - 9, 5, PAL.pap);
  puff(ctx, cxi - 1, yBase - 3, 3, PAL.pap);

  // The last line always ends in dots, because we measured it that way.
  const lines = m.lines.slice();
  const dots = 1 + (Math.floor(t / 320) % 3);
  const li = lines.length - 1;
  lines[li] = lines[li].replace(/\.{1,3}$/, '.'.repeat(dots));
  bubbleText(ctx, lines, x0 + 1 + PAD_X, y0 + 1 + PAD_Y, Number.MAX_SAFE_INTEGER);
}

// --------------------------------------------------------------------------- nameplate

const PLATE_H = 8;
const PLATE_SUB_H = 14;

/**
 * The HUD tag that floats under every agent: a dark rounded plate, a bevelled inner edge, the name
 * in the agent's own colour, and an optional status line under it.
 *
 * It is drawn every frame for every agent, so it is sized from `textWidth` rather than guessed —
 * a plate that is a pixel too narrow clips the last glyph of exactly the names you most need to
 * read. `selected` swaps the border for `acc`; `dim` fades the whole thing rather than greying the
 * text, so a dimmed plate still reads as the same object.
 */
export function nameplate(
  ctx: CanvasRenderingContext2D,
  cx: number,
  yBase: number,
  name: string,
  color: string,
  o: { sub?: string; selected?: boolean; dim?: boolean } = {},
): void {
  const sub = o.sub;
  const h = sub ? PLATE_SUB_H : PLATE_H;
  const w = Math.max(textWidth(name), sub ? textWidth(sub) : 0) + 6;
  const x0 = clampX(cx - w / 2, w);
  const y0 = yBase - h + 1;
  const a = o.dim === true ? 0.45 : 1;
  const border = o.selected === true ? PAL.acc : PAL.out;

  rect(ctx, x0 + 1, y0 + 1, w, h, PAL.shd, 0.35 * a);
  rect(ctx, x0, y0, w, h, border, a);
  rect(ctx, x0 + 1, y0 + 1, w - 2, h - 2, PAL.out, a);
  // The inner bevel: top and left only. A full ring at this height collides with the glyph rows.
  rect(ctx, x0 + 1, y0 + 1, w - 2, 1, PAL.ou2, a);
  rect(ctx, x0 + 1, y0 + 1, 1, h - 2, PAL.ou2, a);
  if (o.selected === true) rect(ctx, x0 + 1, y0 + h - 2, w - 2, 1, PAL.acc, 0.4 * a);

  drawText(ctx, name, x0 + 3, y0 + 2, color, a);
  if (sub) drawText(ctx, sub, x0 + 3, y0 + 8, PAL.gry, 0.85 * a);
}

// --------------------------------------------------------------------------- emote pop

/** Overshoot easing. The little kick past 1 is the whole difference between "pops" and "appears". */
function backOut(u: number): number {
  const c1 = 1.9;
  const p = clamp01(u) - 1;
  return 1 + (c1 + 1) * p * p * p + c1 * p * p;
}

/**
 * The one-glyph reaction that floats over a head: rises with an overshoot, settles, then fades over
 * the last quarter of its life.
 *
 * `'...'` is drawn as three loose pixels rather than as three font periods — the font's `.` is four
 * pixels of advance each, which would need a bubble half again as wide for no gain in legibility.
 */
export function emotePop(
  ctx: CanvasRenderingContext2D,
  cx: number,
  yBase: number,
  kind: '!' | '?' | '...',
  age: number,
): void {
  const u = clamp01(age);
  const alpha = u > 0.75 ? clamp01((1 - u) / 0.25) : 1;
  if (alpha <= 0) return;

  const rise = 10 * backOut(clamp01(u / 0.35));
  const r = 1 + 4 * clamp01(u / 0.22);
  const cxi = Math.round(cx);
  const cy = Math.round(yBase - 5 - rise);
  const rr = Math.round(r);

  const prev = ctx.globalAlpha;
  ctx.globalAlpha = prev * alpha;

  // Tail first, so the disc's outline closes over where it meets the bubble.
  for (let i = 1; i <= 2; i++) {
    rect(ctx, cxi - 3 + i, cy + rr + i, 3 - i + 1, 1, PAL.out);
  }
  rect(ctx, cxi - 2, cy + rr + 1, 2, 1, PAL.wht);

  disc(ctx, cxi, cy, rr + 1, PAL.out);
  disc(ctx, cxi, cy, rr, PAL.wht);
  if (rr >= 3) {
    rect(ctx, cxi - rr + 1, cy + rr - 1, rr * 2 - 2, 1, PAL.pa2);
    rect(ctx, cxi - rr + 1, cy - rr + 1, 2, 1, PAL.wht);
  }

  if (rr >= 4) {
    if (kind === '...') {
      for (let i = -1; i <= 1; i++) rect(ctx, cxi + i * 2, cy + 1, 1, 1, PAL.out);
    } else {
      drawText(ctx, kind, cxi - 1, cy - 2, PAL.out);
    }
  }
  ctx.globalAlpha = prev;
}

// --------------------------------------------------------------------------- preview

const SAY = 'The build is green, shipping it';
const WAL = PAL.wal;

export const PREVIEW: PreviewItem[] = [
  // --- the ones that carry words, first, because they are the ones that must be right
  {
    name: 'plate',
    w: 44,
    h: 12,
    bg: WAL,
    draw: (c) => nameplate(c, 22, 10, 'MAKER', '#7fd8ff'),
  },
  {
    name: 'plate-sub',
    w: 52,
    h: 18,
    bg: WAL,
    draw: (c) => nameplate(c, 26, 16, 'REVIEWER', '#ffb86b', { sub: 'reading diff' }),
  },
  {
    name: 'plate-sel',
    w: 52,
    h: 18,
    bg: WAL,
    draw: (c) => nameplate(c, 26, 16, 'PLANNER', '#a0f0b0', { sub: 'thinking', selected: true }),
  },
  {
    name: 'plate-dim',
    w: 52,
    h: 18,
    bg: WAL,
    draw: (c) => nameplate(c, 26, 16, 'SCRIBE', '#e8b0ff', { sub: 'idle', dim: true }),
  },

  {
    name: 'say',
    w: 120,
    h: 30,
    bg: WAL,
    draw: (c) => speechBubble(c, 60, 29, SAY, { maxW: 108 }),
  },
  {
    name: 'say-type',
    w: 120,
    h: 30,
    bg: WAL,
    frames: 5,
    frameMs: 220,
    draw: (c, t) => speechBubble(c, 60, 29, SAY, { maxW: 108, reveal: (t / 220) / 4 }),
  },
  {
    name: 'say-ok',
    w: 80,
    h: 24,
    bg: WAL,
    draw: (c) => speechBubble(c, 40, 23, 'Tests pass', { maxW: 70, verdict: 'ok' }),
  },
  {
    name: 'say-err',
    w: 80,
    h: 24,
    bg: WAL,
    draw: (c) => speechBubble(c, 40, 23, 'Build failed', { maxW: 70, verdict: 'err' }),
  },
  {
    name: 'say-short',
    w: 46,
    h: 20,
    bg: WAL,
    draw: (c) => speechBubble(c, 23, 19, 'Yes', { maxW: 40 }),
  },
  {
    name: 'think',
    w: 108,
    h: 34,
    bg: WAL,
    frames: 3,
    frameMs: 340,
    draw: (c, t) => thoughtBubble(c, 54, 33, 'Where does this live', t, 96),
  },
  {
    // The three puff sizes on their own. If any of them reads as a rounded square here, it reads
    // as a rounded square hanging under every thought in the room.
    name: 'puffs',
    w: 26,
    h: 12,
    bg: WAL,
    draw: (c) => {
      puff(c, 2, 3, 5, PAL.pap);
      puff(c, 11, 4, 4, PAL.pap);
      puff(c, 19, 5, 3, PAL.pap);
    },
  },

  {
    name: 'emote-!',
    w: 22,
    h: 26,
    bg: WAL,
    frames: 6,
    frameMs: 120,
    draw: (c, t) => emotePop(c, 11, 25, '!', (t / 120) / 6),
  },
  {
    name: 'emote-?',
    w: 22,
    h: 26,
    bg: WAL,
    draw: (c) => emotePop(c, 11, 25, '?', 0.5),
  },
  {
    name: 'emote-..',
    w: 22,
    h: 26,
    bg: WAL,
    draw: (c) => emotePop(c, 11, 25, '...', 0.5),
  },

  // --- the clutter
  { name: 'mug-hot', w: 12, h: 9, draw: (c) => drawMug(c, 5, 7, true) },
  { name: 'mug', w: 12, h: 9, draw: (c) => drawMug(c, 5, 7, false) },
  // The cost ramp, on one floor line. If two neighbours here look the same, the room cannot tell
  // an expensive desk from a cheap one either.
  { name: 'pap1', w: 14, h: 12, draw: (c) => drawPapers(c, 7, 11, 1) },
  { name: 'pap3', w: 14, h: 12, draw: (c) => drawPapers(c, 7, 11, 3) },
  { name: 'pap5', w: 14, h: 12, draw: (c) => drawPapers(c, 7, 11, 5) },
  { name: 'pap10', w: 14, h: 12, draw: (c) => drawPapers(c, 7, 11, 10) },
  { name: 'pap14', w: 14, h: 12, draw: (c) => drawPapers(c, 7, 11, 14) },
  { name: 'scat2', w: 26, h: 12, draw: (c) => drawScatter(c, 13, 10, 2, 1) },
  { name: 'scat4', w: 26, h: 12, draw: (c) => drawScatter(c, 13, 10, 4, 7) },
  { name: 'scat6', w: 26, h: 12, draw: (c) => drawScatter(c, 13, 10, 6, 23) },
  {
    // Same seed twice: the two cells must be pixel-identical, or the room is not replayable.
    name: 'scat-det',
    w: 26,
    h: 12,
    frames: 2,
    draw: (c) => drawScatter(c, 13, 10, 5, 42),
  },

  {
    name: 'link',
    w: 64,
    h: 30,
    bg: WAL,
    frames: 6,
    frameMs: 200,
    draw: (c, t) => drawLink(c, 5, 26, 58, 9, 'TASK', t / 200 / 5, PAL.acc),
  },
  {
    name: 'link-dn',
    w: 40,
    h: 34,
    bg: WAL,
    draw: (c) => drawLink(c, 8, 4, 30, 31, 'SPAWN', 0.5, '#e0855a'),
  },
  {
    name: 'keys',
    w: 17,
    h: 8,
    frames: 4,
    frameMs: 140,
    draw: (c, t) => drawKeyboard(c, 8, 6, (Math.sin(t / 140) + 1) / 2),
  },
  { name: 'mouse', w: 9, h: 7, draw: (c) => drawMouse(c, 4, 5) },
  { name: 'lamp-on', w: 16, h: 17, draw: (c) => drawDeskLamp(c, 8, 15, true) },
  { name: 'lamp-off', w: 16, h: 17, draw: (c) => drawDeskLamp(c, 8, 15, false) },
  { name: 'books', w: 15, h: 11, draw: (c) => drawBooks(c, 7, 9) },
  { name: 'bin', w: 16, h: 20, draw: (c) => drawBin(c, 8, 18) },
  { name: 'box', w: 19, h: 17, draw: (c) => drawBox(c, 9, 15) },

  { name: 'plant0', w: 14, h: 14, draw: (c) => drawPlant(c, 7, 12, 0, 0) },
  { name: 'plant1', w: 18, h: 20, draw: (c) => drawPlant(c, 9, 18, 1, 0) },
  { name: 'plant2', w: 22, h: 26, draw: (c) => drawPlant(c, 11, 24, 2, 0) },
  {
    name: 'sway',
    w: 22,
    h: 26,
    frames: 5,
    frameMs: 260,
    draw: (c, t) => drawPlant(c, 11, 24, 2, Math.sin(t / 400)),
  },
  {
    name: 'hanging',
    w: 24,
    h: 34,
    frames: 4,
    frameMs: 300,
    draw: (c, t) => drawHangingPlant(c, 12, 1, Math.sin(t / 380)),
  },

  {
    name: 'coffee',
    w: 18,
    h: 24,
    frames: 3,
    frameMs: 180,
    draw: (c, t) => drawCoffeeMachine(c, 9, 22, true, t),
  },
  { name: 'coffee-off', w: 18, h: 24, draw: (c) => drawCoffeeMachine(c, 9, 22, false, 0) },
  {
    name: 'printer',
    w: 26,
    h: 22,
    frames: 4,
    frameMs: 260,
    draw: (c, t) => drawPrinter(c, 13, 20, t / 260 / 3),
  },
  { name: 'cooler', w: 20, h: 34, draw: (c) => drawWaterCooler(c, 10, 32) },
  { name: 'coatrack', w: 22, h: 38, draw: (c) => drawCoatRack(c, 11, 36) },
  {
    name: 'cable',
    w: 40,
    h: 20,
    draw: (c) => {
      drawCable(c, 3, 3, 36, 8);
      drawCable(c, 3, 10, 20, 18);
    },
  },
];
