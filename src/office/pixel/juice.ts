/**
 * juice.ts — the three moments the room used to let you miss.
 *
 * Everything else in `pixel/` draws a *state*: this desk is working, that person is walking, the
 * light is warm. States are what a room is made of, and they are also why a session can go
 * completely right while you are looking straight at it and you notice nothing. A tool call that
 * spun for nine seconds and came back green, an agent that finished the thing it was made for, a
 * parent handing a brief to a child it just created — each of those is one frame where a number
 * changes, and one frame is not something a human eye is built to catch.
 *
 * So this module draws *events*. Three of them, deliberately, rather than a dozen:
 *
 *   1. `finishBurst`  — an agent's work is done, at the desk it was done at.
 *   2. `verdictPop`   — a long-running call landed, and here is how it landed.
 *   3. `linkPulse`    — the brief travelling down a spawn edge, and arriving.
 *
 * Each one is built the way an animator builds a beat rather than the way a renderer builds a
 * frame: **anticipation** (a contraction, a squash, a charge), **release** (an overshoot past the
 * resting size, one bright frame), **follow-through** (things that were thrown keep going and fall,
 * things that were shoved wobble back), and **secondary motion** (the paper on the desk leaves it
 * because the desk was hit, not because paper was scheduled). Nothing here eases in a straight
 * line; the seal's scale is a hand-authored keyframe table, because eight sizes picked by hand read
 * better at thirteen pixels across than any curve sampled continuously and then rounded.
 *
 * The rules that everything else in this directory follows apply here without exception:
 *
 * **No `Math.random`, no `Date.now`.** Every scattered thing is a pure function of `(age, seed, i)`,
 * so a moment replayed from the timeline explodes exactly the way it did live. `hash2` below is the
 * only source of variety.
 *
 * **Whole pixels.** Every position is rounded once, from a continuous phase, and every alpha
 * falloff is a table of three or four hard steps. A shard drifting at a third of a pixel a frame
 * does not travel, it shimmers.
 *
 * **Reduced motion is a real answer, not an off switch.** Every entry point takes `still`, and
 * under it draws the *information* and none of the motion: the finish becomes a stamped seal on the
 * desk, the verdict becomes a badge at its resting size, the pulse becomes a packet parked at the
 * child's end of the line. Same events, same durations, nothing thrown, nothing scaled, nothing
 * that moves between one frame and the next. A viewer who cannot watch things fly still learns
 * everything the room knows.
 */
import { drawArt, PAL, rect, type Art } from './art';
import type { PreviewItem } from './preview';

const TAU = Math.PI * 2;

/**
 * A 32-bit integer hash, 0..1 — the module's whole supply of variety.
 *
 * Two inputs rather than one because every caller wants "particle `i` of event `seed`", and hashing
 * `seed * 31 + i` into a single stream makes two neighbouring desks throw visibly the same debris.
 */
function hash2(a: number, b: number): number {
  let x = (Math.imul(Math.floor(a) | 0, 374761393) + Math.imul(Math.floor(b) | 0, 668265263)) | 0;
  x = Math.imul(x ^ (x >>> 13), 1274126177);
  x ^= x >>> 16;
  return (x >>> 0) / 4294967296;
}

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

/**
 * An age that can be trusted.
 *
 * `NaN` and `Infinity` reach draw code more often than they should — a delta divided by a duration
 * somebody set to zero is all it takes — and every comparison against `NaN` is false, so a poisoned
 * age does not throw, it silently paints the *first* branch of every beat for ever. Returning `-1`
 * means "not a live event", and every entry point below returns immediately on it.
 */
const ageOf = (v: number): number => (Number.isFinite(v) && v >= 0 && v < 1 ? v : -1);

/** Picks a hard step out of a table from a 0..1 phase. Never interpolates — that is the point. */
function step<T>(table: readonly T[], p: number): T {
  const i = Math.floor(clamp01(p) * table.length);
  return table[i < table.length ? i : table.length - 1];
}

// --------------------------------------------------------------------------- shapes

/**
 * A filled ellipse of whole-pixel rows. The same construction as `art.pool`, minus the banding —
 * this one is a solid body (a seal, a spark head), not a falloff.
 */
function disc(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  rx: number,
  ry: number,
  color: string,
  alpha = 1,
): void {
  if (rx < 0 || ry < 0) return;
  for (let dy = -ry; dy <= ry; dy++) {
    const f = ry === 0 ? 0 : dy / ry;
    const half = Math.round(rx * Math.sqrt(Math.max(0, 1 - f * f)));
    rect(ctx, cx - half, cy + dy, half * 2 + 1, 1, color, alpha);
  }
}

/**
 * A one-pixel ellipse outline — the shock ring every beat here expands.
 *
 * Rows whose half-width jumps by more than one are filled across the jump rather than left as two
 * dots. Without that the near-horizontal top and bottom of a wide, flat ring come out as a dashed
 * arc with holes in it, which reads as a rendering fault rather than as a ring.
 */
function ringOutline(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  rx: number,
  ry: number,
  color: string,
  alpha = 1,
): void {
  if (rx < 1 || ry < 1 || alpha <= 0) return;
  let prev = -1;
  for (let dy = -ry; dy <= ry; dy++) {
    const f = dy / ry;
    const half = Math.round(rx * Math.sqrt(Math.max(0, 1 - f * f)));
    if (half <= 0) {
      rect(ctx, cx, cy + dy, 1, 1, color, alpha);
      prev = 0;
      continue;
    }
    const gap = prev < 0 ? 1 : Math.abs(half - prev);
    if (gap <= 1) {
      rect(ctx, cx - half, cy + dy, 1, 1, color, alpha);
      rect(ctx, cx + half, cy + dy, 1, 1, color, alpha);
    } else {
      const lo = Math.min(half, prev);
      rect(ctx, cx - half, cy + dy, gap + 1, 1, color, alpha);
      rect(ctx, cx + lo, cy + dy, gap + 1, 1, color, alpha);
    }
    prev = half;
  }
}

// --------------------------------------------------------------------------- the marks

/**
 * The two verdicts, as chunky two-pixel strokes.
 *
 * Drawn as `Art` rather than as a run of `fillRect`s so that a wrong pixel is visible in the source.
 * Both are `x` — the one character neither of them maps to a `Look` slot — and are painted through
 * `drawArt`'s `tint`, once dark and offset for the shadow, once bright on top.
 */
const TICK: Art = {
  rows: [
    '......#', //
    '.....##',
    '....##.',
    '#..##..',
    '.####..',
    '..##...',
  ],
  map: { '#': 'wht' },
};

const CROSS: Art = {
  rows: [
    '##...##', //
    '.##.##.',
    '..###..',
    '...#...',
    '..###..',
    '.##.##.',
    '##...##',
  ],
  map: { '#': 'wht' },
};

/** The mark, with a one-pixel drop shadow so it survives sitting on a saturated status colour. */
function drawMark(ctx: CanvasRenderingContext2D, ok: boolean, cx: number, cy: number): void {
  const art = ok ? TICK : CROSS;
  const x = cx - 3;
  const y = cy - (ok ? 3 : 3);
  drawArt(ctx, art, x, y + 1, { tint: PAL.out, alpha: 0.55 });
  drawArt(ctx, art, x, y, { tint: PAL.wht });
}

// --------------------------------------------------------------------------- 1. the finish

/** How long a finish flourish runs, in milliseconds. The scene divides by this to get an age. */
export const FINISH_MS = 1400;

/** Shards thrown. Twelve reads as a burst; six reads as a mistake and twenty as a fog. */
const SHARD_N = 12;
/** Sheets that lift off the desk at most, however deep the pile actually is. */
const PAPER_MAX = 5;

/** Alpha steps a thrown shard dies through. Four hard stages, never a ramp. */
const SHARD_FADE = [1, 1, 0.82, 0.5, 0.24] as const;
/** …and a lifting sheet, which has longer to go and so gets a gentler tail. */
const PAPER_FADE = [1, 1, 1, 0.7, 0.35] as const;

export type FinishOpts = {
  /** 0..1 over `FINISH_MS`. Anything outside that draws nothing. */
  age: number;
  /** The finishing agent's own colour, so a burst is identifiably *theirs*. */
  tint: string;
  /** How it ended. A failure gets the same beats in `err` — a bad ending is still an ending. */
  ok: boolean;
  /** Sheets on the desk. They are what lifts off, so a cheap agent's finish is a quieter one. */
  papers: number;
  seed: number;
  /** Reduced motion: a stamped seal on the desk instead of a burst. */
  still?: boolean;
};

/**
 * An agent's work landing, at the desk it landed on. `yBase` is the desk's own top surface — the row
 * the keyboard and the paper sit on — so the burst comes off the desk rather than out of the air.
 *
 * Beat by beat:
 *
 * **0 – 0.10, the charge.** A wide bar of warm light on the desk top *pulls inward*, from twenty-two
 * pixels to six. Anticipation is the opposite of the action, and the action is going to be
 * everything flying apart, so the room first gathers itself into a point. Two frames at sixty.
 *
 * **0.10 – 0.16, the hit.** One deliberately blown-out frame: a white bar the width of the desk and
 * a three-band white pool over it. A single frame of overexposure is the cheapest thing in
 * animation and it is what makes a burst feel like it had force behind it.
 *
 * **0.10 – 0.52, the ring.** A flat ellipse ring expands across the desk in whole-pixel steps —
 * `ok` or `err`, with a second white ring inside it for the first half. Flat, not round, because it
 * is lying on a surface seen from above and in front.
 *
 * **0.10 – 0.65, the shards.** Twelve of them on a fan, thrown up and out, pulled back down by a
 * squared term. They are the follow-through: the ring is the impact, the shards are what the impact
 * did. Coloured in threes — the agent's tint, the verdict, and white — so the burst carries whose
 * it is and how it went without a word.
 *
 * **0.06 – 1.00, the paper.** The stack on the desk lifts off and drifts up out of frame, each
 * sheet flipping between three drawn frames — flat, edge-on, tilted — and the whole set staggered so
 * they do not rise as a slab. This is the secondary motion, and it is the part that means something:
 * the paper is the room's own picture of what this agent spent, and at the end of the work it leaves
 * the desk. A desk that cost nothing has nothing to lift, and its finish is quieter.
 */
export function finishBurst(
  ctx: CanvasRenderingContext2D,
  cx: number,
  yBase: number,
  o: FinishOpts,
): void {
  const u = ageOf(o.age);
  if (u < 0) return;
  const x0 = Math.round(cx);
  const y0 = Math.round(yBase);
  const verdict = o.ok ? PAL.ok : PAL.err;

  if (o.still) {
    finishSeal(ctx, x0, y0, u, o.ok);
    return;
  }

  // --- the charge -----------------------------------------------------------------
  if (u < 0.10) {
    const p = u / 0.10;
    const w = Math.round(22 - 16 * p);
    rect(ctx, x0 - (w >> 1), y0 - 1, w, 1, PAL.lmp, 0.5 + 0.5 * p);
    rect(ctx, x0 - (w >> 1), y0 - 2, w, 1, PAL.wht, 0.25 + 0.55 * p);
  }

  // --- the hit --------------------------------------------------------------------
  if (u >= 0.10 && u < 0.16) {
    const p = (u - 0.10) / 0.06;
    disc(ctx, x0, y0 - 2, 24, 6, PAL.wht, 0.55 * (1 - p) + 0.2);
    rect(ctx, x0 - 22, y0 - 1, 45, 2, PAL.wht, 0.9 - 0.4 * p);
    rect(ctx, x0 - 26, y0, 53, 1, verdict, 0.8);
  }

  // --- the ring -------------------------------------------------------------------
  if (u >= 0.10 && u < 0.52) {
    const p = (u - 0.10) / 0.42;
    const a = step([1, 0.75, 0.5, 0.26], p);
    ringOutline(ctx, x0, y0 - 1, Math.round(5 + p * 30), Math.round(2 + p * 12), verdict, a);
    if (p < 0.45) {
      ringOutline(ctx, x0, y0 - 1, Math.round(3 + p * 22), Math.round(1 + p * 9), PAL.wht, a * 0.9);
    }
  }

  // --- the shards -----------------------------------------------------------------
  if (u >= 0.10 && u < 0.75) {
    const p = (u - 0.10) / 0.65;
    const a = step(SHARD_FADE, p);
    for (let i = 0; i < SHARD_N; i++) {
      const h1 = hash2(o.seed, i * 3 + 1);
      const h2 = hash2(o.seed, i * 3 + 2);
      // A fan across the upper half, evenly laddered with a small per-shard nudge. Hashing the
      // angle outright clumps three shards into one direction and leaves a bald quarter.
      const ang = Math.PI * (0.08 + 0.84 * (i / (SHARD_N - 1))) + (h1 - 0.5) * 0.22;
      const v = 0.62 + h2 * 0.72;
      const px = x0 + Math.round(Math.cos(ang) * v * p * 36);
      const py = y0 - 2 - Math.round(Math.sin(ang) * v * p * 26) + Math.round(p * p * 30);
      if (py > y0 + 3) continue; // landed and buried
      const w = p < 0.4 ? 2 : 1;
      const color = i % 3 === 0 ? o.tint : i % 3 === 1 ? verdict : PAL.wht;
      rect(ctx, px - (w >> 1), py, w, 1, color, a);
    }
  }

  // --- the paper ------------------------------------------------------------------
  const sheets = Math.min(PAPER_MAX, Math.max(0, Math.round(o.papers)));
  for (let j = 0; j < sheets; j++) {
    const lead = j * 0.09;
    const pp = (u - 0.06 - lead) / (0.9 - lead);
    if (pp <= 0 || pp >= 1) continue;
    const a = step(PAPER_FADE, pp);
    // Sheets come off the left-hand clutter slot, which is where `scene.ts` stacks them.
    const px = x0 - 16 + Math.round(Math.sin(pp * 3.4 + j * 1.7) * (2 + pp * 8));
    const py = Math.max(2, y0 - 3 - Math.round(pp * 44));
    const f = (Math.floor(pp * 11) + j) % 3;
    const [w, h] = f === 0 ? [4, 3] : f === 1 ? [2, 3] : [3, 2];
    rect(ctx, px - (w >> 1), py, w, h, PAL.pap, a);
    rect(ctx, px - (w >> 1), py + h - 1, w, 1, PAL.pa2, a);
  }
}

/**
 * The finish as a viewer who asked for reduced motion gets it: a seal stamped on the desk.
 *
 * It appears when the work finished and goes when the moment is over, exactly like the burst, and
 * in between it does not move, scale or throw anything — every frame of it is byte-identical. The
 * event is still legible (this desk finished, and this is how it went); only the spectacle is gone.
 */
function finishSeal(
  ctx: CanvasRenderingContext2D,
  x0: number,
  y0: number,
  u: number,
  ok: boolean,
): void {
  const a = u > 0.85 ? step([0.7, 0.35], (u - 0.85) / 0.15) : 1;
  const cy = y0 - 6;
  rect(ctx, x0 - 6, cy - 5, 13, 11, PAL.out, a);
  rect(ctx, x0 - 5, cy - 4, 11, 9, ok ? PAL.ok : PAL.err, a);
  rect(ctx, x0 - 5, cy + 4, 11, 1, PAL.shd, a * 0.3);
  const prev = ctx.globalAlpha;
  ctx.globalAlpha = prev * a;
  drawMark(ctx, ok, x0, cy);
  ctx.globalAlpha = prev;
}

// --------------------------------------------------------------------------- 2. the verdict

/** How long a verdict seal holds, in milliseconds. Under a second and a half, then gone. */
export const VERDICT_MS = 1300;

/**
 * The seal's scale, as hand-placed keyframes rather than as a curve.
 *
 * `rx`/`ry` are the half-axes in whole pixels and `dy` is the rise. Read with `step`, so the seal
 * *snaps* between eight drawn sizes — which at thirteen pixels across is the difference between an
 * animation and a smear. The shape of the table is the whole performance:
 *
 *   - `1x1`  a spark, one frame, so the pop has somewhere to come from
 *   - `5x1`  **squash** — flat and wide, the charge
 *   - `3x7`  **stretch** — tall and thin, the launch
 *   - `7x6`  **overshoot** — past the resting size, the moment it arrives
 *   - `5x7`  the bounce back under
 *   - `6x6`  rest, and then a slow drift upward while it holds
 *
 * A linear ramp from nothing to full size hits every one of those sizes too, and reads as a circle
 * being resized. What makes it land is that it goes *past* and comes back.
 */
type SealKey = { u: number; rx: number; ry: number; dy: number };

const SEAL_KEYS: readonly SealKey[] = [
  { u: 0.0, rx: 1, ry: 1, dy: 0 },
  { u: 0.05, rx: 5, ry: 1, dy: 0 },
  { u: 0.1, rx: 3, ry: 7, dy: -3 },
  { u: 0.17, rx: 7, ry: 6, dy: -5 },
  { u: 0.24, rx: 5, ry: 7, dy: -6 },
  { u: 0.31, rx: 6, ry: 6, dy: -7 },
  { u: 0.44, rx: 6, ry: 6, dy: -8 },
  { u: 0.66, rx: 6, ry: 6, dy: -9 },
  { u: 0.85, rx: 6, ry: 6, dy: -11 },
];

/** The resting keyframe — what a still viewer is shown, held. */
const SEAL_REST = SEAL_KEYS[6];

/**
 * The last keyframe whose start has passed. A plain backward scan rather than `findLast`, which is
 * ES2023 and not in this project's lib — nine entries scanned backwards is not a cost worth a
 * target bump.
 */
function sealKey(u: number): SealKey {
  for (let i = SEAL_KEYS.length - 1; i >= 0; i--) if (u >= SEAL_KEYS[i].u) return SEAL_KEYS[i];
  return SEAL_KEYS[0];
}

/** Rays in the corona. Eight, so it reads as a burst and not as a compass rose. */
const CORONA_N = 8;

export type VerdictOpts = {
  /** 0..1 over `VERDICT_MS`. */
  age: number;
  /** Green tick or red cross. */
  ok: boolean;
  seed: number;
  /** Reduced motion: the badge at its resting size, held, with no corona and no ring. */
  still?: boolean;
};

/**
 * A verdict landing over somebody's head. `yBase` is the row just above the head — the same anchor
 * `emotePop` takes, so the two can never disagree about where a reaction goes.
 *
 * **0 – 0.10, squash.** A dot flattens into a wide bar. Anticipation, and a frame of it is enough.
 *
 * **0.10 – 0.17, stretch and launch.** Tall, thin, rising. The stretch is what sells the speed: the
 * seal is moving fast enough that it is deforming.
 *
 * **0.17 – 0.31, the overshoot and the bounce.** It arrives *larger* than it will end up, squashes
 * once under its own arrival, and settles. Eight sizes total.
 *
 * **0.10 – 0.28, the corona and the shock ring.** Eight white rays firing outward, shortening as
 * they go, and a ring expanding past them. This is the decoration, and it is the whole of what
 * `still` removes.
 *
 * **0.31 – 0.85, the hold.** The mark is legible and the seal drifts up two pixels over half a
 * second — slow secondary motion, so the beat does not go dead while you are reading it.
 *
 * **0.85 – 1, out.** Three hard alpha steps. Never a fade to nothing over thirty frames.
 */
export function verdictPop(
  ctx: CanvasRenderingContext2D,
  cx: number,
  yBase: number,
  o: VerdictOpts,
): void {
  const u = ageOf(o.age);
  if (u < 0) return;

  const x0 = Math.round(cx);
  const base = Math.round(yBase);
  const still = o.still === true;
  // The last keyframe this age has reached. Written as a reverse scan rather than `findLast`
  // because the project's `lib` predates it, and a keyframe table of eight is not worth widening
  // the language target over.
  let k = SEAL_KEYS[0];
  for (let i = SEAL_KEYS.length - 1; i >= 0; i--) {
    const f = SEAL_KEYS[i];
    if (u >= f.u) {
      k = f;
      break;
    }
  }
  if (still) k = SEAL_REST;
  const alpha = u > 0.85 ? step([0.8, 0.45, 0.2], (u - 0.85) / 0.15) : 1;
  if (alpha <= 0) return;

  const cy = base - 8 + k.dy;
  const face = o.ok ? PAL.ok : PAL.err;

  const prev = ctx.globalAlpha;
  ctx.globalAlpha = prev * alpha;

  // The corona and the ring go under the seal, so the seal's own outline closes over them.
  if (!still && u >= 0.10 && u < 0.28) {
    const p = (u - 0.10) / 0.18;
    const reach = 9 + Math.round(p * 11);
    const len = 3 - Math.floor(p * 3);
    const a = step([1, 0.7, 0.4], p);
    for (let i = 0; i < CORONA_N; i++) {
      // Rays offset half a step off the axes, so none of them lies flat along the seal's own
      // horizon and gets read as part of the badge.
      const ang = (i + 0.5) * (TAU / CORONA_N) + hash2(o.seed, 5) * 0.4;
      const dx = Math.cos(ang);
      const dy = Math.sin(ang);
      for (let s = 0; s < Math.max(1, len); s++) {
        rect(
          ctx,
          x0 + Math.round(dx * (reach + s)),
          cy + Math.round(dy * (reach + s)),
          1,
          1,
          PAL.wht,
          a,
        );
      }
    }
    const r = 8 + Math.round(p * 12);
    ringOutline(ctx, x0, cy, r, r, PAL.wht, a * 0.7);
  }

  disc(ctx, x0, cy, k.rx + 1, k.ry + 1, PAL.out);
  disc(ctx, x0, cy, k.rx, k.ry, face);
  // A lit top and a shaded underside, so a flat status colour reads as an object with a side to it.
  if (k.rx >= 3 && k.ry >= 3) {
    rect(ctx, x0 - k.rx + 2, cy - k.ry, (k.rx - 2) * 2 + 1, 1, PAL.wht, 0.45);
    rect(ctx, x0 - k.rx + 2, cy + k.ry, (k.rx - 2) * 2 + 1, 1, PAL.shd, 0.35);
  }
  if (k.rx >= 4 && k.ry >= 4) drawMark(ctx, o.ok, x0, cy);

  ctx.globalAlpha = prev;
}

// --------------------------------------------------------------------------- 3. the handoff

/** Where in a spawn edge's life the packet sets off, and where it lands. */
const PULSE_FROM = 0.22;
const PULSE_TO = 0.72;
/** How long the landing pop at the child end runs after that. */
const LAND = 0.2;

/** The packet's trail, back along the line. Four pixels, hard steps, no smear. */
const TRAIL = [0.95, 0.62, 0.38, 0.2] as const;

/**
 * The brief travelling down a spawn edge, and arriving.
 *
 * `props.drawLink` already draws the edge itself — dotted, labelled, drawing in from the parent and
 * fading out. What it never had was the thing the edge is *for*: a fan-out is a parent handing work
 * to a child, and a static dotted line says two agents are related, not that something just moved
 * between them.
 *
 * So a packet runs the line. It sets off once the line has finished drawing in, eases in and out
 * across the half of the edge's life in the middle, and lands at the child exactly as the line
 * begins to fade — the delivery and the dissolve are the same beat. It is a white core with a
 * four-pixel tail in the parent's own colour, each pixel dropping a shadow underneath it for the
 * same reason `drawLink`'s dots do: this line crosses a plank floor, a desk and a person, and a
 * bare tinted pixel is legible over none of them.
 *
 * On arrival: a two-step ring at the child's head and five sparks thrown outward. Small — the child
 * is about to walk in through the door and get its own nameplate, and the pop only has to say *this
 * one, now*.
 *
 * Under `still` the packet is parked at the child's end for the whole life of the edge. That is the
 * honest static reading of "this brief went to that agent", and it moves not one pixel.
 */
export function linkPulse(
  ctx: CanvasRenderingContext2D,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  age: number,
  color: string,
  still = false,
): void {
  const u = ageOf(age);
  if (u < 0) return;

  const ax = Math.round(x0);
  const ay = Math.round(y0);
  const bx = Math.round(x1);
  const by = Math.round(y1);
  const dx = bx - ax;
  const dy = by - ay;
  const steps = Math.max(Math.abs(dx), Math.abs(dy), 1);

  if (still) {
    packet(ctx, bx, by, color, 1, false);
    return;
  }

  if (u >= PULSE_FROM && u < PULSE_TO) {
    const p = (u - PULSE_FROM) / (PULSE_TO - PULSE_FROM);
    // Ease in and out: the packet leaves slowly, crosses the room fast, and arrives slowly. A
    // constant-rate dot is a progress bar; this is a thing being thrown and caught.
    const e = p < 0.5 ? 2 * p * p : 1 - 2 * (1 - p) * (1 - p);
    const at = Math.round(steps * e);
    const px = ax + Math.round((dx * at) / steps);
    const py = ay + Math.round((dy * at) / steps);
    for (let k = TRAIL.length - 1; k >= 0; k--) {
      const back = Math.max(0, at - (k + 1) * 3);
      rect(ctx, ax + Math.round((dx * back) / steps), ay + Math.round((dy * back) / steps), 1, 1, color, TRAIL[k]);
    }
    packet(ctx, px, py, color, 1, true);
  }

  if (u >= PULSE_TO && u < PULSE_TO + LAND) {
    const p = (u - PULSE_TO) / LAND;
    const a = step([1, 0.6, 0.3], p);
    const r = 2 + Math.round(p * 7);
    ringOutline(ctx, bx, by, r, Math.max(1, Math.round(r * 0.8)), color, a);
    for (let i = 0; i < 5; i++) {
      const ang = Math.PI * (0.15 + 0.7 * (i / 4));
      rect(
        ctx,
        bx + Math.round(Math.cos(ang) * (r + 2)),
        by - Math.round(Math.sin(ang) * (r + 1)),
        1,
        1,
        PAL.wht,
        a,
      );
    }
  }
}

/** The packet head: a three-pixel plus in white over a tinted body, with a shadow row under it. */
function packet(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  color: string,
  alpha: number,
  bright: boolean,
): void {
  rect(ctx, x - 1, y + 1, 3, 1, PAL.out, alpha * 0.5);
  rect(ctx, x - 1, y, 3, 1, color, alpha);
  rect(ctx, x, y - 1, 1, 1, color, alpha);
  rect(ctx, x, y + 1, 1, 1, color, alpha);
  if (bright) rect(ctx, x, y, 1, 1, PAL.wht, alpha);
}

// --------------------------------------------------------------------------- preview

/** A desk to burst off, so the flourish can be judged against the surface it comes from. */
function deskStub(ctx: CanvasRenderingContext2D, cx: number, yBase: number): void {
  rect(ctx, cx - 22, yBase - 5, 45, 1, PAL.wdl);
  rect(ctx, cx - 22, yBase - 4, 45, 4, PAL.wdt);
  rect(ctx, cx - 22, yBase, 45, 5, PAL.wdf);
  rect(ctx, cx - 23, yBase - 5, 1, 11, PAL.out);
  rect(ctx, cx + 23, yBase - 5, 1, 11, PAL.out);
  rect(ctx, cx - 10, yBase - 16, 20, 11, PAL.blk);
  rect(ctx, cx - 8, yBase - 14, 16, 7, PAL.scr);
}

/** A dotted stand-in for `props.drawLink`, so the pulse can be seen riding a line it belongs to. */
function lineStub(ctx: CanvasRenderingContext2D, x0: number, y0: number, x1: number, y1: number): void {
  const steps = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0), 1);
  for (let i = 0; i <= steps; i += 3) {
    const x = x0 + Math.round(((x1 - x0) * i) / steps);
    const y = y0 + Math.round(((y1 - y0) * i) / steps);
    rect(ctx, x, y + 1, 1, 1, PAL.out, 0.55);
    rect(ctx, x, y, 1, 1, PAL.acc, 0.5);
  }
}

const DEMO_TINT = '#c86bd8';
const FIN_W = 78;
const FIN_H = 62;
const SEAL_W = 34;
const SEAL_H = 34;
const LINK_W = 96;
const LINK_H = 24;

export const PREVIEW: PreviewItem[] = [
  {
    name: 'finish-ok',
    w: FIN_W,
    h: FIN_H,
    frames: 9,
    frameMs: FINISH_MS / 9,
    bg: PAL.wa2,
    draw: (c, t) => {
      deskStub(c, FIN_W / 2, FIN_H - 6);
      finishBurst(c, FIN_W / 2, FIN_H - 11, {
        age: t / FINISH_MS,
        tint: DEMO_TINT,
        ok: true,
        papers: 4,
        seed: 21,
      });
    },
  },
  {
    name: 'finish-err',
    w: FIN_W,
    h: FIN_H,
    frames: 9,
    frameMs: FINISH_MS / 9,
    bg: PAL.wa2,
    draw: (c, t) => {
      deskStub(c, FIN_W / 2, FIN_H - 6);
      finishBurst(c, FIN_W / 2, FIN_H - 11, {
        age: t / FINISH_MS,
        tint: DEMO_TINT,
        ok: false,
        papers: 2,
        seed: 8,
      });
    },
  },
  {
    // The first three ninths of the life, one frame apart at 60fps, because the charge and the hit
    // are two frames each and a nine-frame strip flies straight over both of them.
    name: 'finish-hit',
    w: FIN_W,
    h: FIN_H,
    frames: 9,
    frameMs: 34,
    bg: PAL.wa2,
    draw: (c, t) => {
      deskStub(c, FIN_W / 2, FIN_H - 6);
      finishBurst(c, FIN_W / 2, FIN_H - 11, {
        age: t / FINISH_MS,
        tint: DEMO_TINT,
        ok: true,
        papers: 4,
        seed: 21,
      });
    },
  },
  {
    name: 'finish-bare',
    w: FIN_W,
    h: FIN_H,
    frames: 5,
    frameMs: FINISH_MS / 5,
    bg: PAL.wa2,
    draw: (c, t) => {
      deskStub(c, FIN_W / 2, FIN_H - 6);
      finishBurst(c, FIN_W / 2, FIN_H - 11, {
        age: t / FINISH_MS,
        tint: DEMO_TINT,
        ok: true,
        papers: 0,
        seed: 3,
      });
    },
  },
  {
    name: 'finish-still',
    w: FIN_W,
    h: FIN_H,
    frames: 5,
    frameMs: FINISH_MS / 5,
    bg: PAL.wa2,
    draw: (c, t) => {
      deskStub(c, FIN_W / 2, FIN_H - 6);
      finishBurst(c, FIN_W / 2, FIN_H - 11, {
        age: t / FINISH_MS,
        tint: DEMO_TINT,
        ok: true,
        papers: 4,
        seed: 21,
        still: true,
      });
    },
  },
  {
    name: 'verdict-ok',
    w: SEAL_W,
    h: SEAL_H,
    frames: 10,
    frameMs: VERDICT_MS / 10,
    bg: PAL.wa2,
    draw: (c, t) => verdictPop(c, SEAL_W / 2, SEAL_H - 2, { age: t / VERDICT_MS, ok: true, seed: 5 }),
  },
  {
    // The pop happens inside the first fifth of the life; at the strip rate above, three of its
    // eight drawn sizes fall between frames. This one is the anticipation and the overshoot alone.
    name: 'verdict-pop',
    w: SEAL_W,
    h: SEAL_H,
    frames: 10,
    frameMs: 34,
    bg: PAL.wa2,
    draw: (c, t) => verdictPop(c, SEAL_W / 2, SEAL_H - 2, { age: t / VERDICT_MS, ok: true, seed: 5 }),
  },
  {
    name: 'verdict-err',
    w: SEAL_W,
    h: SEAL_H,
    frames: 10,
    frameMs: VERDICT_MS / 10,
    bg: PAL.wa2,
    draw: (c, t) => verdictPop(c, SEAL_W / 2, SEAL_H - 2, { age: t / VERDICT_MS, ok: false, seed: 9 }),
  },
  {
    name: 'verdict-still',
    w: SEAL_W,
    h: SEAL_H,
    frames: 5,
    frameMs: VERDICT_MS / 5,
    bg: PAL.wa2,
    draw: (c, t) =>
      verdictPop(c, SEAL_W / 2, SEAL_H - 2, { age: t / VERDICT_MS, ok: true, seed: 5, still: true }),
  },
  {
    name: 'pulse',
    w: LINK_W,
    h: LINK_H,
    frames: 9,
    frameMs: 2200 / 9,
    bg: PAL.flr,
    draw: (c, t) => {
      lineStub(c, 6, 18, LINK_W - 7, 5);
      linkPulse(c, 6, 18, LINK_W - 7, 5, t / 2200, DEMO_TINT);
    },
  },
  {
    name: 'pulse-still',
    w: LINK_W,
    h: LINK_H,
    frames: 5,
    frameMs: 2200 / 5,
    bg: PAL.flr,
    draw: (c, t) => {
      lineStub(c, 6, 18, LINK_W - 7, 5);
      linkPulse(c, 6, 18, LINK_W - 7, 5, t / 2200, DEMO_TINT, true);
    },
  },
  {
    name: 'marks',
    w: 22,
    h: 12,
    bg: PAL.wa3,
    draw: (c) => {
      drawMark(c, true, 6, 5);
      drawMark(c, false, 16, 5);
    },
  },
];
