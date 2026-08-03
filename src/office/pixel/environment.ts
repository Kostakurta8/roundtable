/**
 * The room shell: the wall the office hangs on, the floor it stands on, and the fixtures that are
 * part of the building rather than part of the furniture.
 *
 * Everything here is drawn procedurally rather than as `Art` sprites, because the shell is mostly
 * long runs of a single colour with a rule behind them — a plank floor is "a seam every eight rows
 * and butt joints that never line up", not a bitmap. A bitmap of a 480-wide floor would also be a
 * 480-character row, which no one could fix.
 *
 * Two rules drive every colour choice below:
 *
 *  - **Light comes from the left and centre**, through the three windows, and warm from the lamps.
 *    Wall columns near a window lift toward `wlt` in four discrete steps; surfaces facing down or
 *    away go to `wa3` / `shd`. The steps are deliberately hard — a smooth falloff at this scale
 *    turns into mud the moment it is scaled up with nearest-neighbour filtering.
 *  - **`night` is a dial, not a switch.** Every function that takes it crossfades rather than
 *    branching, so the room can sit at dusk without a frame where the sky pops.
 *
 * Nothing here is random. Plank tones, joint positions and star placement all come from `hash()`,
 * an integer mix, so the same room is the same room every reload and a preview PNG is evidence.
 */
import { PAL, PIX, drawText, pool, rect, textWidth } from './art';
import type { PreviewItem } from './preview';

// ---------------------------------------------------------------- geometry

/** The floor starts at this row; everything above it is wall. */
export const WALL_H = 38;

/** Skirting board height, at the bottom of the wall band. */
export const SKIRT_H = 3;

/** Window centres on the back wall — the wall's light falloff is built around these. */
const WINDOW_X = [72, 149, 278] as const;

/** How much of `wlt` each of the four lift steps mixes into the wall. */
const LIFT_ALPHA = [0, 0.1, 0.2, 0.33] as const;

// ---------------------------------------------------------------- helpers

/**
 * A deterministic 0..1 from two integers.
 *
 * `Math.random()` is banned in the room: a floor whose plank joints move every reload is a floor
 * that can never be reviewed from a PNG, and a star that jumps on rerender reads as a bug.
 */
function hash(a: number, b: number): number {
  let h = Math.imul(a | 0, 0x27d4eb2d) ^ Math.imul((b | 0) + 0x165667b1, 0x9e3779b1);
  h ^= h >>> 15;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  return (h >>> 0) / 4294967296;
}

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

/** A half-open pixel box, used where a fill has to stop at a window pane or a board edge. */
type Box = { x0: number; y0: number; x1: number; y1: number };

/**
 * `rect`, intersected with a box.
 *
 * The canvas subset has no clipping region, so anything drawn inside a frame — a cloud crossing a
 * pane, a line of text longer than a whiteboard — has to clip itself or it paints over the frame.
 */
function clipped(
  ctx: CanvasRenderingContext2D,
  b: Box,
  x: number,
  y: number,
  w: number,
  h: number,
  color: string,
  alpha = 1,
): void {
  const ax = Math.max(b.x0, Math.round(x));
  const ay = Math.max(b.y0, Math.round(y));
  const bx = Math.min(b.x1, Math.round(x) + Math.round(w));
  const by = Math.min(b.y1, Math.round(y) + Math.round(h));
  if (bx > ax && by > ay) rect(ctx, ax, ay, bx - ax, by - ay, color, alpha);
}

/** A filled circle as whole-pixel scanlines. Odd widths, so it stays symmetric about `cx`. */
function disc(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  r: number,
  color: string,
  alpha = 1,
): void {
  const n = Math.ceil(r);
  for (let dy = -n; dy <= n; dy++) {
    const half = Math.round(Math.sqrt(Math.max(0, r * r - dy * dy)));
    if (half <= 0) continue;
    rect(ctx, cx - half, cy + dy, half * 2 + 1, 1, color, alpha);
  }
}

/** A clock hand: whole pixels stepped along an angle, half-pixel steps so it has no gaps. */
function needle(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  ang: number,
  len: number,
  color: string,
): void {
  const sx = Math.sin(ang);
  const sy = -Math.cos(ang);
  for (let i = 0; i <= len; i += 0.5) {
    rect(ctx, Math.round(cx + sx * i), Math.round(cy + sy * i), 1, 1, color);
  }
}

// ---------------------------------------------------------------- wall

/**
 * How lit a wall column is, 0 (plain `wal`) to 3 (`wlt`).
 *
 * Quantised on purpose. A continuous falloff renders as a smear; four steps render as light, and
 * the vertical seams between them land 20-odd pixels apart, which at this scale reads as the room
 * being lit rather than as banding.
 */
function liftLevel(x: number): number {
  let v = 0.3 * (1 - x / 300); // general daylight wash, strongest at the left-hand end
  for (const c of WINDOW_X) v = Math.max(v, 1 - Math.abs(x - c) / 104);
  return Math.max(0, Math.min(3, Math.floor(v * 4)));
}

/**
 * The back wall: `y 0 … WALL_H`, full width.
 *
 * A flat teal field, lifted toward the windows, cut by one panel groove and closed at the bottom
 * by the skirting. `t` drives a barely-there warmth wobble once the lamps are the only light, so a
 * night room is not perfectly static.
 */
export function drawWall(ctx: CanvasRenderingContext2D, night: number, t: number): void {
  const n = clamp01(night);
  const bodyTop = 3;
  const bodyH = WALL_H - SKIRT_H - bodyTop;

  rect(ctx, 0, 0, PIX.w, WALL_H, PAL.wal);

  // Daylight lift, emitted as runs of equal level so the whole falloff costs a dozen fills.
  const dayFactor = 1 - 0.78 * n;
  if (dayFactor > 0.01) {
    let start = 0;
    let level = liftLevel(0);
    for (let x = 1; x <= PIX.w; x++) {
      const l = x < PIX.w ? liftLevel(x) : -1;
      if (l !== level) {
        if (level > 0) rect(ctx, start, bodyTop, x - start, bodyH, PAL.wlt, LIFT_ALPHA[level] * dayFactor);
        start = x;
        level = l;
      }
    }
  }

  // The far right-hand end is away from every window, so it sinks toward the darker teal. Without
  // it the wall is one flat field 480 pixels wide and the room has no left-to-right read at all.
  rect(ctx, 396, bodyTop, PIX.w - 396, bodyH, PAL.wa2, 0.16 * dayFactor);
  rect(ctx, 444, bodyTop, PIX.w - 444, bodyH, PAL.wa2, 0.14 * dayFactor);

  // Panel stiles at a wide pitch: 1px of shadow with 1px of lit return beside it, the way a
  // shallow moulding catches the daylight. Barely visible on purpose — enough that the wall stops
  // being one 480-pixel sheet of card, not nearly enough to compete with a person in front of it.
  // The phase is chosen so the stiles fall in the gaps between the windows and the whiteboard
  // rather than behind them; a panel line you never see is a panel line that does no work.
  for (let x = 8; x < PIX.w; x += 52) {
    rect(ctx, x, bodyTop, 1, bodyH, PAL.wa3, 0.2);
    rect(ctx, x + 1, bodyTop, 1, bodyH, PAL.wlt, 0.09);
  }

  // The chair rail: a lit top surface, the rail's own dark line, and the shadow it drops onto the
  // wall below it. Three rows is the whole trick — one dark line alone reads as a scratch.
  rect(ctx, 0, 14, PIX.w, 1, PAL.wlt, 0.3);
  rect(ctx, 0, 15, PIX.w, 1, PAL.wa2, 0.8);
  rect(ctx, 0, 16, PIX.w, 1, PAL.wa3, 0.35);

  // Ceiling shadow — the wall never reads as tall without something dark closing the top.
  rect(ctx, 0, 0, PIX.w, 2, PAL.wa3);
  rect(ctx, 0, 2, PIX.w, 1, PAL.wa3, 0.5);

  // Skirting: a lit top edge, then the trim itself.
  rect(ctx, 0, WALL_H - SKIRT_H, PIX.w, 1, PAL.wa2);
  rect(ctx, 0, WALL_H - SKIRT_H + 1, PIX.w, SKIRT_H - 1, PAL.wtr);

  if (n > 0) {
    const shimmer = 0.5 + 0.5 * Math.sin(t / 1700);
    rect(ctx, 0, 0, PIX.w, WALL_H, PAL.shd, 0.32 * n);
    rect(ctx, 0, 0, PIX.w, WALL_H, PAL.lm2, (0.055 + 0.02 * shimmer) * n);
  }
}

// ---------------------------------------------------------------- floor

/**
 * Per-board tone, as a **wash over the base tone** rather than as a replacement for it.
 *
 * The floor is one colour — `fl2` — and a board is either that colour or that colour with a thin
 * veil of its neighbour laid over it. Swapping whole boards between `flr`, `fl2` and `fl3` at full
 * strength was the first version and it read as **brickwork**: a tonal step at every joint, in
 * courses, is the definition of a running bond. Wood does not do that. Boards off one tree differ
 * by a hint, so a `null` here (plain `fl2`) is the common case and the washes are thin.
 */
type PlankWash = { c: string; a: number } | null;
const PLANK_TONE: readonly PlankWash[] = [
  null,
  { c: PAL.flr, a: 0.3 },
  null,
  { c: PAL.fl3, a: 0.22 },
  { c: PAL.flr, a: 0.16 },
  null,
  { c: PAL.fl3, a: 0.3 },
  null,
  { c: PAL.flr, a: 0.22 },
  { c: PAL.fl3, a: 0.14 },
];

/**
 * Course height in rows, hashed per course into `COURSE_MIN … COURSE_MIN + COURSE_SPREAD - 1`.
 *
 * This is the fix for the floor's one real failure. A seam every eight rows, exactly, is a comb:
 * a spatial frequency repeated twenty-nine times down the canvas, which the eye integrates into a
 * shimmer — corduroy — rather than into boards, and which beats against the display's own pixel
 * grid the moment the canvas is scaled by anything other than a whole number. Wobbling the pitch
 * by a row either way destroys the periodicity while changing no individual course enough to be
 * noticed: 7, 8 and 9 are within a pixel of each other, so the floor still reads as one floor.
 */
const COURSE_MIN = 7;
const COURSE_SPREAD = 3;

/**
 * A butt joint has to clear every joint in the course above it by this much.
 *
 * Hashed joint positions are *independent*, not *staggered* — independence puts two joints within
 * a couple of pixels of each other every few courses, and a near-alignment reads far worse than a
 * true alignment because it looks like a mistake. Real flooring has the same rule for the same
 * reason, at about the same ratio to the board length.
 */
const MIN_STAGGER = 14;

/**
 * The floor: `y WALL_H … 270`, full width.
 *
 * Horizontal boards, an `fl4` seam every eight rows, and butt joints whose x positions are hashed
 * per band so no two courses break in the same place.
 *
 * The one thing that has to read here is the **long** seam between courses. Everything else is
 * deliberately quieter than it wants to be:
 *
 *  - Board length is 110–260, so a 480-wide course breaks two or three times rather than eight.
 *  - Only about two thirds of those breaks are drawn at all, and the ones that are get a single
 *    1px `fl4` at a third strength with no lit edge beside them. A short cross-cut at full
 *    contrast, repeated across a course, is the exact cue the eye uses to read masonry — it has to
 *    lose every contrast fight against the long seam or the floor turns back into a wall of bricks.
 *  - Grain runs **along** the board: 2–3 long 1px streaks of the neighbouring tones. Lengthwise
 *    marks are what say "timber", and they cannot be misread as mortar because mortar has no
 *    grain direction.
 *
 * Three separate regularities are broken here, because the floor is a background and any one of
 * them left intact is enough to make it read as a woven texture instead:
 *
 *  1. **Course pitch.** `COURSE_MIN`/`COURSE_SPREAD` — see above. This is the big one.
 *  2. **Joint stagger.** Every joint is pushed clear of the joints in the course above it by
 *     `MIN_STAGGER`, so no two courses ever break together or nearly together.
 *  3. **Tone runs.** A board never carries the same wash as the board to its left, so the pair of
 *     tones at a joint always differs and a long stretch of one tone cannot form.
 */
export function drawFloor(ctx: CanvasRenderingContext2D, night: number): void {
  const n = clamp01(night);
  const top = WALL_H;
  const bot = PIX.h;

  rect(ctx, 0, top, PIX.w, bot - top, PAL.fl2);

  // The joints of the course above, so this one can be pushed clear of them.
  let prevJoints: number[] = [];

  for (let course = 0, y0 = top; y0 < bot; course++) {
    const ch = COURSE_MIN + Math.floor(hash(course, 4243) * COURSE_SPREAD);
    const h = Math.min(ch - 1, bot - y0);
    const joints: number[] = [];

    // Each course starts off-canvas by a hashed amount, so the first joint is never at x 0.
    let x = -Math.floor(hash(course, 977) * 300);
    let prevTone = -1;
    for (let k = 0; x < PIX.w; k++) {
      let end = x + 110 + Math.floor(hash(course, k) * 150);
      // Nudge the board's far end along until it clears the course above. Bounded: four shoves of
      // 19 pixels is more than the widest clash can need, and an unbounded search here would be a
      // loop whose exit depends on a hash.
      for (let tries = 0; tries < 4; tries++) {
        let clash = false;
        for (const p of prevJoints) {
          if (Math.abs(p - end) < MIN_STAGGER) {
            clash = true;
            break;
          }
        }
        if (!clash) break;
        end += MIN_STAGGER + 5;
      }

      let tone = Math.floor(hash(course, k + 4001) * PLANK_TONE.length) % PLANK_TONE.length;
      if (tone === prevTone) tone = (tone + 3) % PLANK_TONE.length;
      prevTone = tone;
      const wash = PLANK_TONE[tone];

      const a = Math.max(0, x);
      const b = Math.min(PIX.w, end);
      if (b > a) {
        if (wash) rect(ctx, a, y0, b - a, h, wash.c, wash.a);
        rect(ctx, a, y0, b - a, 1, PAL.flt, 0.08); // chamfer along the board's top edge

        // Grain: long, faint streaks running the length of the board. This is the detail that
        // separates "wood" from "brown", and it has to stay faint — at full strength it reads as
        // scratches, and at short lengths it reads as speckle.
        const streaks = hash(course, k + 77) < 0.5 ? 2 : 3;
        for (let s = 0; s < streaks; s++) {
          const gy = y0 + 1 + Math.floor(hash(course * 31 + k, s + 5) * Math.max(1, h - 2));
          const gx = a + Math.floor(hash(course * 17 + k, s + 11) * Math.max(1, (b - a) * 0.6));
          const gw = 40 + Math.floor(hash(course * 13 + k, s + 23) * 90);
          const dark = hash(course * 7 + k, s + 41) < 0.55;
          rect(ctx, gx, gy, Math.min(gw, b - gx), 1, dark ? PAL.fl3 : PAL.flr, dark ? 0.3 : 0.28);
        }

        // Butt joint: 1px of end grain, faint, and only on some board ends.
        if (end < PIX.w && hash(course, k + 613) < 0.62) {
          rect(ctx, end - 1, y0, 1, h, PAL.fl4, 0.3);
        }
      }
      if (end > 0 && end < PIX.w) joints.push(end);
      x = end;
    }

    // Seam strength wanders a little too. Twenty-nine identical rules stacked at an identical
    // pitch is the comb; twenty-nine rules of slightly different weight at a wandering pitch is a
    // floor, and the difference costs one hash.
    const seam = y0 + ch - 1;
    if (seam < bot) rect(ctx, 0, seam, PIX.w, 1, PAL.fl4, 0.68 + 0.2 * hash(course, 88));

    prevJoints = joints;
    y0 += ch;
  }

  // Contact occlusion where the floor meets the skirting. Without it the two planes float apart.
  rect(ctx, 0, top, PIX.w, 1, PAL.shd, 0.55);
  rect(ctx, 0, top + 1, PIX.w, 1, PAL.shd, 0.32);
  rect(ctx, 0, top + 2, PIX.w, 1, PAL.shd, 0.14);

  if (n > 0) {
    rect(ctx, 0, top, PIX.w, bot - top, PAL.shd, 0.36 * n);
    rect(ctx, 0, top, PIX.w, bot - top, PAL.lm2, 0.05 * n);
  }
}

// ---------------------------------------------------------------- window

export const WINDOW = { w: 34, h: 30 } as const;

/** Two clouds, drifting in whole pixels so they never shimmer between subpixels. */
function clouds(ctx: CanvasRenderingContext2D, pane: Box, t: number, alpha: number): void {
  if (alpha <= 0.02) return;
  const paneW = pane.x1 - pane.x0;
  const span = paneW + 22;
  for (let i = 0; i < 2; i++) {
    const perPx = 240 + i * 150;
    const raw = Math.floor(t / perPx) + Math.floor(hash(i, 61) * span);
    const cx = pane.x0 - 11 + ((raw % span) + span) % span;
    const cy = pane.y0 + 1 + i * 5;
    clipped(ctx, pane, cx + 2, cy, 6, 1, PAL.wht, alpha);
    clipped(ctx, pane, cx, cy + 1, 10, 1, PAL.wht, alpha);
    clipped(ctx, pane, cx + 1, cy + 2, 8, 1, PAL.pa2, alpha);
  }
}

/**
 * A window in the back wall — frame, mullion cross, sill, and sky behind the glass.
 *
 * `yBase` is the bottom row of the sill's shadow, so a window anchors against the wall the same
 * way a desk anchors against the floor. Day and night are crossfaded rather than switched: the
 * night pane is painted over the day one at `night` alpha, and the clouds fade out as the stars
 * fade in, which means dusk is a real state and not a seam.
 */
export function drawWindow(
  ctx: CanvasRenderingContext2D,
  cx: number,
  yBase: number,
  night: number,
  t: number,
): void {
  const n = clamp01(night);
  const x0 = Math.round(cx) - 17;
  const y0 = Math.round(yBase) - (WINDOW.h - 1);
  const pane: Box = { x0: x0 + 4, y0: y0 + 4, x1: x0 + 30, y1: y0 + 22 };
  const pw = pane.x1 - pane.x0;
  const ph = pane.y1 - pane.y0;

  // --- casing
  rect(ctx, x0, y0, 34, 26, PAL.out);
  rect(ctx, x0 + 1, y0 + 1, 32, 24, PAL.gry);
  rect(ctx, x0 + 1, y0 + 1, 32, 1, PAL.wht);
  rect(ctx, x0 + 1, y0 + 1, 1, 24, PAL.wht);
  rect(ctx, x0 + 1, y0 + 24, 32, 1, PAL.ou2, 0.34);
  rect(ctx, x0 + 32, y0 + 1, 1, 24, PAL.ou2, 0.34);

  // --- glass
  rect(ctx, pane.x0, pane.y0, pw, ph, PAL.sc3);
  rect(ctx, pane.x0, pane.y0 + 8, pw, 4, PAL.day, 0.45);
  rect(ctx, pane.x0, pane.y0 + 12, pw, ph - 12, PAL.day);
  rect(ctx, pane.x0, pane.y0 + 10, 14, 8, PAL.lm2, 0.18); // the warm patch, low and to the left
  clouds(ctx, pane, t, 1 - n);

  if (n > 0.01) {
    rect(ctx, pane.x0, pane.y0, pw, ph, PAL.wtr, n);
    rect(ctx, pane.x0, pane.y0, pw, 6, PAL.shd, 0.55 * n);
    rect(ctx, pane.x0, pane.y1 - 4, pw, 4, PAL.wa3, 0.5 * n); // the sky is never black at the horizon

    // Stars first, so the moon sits in front of them. Placed off a hash and skipped where they
    // would land inside the moon, because a star showing through the moon reads as a dead pixel.
    for (let i = 0; i < 6; i++) {
      const sx = pane.x0 + 1 + Math.floor(hash(i, 17) * (pw - 2));
      const sy = pane.y0 + 1 + Math.floor(hash(i, 29) * (ph - 7));
      if (Math.abs(sx - (pane.x0 + 18)) < 5 && Math.abs(sy - (pane.y0 + 4)) < 4) continue;
      const twinkle = (Math.floor(t / 620) + i) % 5 === 0 ? 0.3 : 1;
      rect(ctx, sx, sy, 1, 1, PAL.wht, n * twinkle);
      // One of them gets four arms — a single bright star sells "night" better than six specks.
      if (i === 2) {
        clipped(ctx, pane, sx - 1, sy, 3, 1, PAL.wht, 0.5 * n * twinkle);
        clipped(ctx, pane, sx, sy - 1, 1, 3, PAL.wht, 0.5 * n * twinkle);
      }
    }

    // The moon, as explicit rows. `disc` at this radius comes out lumpy and read as a cloud in the
    // first contact sheet; five hand-set rows read as a moon.
    const mx = pane.x0 + 18;
    const my = pane.y0 + 4;
    clipped(ctx, pane, mx - 2, my - 4, 6, 8, PAL.day, 0.09 * n); // halo
    clipped(ctx, pane, mx - 3, my - 3, 8, 6, PAL.day, 0.09 * n);
    clipped(ctx, pane, mx - 1, my - 3, 3, 1, PAL.wht, n);
    clipped(ctx, pane, mx - 2, my - 2, 5, 1, PAL.wht, n);
    clipped(ctx, pane, mx - 2, my - 1, 5, 1, PAL.wht, n);
    clipped(ctx, pane, mx - 2, my, 5, 1, PAL.wht, n);
    clipped(ctx, pane, mx - 1, my + 1, 3, 1, PAL.wht, n);
    clipped(ctx, pane, mx + 1, my, 2, 1, PAL.pa2, n); // the shaded lower-right limb
    clipped(ctx, pane, mx, my + 1, 2, 1, PAL.pa2, n);
    clipped(ctx, pane, mx - 1, my - 1, 1, 1, PAL.pa2, n); // two craters
    clipped(ctx, pane, mx + 1, my - 2, 1, 1, PAL.pa2, n);
  }

  // A stepped glare across the glass — three short bars, the pixel-art way of saying "this is a
  // sheet of glass and not a hole in the wall".
  for (let i = 0; i < 3; i++) {
    clipped(ctx, pane, pane.x0 + 3 + i * 3, pane.y0 + 1 + i * 3, 5, 2, PAL.wht, 0.1);
  }

  // --- recess, mullions
  rect(ctx, x0 + 3, y0 + 3, 28, 1, PAL.ou2);
  rect(ctx, x0 + 3, y0 + 3, 1, 20, PAL.ou2);
  rect(ctx, x0 + 3, y0 + 22, 28, 1, PAL.wht);
  rect(ctx, x0 + 30, y0 + 3, 1, 20, PAL.wht);
  rect(ctx, x0 + 16, pane.y0, 2, ph, PAL.gry);
  rect(ctx, x0 + 16, pane.y0, 1, ph, PAL.wht);
  rect(ctx, pane.x0, y0 + 11, pw, 2, PAL.gry);
  rect(ctx, pane.x0, y0 + 11, pw, 1, PAL.wht);

  // --- sill, overhanging one pixel each side with a lit top edge
  rect(ctx, x0 - 1, y0 + 26, 36, 1, PAL.wht);
  rect(ctx, x0 - 1, y0 + 27, 36, 1, PAL.gry);
  rect(ctx, x0 - 1, y0 + 28, 36, 1, PAL.out);
  rect(ctx, x0, y0 + 29, 34, 1, PAL.shd, 0.45);
}

// ---------------------------------------------------------------- door

export const DOOR = { w: 22, h: 32 } as const;

/** Visible leaf width at each of the four discrete swing positions. */
const LEAF_W = [16, 11, 6, 2] as const;

/**
 * A panelled door in its casing. `open` 0..1 picks one of four positions.
 *
 * Four poses rather than an interpolated swing: a door rotating smoothly needs perspective on the
 * leaf's face, which at 16 pixels wide is four pixels of shear and reads as a glitch. Snapping to
 * closed / ajar / half / open is how sprite games have always done it, and it reads as a door.
 */
export function drawDoor(ctx: CanvasRenderingContext2D, cx: number, yBase: number, open: number): void {
  const x0 = Math.round(cx) - 11;
  const y0 = Math.round(yBase) - (DOOR.h - 1);
  const stage = Math.max(0, Math.min(3, Math.floor(clamp01(open) * 3.999)));
  const lw = LEAF_W[stage];
  const ox = x0 + 3; // hinge side of the opening
  const oy = y0 + 3;
  const oh = DOOR.h - 3;

  // casing
  rect(ctx, x0, y0, 22, DOOR.h, PAL.out);
  rect(ctx, x0 + 1, y0 + 1, 20, DOOR.h - 1, PAL.wdd);
  rect(ctx, x0 + 1, y0 + 1, 20, 1, PAL.wdf);
  rect(ctx, x0 + 1, y0 + 1, 1, DOOR.h - 1, PAL.wdf);
  rect(ctx, x0 + 20, y0 + 1, 1, DOOR.h - 1, PAL.shd, 0.4);

  // the hallway beyond
  rect(ctx, ox, oy, 16, oh, PAL.shd);
  rect(ctx, ox + 1, oy + 2, 14, 18, PAL.ou2, 0.5);
  rect(ctx, ox, oy + 22, 16, 6, PAL.ou2);
  rect(ctx, ox, oy + 22, 16, 1, PAL.bl2);
  rect(ctx, ox, y0 + DOOR.h - 1, 16, 1, PAL.out);

  // the leaf
  rect(ctx, ox, oy, lw, oh, PAL.wdf);
  rect(ctx, ox, oy, lw, 1, PAL.wdl);
  rect(ctx, ox, oy, 1, oh, PAL.wdt);
  rect(ctx, ox + lw - 1, oy, 1, oh, PAL.wdd);
  if (stage > 0) rect(ctx, ox + lw, oy, 1, oh, PAL.wdl); // the leaf's own edge, catching the light

  if (lw >= 9) {
    const pw = lw - 5;
    for (const py of [oy + 3, oy + 15]) {
      rect(ctx, ox + 2, py, pw, 10, PAL.wdd);
      rect(ctx, ox + 2, py, pw, 1, PAL.shd, 0.55);
      rect(ctx, ox + 2, py, 1, 10, PAL.shd, 0.55);
      rect(ctx, ox + 2, py + 9, pw, 1, PAL.wdl, 0.7);
      rect(ctx, ox + 1 + pw, py, 1, 10, PAL.wdl, 0.7);
    }
  } else if (lw >= 4) {
    rect(ctx, ox + 2, oy + 4, 1, oh - 8, PAL.wdd);
  }

  if (lw >= 6) {
    rect(ctx, ox + lw - 3, oy + 14, 2, 2, PAL.met);
    rect(ctx, ox + lw - 3, oy + 14, 1, 1, PAL.me3);
  }
}

// ---------------------------------------------------------------- whiteboard

/** How many of `lines` fit, and where they sit inside the board. */
const BOARD_LINE_Y = [5, 11, 17] as const;

/** Text inset and the widest a line may be before it is elided. */
const BOARD_TEXT_X = 6;
const BOARD_TEXT_W = 50;

/**
 * A tally mark: 2px wide with a 1px gap, and 2px of air between the three groups.
 *
 * 1px marks were the first try and they are wrong: a row of alternating on/off columns is a dashed
 * line, not a row of countable things, and at 480 wide with no zoom it flickers exactly the way the
 * old floor did. Two pixels is the narrowest mark that still reads as an object.
 */
const MARK_W = 2;
const MARK_PITCH = 3;
// Three pixels between groups, not two. At two the first contact sheet showed the three runs as
// one continuous dashed strip — the gap has to be visibly wider than the gap *inside* a run or the
// grouping does no work, and one pixel is not visibly wider than one pixel.
const MARK_GROUP_GAP = 3;

/** One run of marks: how many, in what colour, how tall. */
type Tally = { n: number; color: string; h: number };

/**
 * What the board is reporting — the session in the four numbers that fit on it.
 *
 * Passing bare `lines` is still supported and still draws exactly what it always did; this is the
 * shape for a board that also knows how the session is going.
 */
export type BoardState = {
  /** Up to two wrapped lines of what the session was asked to do. */
  lines: readonly string[];
  /** Agents on the floor now, and how many have finished and gone. */
  live?: number;
  done?: number;
  /** How many finished badly. Drawn only when non-zero. */
  failed?: number;
  /** 0..1 — how far along the session's spend is against whatever the caller considers full. */
  spend?: number;
};

const isLines = (b: readonly string[] | BoardState): b is readonly string[] => Array.isArray(b);

/** Truncated to fit rather than clipped mid-glyph — half a letter reads as a rendering fault. */
function fitLine(s: string, maxW: number): string {
  let out = s;
  while (out.length > 0 && textWidth(out) > maxW) out = out.slice(0, -1);
  return out;
}

/**
 * The tally: done, then live, then failed, as short runs of marks on a common baseline.
 *
 * Marks rather than numbers, because "7/12" at this size is four glyphs three pixels wide and
 * comes out as a grey smear on a pale board — the contact sheet showed it as noise before it
 * showed it as a number. A run of ticks can be counted when you care and read as a quantity when
 * you do not, and colour carries the rest: green finished, teal working, red failed.
 *
 * Done leads because it is the only group that only ever grows: the left-hand end of the row is
 * then stable frame to frame, and only the right-hand end moves as the session runs.
 *
 * Live marks are drawn a row shorter than the others. That is the whole reason the row survives
 * being looked at from across the room without a legend — "not yet at full height" is a shape, and
 * shape survives at distances and in colour-vision deficiencies where teal-versus-green does not.
 */
function drawTally(
  ctx: CanvasRenderingContext2D,
  x: number,
  yBase: number,
  maxW: number,
  groups: readonly Tally[],
): void {
  const used = groups.filter((g) => g.n > 0);
  if (used.length === 0) return;

  const gaps = (used.length - 1) * MARK_GROUP_GAP;
  const cap = Math.max(used.length, Math.floor((maxW - gaps + 1) / MARK_PITCH));
  const total = used.reduce((s, g) => s + g.n, 0);

  // Past the board's capacity the marks stop being a count and become a proportion. That is a
  // small lie, but it is the same lie a tally chart tells at a glance, and the alternative — marks
  // that silently stop appearing once the sixteenth agent arrives — is a worse one.
  let counts = used.map((g) => g.n);
  if (total > cap) {
    counts = used.map((g) => Math.max(1, Math.round((g.n * cap) / total)));
    for (let sum = counts.reduce((s, c) => s + c, 0); sum > cap; sum--) {
      let big = 0;
      for (let i = 1; i < counts.length; i++) if (counts[i] > counts[big]) big = i;
      if (counts[big] <= 1) break;
      counts[big] -= 1;
    }
  }

  let px = x;
  for (let gi = 0; gi < used.length; gi++) {
    for (let i = 0; i < counts[gi]; i++) {
      if (px + MARK_W > x + maxW) return; // the board's edge wins, always
      rect(ctx, px, yBase - used[gi].h + 1, MARK_W, used[gi].h, used[gi].color);
      px += MARK_PITCH;
    }
    px += MARK_GROUP_GAP;
  }
}

/**
 * The big board on the back wall: aluminium frame, pale surface, a marker tray with two pens.
 *
 * It takes either the bare `lines` it always took, or a `BoardState` — the same lines plus the two
 * things that make the board worth having in the room at all: how many agents are working and how
 * far the budget has gone. It is the one object here that can answer "what is this session, and
 * how is it going", and a board that answers neither is 62 × 30 pixels of wall.
 *
 * The surface is 54 × 17 usable pixels, which buys exactly two lines of text at 5px with a row of
 * leading, a three-row tally, and nothing else. The spend bar therefore lives *below* the writing
 * area, on the board's own bottom lip, where it can run the full 56 pixels and cannot steal a row
 * from the task. Two lines of text and a status block was the most that fitted; a third text line
 * was dropped for the `BoardState` path, which is the one thing the widening costs.
 */
export function drawWhiteboard(
  ctx: CanvasRenderingContext2D,
  cx: number,
  yBase: number,
  board: readonly string[] | BoardState,
): void {
  const x0 = Math.round(cx) - 31;
  const y0 = Math.round(yBase) - 29;
  const bare = isLines(board);
  const state: BoardState = bare ? { lines: board } : board;

  // frame
  rect(ctx, x0, y0, 62, 26, PAL.out);
  rect(ctx, x0 + 1, y0 + 1, 60, 24, PAL.met);
  rect(ctx, x0 + 1, y0 + 1, 60, 1, PAL.me3);
  rect(ctx, x0 + 1, y0 + 1, 1, 24, PAL.me3);
  rect(ctx, x0 + 1, y0 + 23, 60, 2, PAL.me2);

  // surface, with a recessed lip
  rect(ctx, x0 + 3, y0 + 3, 56, 20, PAL.ou2);
  rect(ctx, x0 + 4, y0 + 4, 54, 18, PAL.pap);
  rect(ctx, x0 + 4, y0 + 21, 54, 1, PAL.wht);

  // half-wiped ghosting, so the surface is not a blank slab. The lower smudge sits exactly where
  // the tally goes, and a smear behind a row of status marks reads as dirt on the screen.
  rect(ctx, x0 + 38, y0 + 6, 16, 3, PAL.pa2, 0.4);
  if (bare) rect(ctx, x0 + 42, y0 + 16, 12, 2, PAL.pa2, 0.3);

  const lines = state.lines;
  const nLines = Math.min(lines.length, bare ? BOARD_LINE_Y.length : 2);
  for (let i = 0; i < nLines; i++) {
    const s = fitLine(lines[i] ?? '', BOARD_TEXT_W);
    if (s.length === 0) continue;
    drawText(ctx, s, x0 + BOARD_TEXT_X, y0 + BOARD_LINE_Y[i], i === 0 ? PAL.out : PAL.ou2);
    // The heading rule is a bare-lines flourish only: in the state layout it lands on top of the
    // second line, which is a collision the three-line board could afford and this one cannot.
    if (i === 0 && bare) {
      const w = Math.min(BOARD_TEXT_W, textWidth(s));
      rect(ctx, x0 + BOARD_TEXT_X, y0 + BOARD_LINE_Y[i] + 6, w, 1, PAL.sc2);
    }
  }

  if (!bare) {
    // With one line of task the whole status block rides up into the empty second line, which is
    // the difference between a board with air in it and a board with a gap at the bottom.
    const markBase = y0 + (lines.length >= 2 ? 19 : 13);
    drawTally(ctx, x0 + BOARD_TEXT_X, markBase, BOARD_TEXT_W, [
      { n: Math.max(0, Math.round(state.done ?? 0)), color: PAL.ok, h: 3 },
      { n: Math.max(0, Math.round(state.live ?? 0)), color: PAL.acc, h: 2 },
      { n: Math.max(0, Math.round(state.failed ?? 0)), color: PAL.err, h: 3 },
    ]);

    // Spend, as a rule along the bottom lip of the board — 2 rows, 56 wide, no number. It sits
    // clear of the pens in the tray below it, so it is the one status element that can always run
    // the board's full width no matter how crowded the surface gets.
    if (state.spend !== undefined) {
      const s = clamp01(state.spend);
      rect(ctx, x0 + 3, y0 + 22, 56, 2, PAL.ou2);
      const w = Math.round(56 * s);
      if (w > 0) rect(ctx, x0 + 3, y0 + 22, w, 2, s > 0.8 ? PAL.wrn : PAL.acc);
    }
  }

  // marker tray, overhanging both ends, with two pens lying in it
  rect(ctx, x0 - 2, y0 + 26, 66, 3, PAL.me2);
  rect(ctx, x0 - 2, y0 + 26, 66, 1, PAL.me3);
  rect(ctx, x0 - 2, y0 + 28, 66, 1, PAL.out);
  rect(ctx, x0 + 8, y0 + 24, 9, 2, PAL.po2);
  rect(ctx, x0 + 8, y0 + 24, 9, 1, PAL.pot);
  rect(ctx, x0 + 21, y0 + 24, 9, 2, PAL.bl2);
  rect(ctx, x0 + 21, y0 + 24, 9, 1, PAL.met);
  rect(ctx, x0, y0 + 29, 62, 1, PAL.shd, 0.4);
}

// ---------------------------------------------------------------- wall art

/** Per-variant footprints, so the preview and the scene can place them without guessing. */
export const WALL_ART_SIZE = [
  { w: 22, h: 16 },
  { w: 24, h: 17 },
  { w: 15, h: 20 },
] as const;

/**
 * Three framed pictures, chosen by `variant`: an abstract, a landscape, and an unframed poster.
 *
 * They differ in silhouette as well as in content — two of them are landscape-format in wood, one
 * is a tall paper poster with no frame at all. Three identical rectangles with different fills
 * read as one repeated prop; three different outlines read as three things somebody hung up.
 */
export function drawWallArt(
  ctx: CanvasRenderingContext2D,
  cx: number,
  yBase: number,
  variant: number,
): void {
  const v = ((Math.round(variant) % 3) + 3) % 3;
  const size = WALL_ART_SIZE[v];
  const x0 = Math.round(cx) - Math.floor(size.w / 2);
  // The frame stops one row short of `yBase`; that last row is its contact shadow, which is what
  // makes `yBase` honestly "the bottom row this object occupies".
  const y0 = Math.round(yBase) - size.h;

  if (v === 0) {
    rect(ctx, x0, y0, 22, 16, PAL.out);
    rect(ctx, x0 + 1, y0 + 1, 20, 14, PAL.wdf);
    rect(ctx, x0 + 1, y0 + 1, 20, 1, PAL.wdl);
    rect(ctx, x0 + 1, y0 + 14, 20, 1, PAL.wdd);
    rect(ctx, x0 + 3, y0 + 3, 16, 10, PAL.pap);
    rect(ctx, x0 + 4, y0 + 4, 5, 8, PAL.pot);
    rect(ctx, x0 + 10, y0 + 6, 4, 6, PAL.sc2);
    rect(ctx, x0 + 15, y0 + 4, 3, 5, PAL.lf1);
    rect(ctx, x0 + 10, y0 + 4, 8, 1, PAL.out);
    rect(ctx, x0 + 4, y0 + 10, 6, 1, PAL.out);
    rect(ctx, x0 + 15, y0 + 10, 3, 2, PAL.pa2);
  } else if (v === 1) {
    rect(ctx, x0, y0, 24, 17, PAL.out);
    rect(ctx, x0 + 1, y0 + 1, 22, 15, PAL.wdt);
    rect(ctx, x0 + 1, y0 + 1, 22, 1, PAL.wdl);
    rect(ctx, x0 + 1, y0 + 15, 22, 1, PAL.wdd);
    rect(ctx, x0 + 3, y0 + 3, 18, 11, PAL.ou2);
    rect(ctx, x0 + 4, y0 + 4, 16, 9, PAL.day); // sky
    rect(ctx, x0 + 4, y0 + 4, 16, 3, PAL.sc3, 0.55);
    disc(ctx, x0 + 16, y0 + 6, 1.8, PAL.lmp);
    // two stepped ridges, the far one cooler
    for (let i = 0; i < 16; i++) {
      const far = 3 + Math.round(1.6 * Math.sin(i / 2.4));
      rect(ctx, x0 + 4 + i, y0 + 4 + far, 1, 9 - far, PAL.lf2);
    }
    for (let i = 0; i < 16; i++) {
      const near = 6 + Math.round(1.4 * Math.sin(1.4 + i / 3.1));
      rect(ctx, x0 + 4 + i, y0 + 4 + near, 1, 9 - near, PAL.lf1);
    }
    rect(ctx, x0 + 4, y0 + 12, 16, 1, PAL.sc2);
  } else {
    rect(ctx, x0, y0, 15, 20, PAL.out);
    rect(ctx, x0 + 1, y0 + 1, 13, 18, PAL.pap);
    disc(ctx, x0 + 7, y0 + 7, 4.4, PAL.pot);
    disc(ctx, x0 + 6, y0 + 6, 1.6, PAL.po2);
    rect(ctx, x0 + 3, y0 + 14, 9, 2, PAL.out);
    rect(ctx, x0 + 3, y0 + 17, 6, 1, PAL.gry);
    rect(ctx, x0 + 11, y0 + 2, 2, 2, PAL.sc2);
  }

  rect(ctx, x0 + 1, y0 + size.h, size.w - 1, 1, PAL.shd, 0.4);
}

// ---------------------------------------------------------------- clock

/**
 * A wall clock, 13 across. `turn` is 0..1 for a full twelve hours, so the hour hand makes one
 * revolution over that range and the minute hand makes twelve.
 */
export function drawClock(ctx: CanvasRenderingContext2D, cx: number, yBase: number, turn: number): void {
  const x = Math.round(cx);
  const cy = Math.round(yBase) - 7;

  disc(ctx, x, cy, 6.4, PAL.out);
  disc(ctx, x, cy, 5.4, PAL.me2);
  disc(ctx, x, cy, 4.9, PAL.me3);
  disc(ctx, x, cy, 4.4, PAL.pap);

  // A highlight in the upper left only. The first version washed the whole top of the face with
  // `wht` and swallowed both the ticks and the hands — a clock you cannot read the hands on is a
  // white circle, which the room already has enough of.
  rect(ctx, x - 3, cy - 3, 3, 1, PAL.wht, 0.45);
  rect(ctx, x - 4, cy - 2, 2, 1, PAL.wht, 0.45);

  // Quarter ticks, full-strength. Twelve gets two pixels so the dial has an up.
  rect(ctx, x, cy - 4, 1, 2, PAL.out);
  rect(ctx, x + 3, cy, 1, 1, PAL.out);
  rect(ctx, x, cy + 3, 1, 1, PAL.out);
  rect(ctx, x - 3, cy, 1, 1, PAL.out);

  // Hour hand short and doubled to read as the fat one; minute hand long and thin.
  const tt = turn - Math.floor(turn);
  const hAng = tt * Math.PI * 2;
  needle(ctx, x, cy, hAng, 2.2, PAL.out);
  needle(ctx, x, cy + 1, hAng, 1.6, PAL.out);
  needle(ctx, x, cy, tt * 12 * Math.PI * 2, 3.5, PAL.out);
  rect(ctx, x, cy, 1, 1, PAL.out);

  rect(ctx, x - 5, yBase, 11, 1, PAL.shd, 0.35);
}

// ---------------------------------------------------------------- vent

/** A ceiling duct grille — 16 x 9, the small detail that says "this is a building". */
export function drawVent(ctx: CanvasRenderingContext2D, cx: number, yBase: number): void {
  const x0 = Math.round(cx) - 8;
  const y0 = Math.round(yBase) - 9;

  rect(ctx, x0, y0, 16, 9, PAL.out);
  rect(ctx, x0 + 1, y0 + 1, 14, 7, PAL.me2);
  rect(ctx, x0 + 1, y0 + 1, 14, 1, PAL.me3);
  for (let i = 0; i < 3; i++) {
    const y = y0 + 2 + i * 2;
    rect(ctx, x0 + 2, y, 12, 1, PAL.blk);
    rect(ctx, x0 + 2, y + 1, 12, 1, PAL.met);
  }
  rect(ctx, x0 + 2, y0 + 1, 1, 1, PAL.ou2);
  rect(ctx, x0 + 13, y0 + 1, 1, 1, PAL.ou2);
  rect(ctx, x0 + 1, y0 + 9, 15, 1, PAL.shd, 0.4);
}

// ---------------------------------------------------------------- rug

const RUG_RX = 44;
const RUG_RY = 20;

/**
 * The weave: a dashed diagonal lattice rather than scattered pixels.
 *
 * Random speckle at this scale reads as dirt on the screen. A regular two-pixel dash running on a
 * diagonal reads as a direction of weave, which is what a rug actually has.
 */
const weave = (a: string, b: string, px: number, py: number): string =>
  ((px >> 1) + py) % 4 === 0 ? b : a;

function rugColor(r: number, px: number, py: number): string {
  if (r > 0.975) return PAL.out; // the silhouette, so the rug has an edge against any floor tone
  if (r > 0.9) return ((px + py) & 3) < 2 ? PAL.pa2 : PAL.po2; // braided binding
  if (r > 0.86) return PAL.ou2; // a dark stop-line, or the braid bleeds into the field
  if (r > 0.8) return PAL.pa2;
  if (r > 0.52) return weave(PAL.pot, PAL.po2, px, py);
  if (r > 0.46) return PAL.pa2;
  if (r > 0.4) return PAL.po2;
  if (r > 0.16) return weave(PAL.po2, PAL.pot, px, py);
  if (r > 0.1) return PAL.pa2;
  return PAL.pot; // a small solid medallion — the diamond that used to sit here read as a spill
}

/**
 * The round rug under the roundtable — **centre anchored**, 87 x 40.
 *
 * An ellipse rather than a circle, because the floor is seen from a raised three-quarter angle and
 * a true circle down there would read as a disc standing on edge. Rows are emitted as merged runs:
 * per-pixel fills would be three and a half thousand calls a frame for one prop.
 */
export function drawRug(ctx: CanvasRenderingContext2D, cx: number, cy: number): void {
  const ox = Math.round(cx);
  const oy = Math.round(cy);

  for (let iy = 0; iy < RUG_RY * 2; iy++) {
    const py = oy - RUG_RY + iy;
    const ny = (iy - (RUG_RY - 0.5)) / RUG_RY;
    const span = 1 - ny * ny;
    if (span <= 0) continue;
    const half = Math.floor(RUG_RX * Math.sqrt(span));
    if (half <= 0) continue;

    let runColor = '';
    let runStart = -half;
    for (let ix = -half; ix <= half; ix++) {
      const nx = ix / RUG_RX;
      const c = rugColor(Math.sqrt(nx * nx + ny * ny), ox + ix, py);
      if (c !== runColor) {
        if (runColor !== '') rect(ctx, ox + runStart, py, ix - runStart, 1, runColor);
        runColor = c;
        runStart = ix;
      }
    }
    if (runColor !== '') rect(ctx, ox + runStart, py, half + 1 - runStart, 1, runColor);
  }

  // The rug lies on the floor, so it gets contact shadow along its lower arc rather than an
  // all-round silhouette.
  for (let iy = RUG_RY; iy < RUG_RY * 2; iy++) {
    const ny = (iy - (RUG_RY - 0.5)) / RUG_RY;
    const span = 1 - ny * ny;
    if (span <= 0) continue;
    const half = Math.floor(RUG_RX * Math.sqrt(span));
    if (half <= 0) continue;
    rect(ctx, ox - half, oy - RUG_RY + iy + 1, half * 2 + 1, 1, PAL.shd, 0.1);
  }
}

// ---------------------------------------------------------------- ceiling lamp

/** Shade profile, top row first: a cone that widens as it descends. */
const SHADE_W = [8, 12, 15, 18, 20, 22, 22] as const;

/**
 * A pendant fixture hanging on the wall band: rod to the ceiling, a metal cone, a lit underside.
 *
 * The rod is drawn from canvas row 0 rather than from a fixed length, so the lamp always reaches
 * the ceiling no matter how high the caller hangs it. Warmth and glow scale with `night` — the
 * same fixture reads as switched-off metal at noon and as the room's light source at midnight.
 */
export function drawCeilingLamp(
  ctx: CanvasRenderingContext2D,
  cx: number,
  yBase: number,
  night: number,
): void {
  const n = clamp01(night);
  const x = Math.round(cx);
  const yb = Math.round(yBase);
  const shadeTop = yb - (SHADE_W.length + 1);

  // canopy and rod
  rect(ctx, x - 3, 0, 7, 2, PAL.me2);
  rect(ctx, x - 3, 0, 7, 1, PAL.me3);
  rect(ctx, x - 1, 2, 2, shadeTop - 2, PAL.me2);
  rect(ctx, x - 1, 2, 1, shadeTop - 2, PAL.met);

  // cone
  for (let i = 0; i < SHADE_W.length; i++) {
    const w = SHADE_W[i];
    const left = x - Math.floor(w / 2);
    const y = shadeTop + i;
    rect(ctx, left, y, w, 1, PAL.me2);
    rect(ctx, left, y, Math.max(2, Math.round(w * 0.4)), 1, PAL.met);
    rect(ctx, left, y, 1, 1, PAL.out);
    rect(ctx, left + w - 1, y, 1, 1, PAL.out);
  }

  const rimW = SHADE_W[SHADE_W.length - 1];
  const rimL = x - Math.floor(rimW / 2);
  rect(ctx, rimL, yb - 1, rimW, 1, PAL.out);
  rect(ctx, rimL + 1, yb, rimW - 2, 1, PAL.lmp, 0.5 + 0.5 * n);
  rect(ctx, rimL + 4, yb, rimW - 8, 1, PAL.wht, 0.3 + 0.45 * n);

  // The light it throws back onto the wall. Tight, and almost off at noon: a lamp glowing in
  // daylight reads as a bug, and at day the pool over teal came out an unpleasant green.
  pool(ctx, x, yb + 2, rimW - 4, 5, PAL.lmp, 0.06 + 0.4 * n, 4);
}

// ---------------------------------------------------------------- preview

/** A slice of the real room, at the real coordinates, which is the only honest test of the shell. */
function room(ctx: CanvasRenderingContext2D, night: number, t: number): void {
  drawWall(ctx, night, t);
  drawFloor(ctx, night);
  drawCeilingLamp(ctx, 110, 21, night);
  drawCeilingLamp(ctx, 248, 21, night);
  for (const wx of WINDOW_X) drawWindow(ctx, wx, 33, night, t);
  drawWhiteboard(ctx, 205, 33, ['ROUNDTABLE', 'PLAN · BUILD', 'SHIP IT']);
  drawWallArt(ctx, 316, 27, 0);
  drawDoor(ctx, 350, 40, 0.35);
  drawWallArt(ctx, 390, 25, 2);
  drawClock(ctx, 420, 27, 0.21);
  drawVent(ctx, 450, 13);
}

const BOARD_LINES = ['SPRINT 4', 'PIXEL OFFICE', 'DONE = SEEN'] as const;

/** The states the board actually has to survive, not the one that flatters it. */
const BOARD_TASK: BoardState = { lines: ['SHIP THE PIXEL', 'OFFICE'] };
const BOARD_OK: BoardState = { lines: ['SHIP THE PIXEL', 'OFFICE'], done: 5, live: 3, spend: 0.42 };
const BOARD_BAD: BoardState = {
  lines: ['REWRITE THE', 'FLOOR'],
  done: 4,
  live: 2,
  failed: 2,
  spend: 0.66,
};
const BOARD_FULL: BoardState = { lines: ['ONE LINE ONLY'], done: 11, live: 1, spend: 0.93 };

export const PREVIEW: PreviewItem[] = [
  { name: 'room-day', w: 460, h: 122, draw: (c, t) => room(c, 0, t) },
  { name: 'room-nite', w: 460, h: 122, draw: (c, t) => room(c, 1, t) },
  // The floor's failure mode is a *large-area* one — a shimmer you only see once several courses
  // and several board lengths are on screen at once — so it gets a cell nearly the canvas's own
  // width. Judged at anything smaller the old regular pitch looked fine, which is why it shipped.
  { name: 'floor-wide', w: 460, h: 128, bg: PAL.wal, draw: (c) => drawFloor(c, 0) },
  {
    name: 'win-day',
    w: 38,
    h: 34,
    bg: PAL.wal,
    frames: 4,
    frameMs: 420,
    draw: (c, t) => drawWindow(c, 19, 31, 0, t),
  },
  { name: 'win-dusk', w: 38, h: 34, bg: PAL.wal, draw: (c, t) => drawWindow(c, 19, 31, 0.55, t) },
  {
    name: 'win-nite',
    w: 38,
    h: 34,
    bg: PAL.wa3,
    frames: 4,
    frameMs: 620,
    draw: (c, t) => drawWindow(c, 19, 31, 1, t),
  },
  {
    name: 'door',
    w: 28,
    h: 36,
    bg: PAL.wal,
    frames: 4,
    frameMs: 300,
    draw: (c, t) => drawDoor(c, 14, 34, Math.floor(t / 300) / 3),
  },
  { name: 'board', w: 70, h: 34, bg: PAL.wal, draw: (c) => drawWhiteboard(c, 35, 31, BOARD_LINES) },
  { name: 'bd-task', w: 70, h: 34, bg: PAL.wal, draw: (c) => drawWhiteboard(c, 35, 31, BOARD_TASK) },
  { name: 'bd-ok', w: 70, h: 34, bg: PAL.wal, draw: (c) => drawWhiteboard(c, 35, 31, BOARD_OK) },
  { name: 'bd-fail', w: 70, h: 34, bg: PAL.wal, draw: (c) => drawWhiteboard(c, 35, 31, BOARD_BAD) },
  { name: 'bd-full', w: 70, h: 34, bg: PAL.wal, draw: (c) => drawWhiteboard(c, 35, 31, BOARD_FULL) },
  {
    name: 'clock',
    w: 18,
    h: 18,
    bg: PAL.wal,
    frames: 6,
    frameMs: 250,
    draw: (c, t) => drawClock(c, 9, 16, 0.04 + t / 3000),
  },
  { name: 'vent', w: 20, h: 13, bg: PAL.wal, draw: (c) => drawVent(c, 10, 11) },
  { name: 'art-0', w: 26, h: 19, bg: PAL.wal, draw: (c) => drawWallArt(c, 13, 17, 0) },
  { name: 'art-1', w: 28, h: 20, bg: PAL.wal, draw: (c) => drawWallArt(c, 14, 18, 1) },
  { name: 'art-2', w: 19, h: 23, bg: PAL.wal, draw: (c) => drawWallArt(c, 9, 21, 2) },
  { name: 'lamp-day', w: 28, h: 30, bg: PAL.wal, draw: (c) => drawCeilingLamp(c, 14, 18, 0) },
  { name: 'lamp-nite', w: 28, h: 30, bg: PAL.wa3, draw: (c) => drawCeilingLamp(c, 14, 18, 1) },
  { name: 'rug', w: 92, h: 44, bg: PAL.fl2, draw: (c) => drawRug(c, 46, 22) },
];
