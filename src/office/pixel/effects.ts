/**
 * effects.ts — the air in the room.
 *
 * Everything here is atmosphere: steam off a mug, dust in a sunbeam, the wedge of daylight on the
 * floor, the cool spill of a monitor, the grade that turns day into night. It is also the module
 * most likely to ruin the picture, because "atmosphere" in a soft renderer means translucent haze,
 * and translucent haze on a 480x270 grid is mush.
 *
 * So the rule here is stricter than elsewhere: **every particle is a whole pixel at a whole
 * coordinate, and it moves in whole-pixel steps.** A mote drifting at a third of a pixel per frame
 * does not drift — the rasteriser rounds it to the same pixel three frames running and then jumps,
 * and what you see is a shimmer rather than motion. Positions are therefore floored/rounded once,
 * from a continuous phase, and alpha falloffs are quantised into three or four steps so the
 * boundaries stay visible as edges instead of dissolving into a gradient.
 *
 * And nothing is random. `Math.random()` would make the room un-replayable and would make two
 * frames of the same instant differ; `Date.now()` would make the animation depend on when you
 * looked. Every jitter comes from a small integer hash of `(seed, index)`, so a given `t` always
 * draws the same air.
 */
import { SCENE, WAYPOINTS } from '../engine';
import { PAL, PIX, pool, rect } from './art';
import type { PreviewItem } from './preview';

const TAU = Math.PI * 2;

/**
 * A 32-bit integer hash, returned as 0..1.
 *
 * This is the only source of "randomness" in the module. Two independent inputs rather than one
 * because almost every caller wants "particle `i` of emitter `seed`", and hashing `seed * 31 + i`
 * makes neighbouring emitters share particle patterns in a way the eye picks up immediately.
 */
function hash2(a: number, b: number): number {
  let x = (Math.imul(Math.floor(a) | 0, 374761393) + Math.imul(Math.floor(b) | 0, 668265263)) | 0;
  x = Math.imul(x ^ (x >>> 13), 1274126177);
  x ^= x >>> 16;
  return (x >>> 0) / 4294967296;
}

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);
/** Positive modulo — `%` keeps the sign of the dividend, which wraps particles off the wrong edge. */
const wrap = (v: number, n: number): number => ((v % n) + n) % n;

// --------------------------------------------------------------------------- particles

/** Fade steps for a rising wisp. Four hard steps, not a ramp. */
const STEAM_FADE = [0.95, 0.76, 0.5, 0.26] as const;

/**
 * Steam rising from `(cx, yBase)` — a mug, a kettle, a coffee machine.
 *
 * Five to eight individual pixels drifting sideways on a slow sine whose amplitude grows with
 * height, and dying off over the top third of the climb. Drawn as separate motes rather than as a
 * translucent plume on purpose: a plume at this resolution is a grey smear over the wall, and what
 * actually reads as steam is a handful of dots you can count.
 *
 * The phases are **spread evenly** (`i / n`) with only a small per-mote jitter, rather than being
 * hashed outright. Fully random phases clump — three motes land in the same two rows and the other
 * four are all in the faded tail, so the plume reads as a scatter of specks that happen to be near
 * a mug. An even ladder plus a per-mote period that is 15% off its neighbours' gives a wisp that
 * looks continuous close up and still drifts out of step over a few seconds.
 */
export function steam(
  ctx: CanvasRenderingContext2D,
  cx: number,
  yBase: number,
  t: number,
  seed: number,
  strength = 1,
): void {
  const s = clamp01(strength);
  if (s <= 0) return;
  const n = Math.max(5, Math.min(8, Math.round(5 + s * 3)));
  const rise = 15;

  for (let i = 0; i < n; i++) {
    const h1 = hash2(seed, i * 2 + 1);
    const h2 = hash2(seed, i * 2 + 2);
    const period = 1700 * (0.86 + h1 * 0.28);
    const p = wrap(t / period + i / n + h2 * 0.11, 1);

    // Whole-pixel rise: floor once, so the mote sits on a row for several frames and then steps.
    const y = yBase - 1 - Math.floor(p * rise);
    // Lateral drift opens up as it climbs — at the spout it is still a column.
    const amp = p * 2.4 + 0.3;
    const x = cx + Math.round(Math.sin(t / 820 + h1 * TAU + p * 2.1) * amp);

    // Full strength for the first half of the climb, then three hard steps to nothing.
    const step = p < 0.5 ? 0 : Math.min(3, Math.floor((p - 0.5) / 0.17) + 1);
    const a = STEAM_FADE[step] * s;
    if (a <= 0.05) continue;

    // The bottom of the plume is still a column of wet air, so it stays 2px wide; higher up it has
    // broken into single motes. Two widths, no interpolation between them.
    const w = p < 0.22 ? 2 : 1;
    rect(ctx, x - (w >> 1), y, w, 1, p < 0.5 ? PAL.wht : PAL.gry, a);
  }
}

/**
 * Motes hanging in the air inside a rect — the thing that makes a light shaft look like light.
 *
 * `density` is literally the mote count, and each mote's identity comes from its index alone (the
 * signature carries no seed), so the same rect always holds the same dust. They fall slowly and
 * wobble sideways, wrapping at the edges rather than being respawned, which keeps the count exactly
 * constant and the function pure in `t`.
 */
/**
 * Three depths, not a continuous range: near motes are bright white and fall fastest, far ones are
 * dim and cool and barely move. A smooth spread of alphas over thirty specks is just noise of
 * varying loudness; three tiers read as a volume of air with things at different distances in it.
 */
const DUST_TIERS = [
  { a: 1, fall: 0.014, color: PAL.wht },
  { a: 0.62, fall: 0.0085, color: PAL.day },
  { a: 0.38, fall: 0.005, color: PAL.day },
] as const;

export function dust(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  t: number,
  density: number,
  alpha: number,
): void {
  const n = Math.max(0, Math.round(density));
  if (n === 0 || w <= 0 || h <= 0 || alpha <= 0) return;

  for (let i = 0; i < n; i++) {
    const a1 = hash2(i, 11);
    const a2 = hash2(i, 23);
    const a3 = hash2(i, 37);
    // Only every third mote is a bright near one, so the field does not read as a starfield.
    const tier = DUST_TIERS[i % 3 === 0 ? 0 : 1 + (i % 2)];

    const py = y + wrap(Math.floor(a2 * h + t * tier.fall), h);
    const wobble = Math.round(Math.sin(t / (1500 + a1 * 1600) + a3 * TAU) * (1 + a2 * 2));
    const px = x + wrap(Math.floor(a3 * w) + wobble, w);

    rect(ctx, px, py, 1, 1, tier.color, alpha * tier.a);
  }
}

/**
 * Brightness of the four bands of a shaft, top to bottom.
 *
 * Separated enough for the steps to show, but deliberately **not** falling away to nothing. A wedge
 * whose last band is at 0.14 dissolves into the floor, and something that dissolves at its far end
 * is smoke; light stops at a line. Ending at 0.38 means the bottom row of the shaft is still clearly
 * brighter than the floor beside it, so the boundary of the lit patch is an edge you can point at.
 */
const SHAFT_BANDS = [1, 0.8, 0.58, 0.38] as const;
/** How much dimmer the two outer margins are than the core. One extra tone, hard-edged. */
const SHAFT_MARGIN = 0.45;
/** Rows per width step. The edge holds still for three rows, then jumps — a staircase, not a slope. */
const SHAFT_STEP_ROWS = 3;

/**
 * The hard-edged wedge of light falling from a window onto the floor.
 *
 * A trapezoid from `wTop` wide at `yTop` to `wBot` wide at `yBot`, painted one scanline at a time,
 * split into four discrete brightness bands down its length and two across its width — eight tones
 * total, every boundary a visible edge.
 *
 * Two things keep this from turning into an airbrushed cone, and the first draft of it had neither.
 *
 * **The runs do not overlap.** The obvious way to give a beam a hot centre is to paint the full
 * width, then paint a narrower core on top of it; with only source-over available that *compounds*
 * the two alphas, and a compounded alpha is a ramp — the boundary between "core over margin" and
 * "margin" ends up a few percent apart and dissolves. So the core and the two margins are painted
 * as three abutting runs at independent alphas, and every tone in the shaft is exactly one fill
 * deep.
 *
 * **The half-width is snapped to a multiple of two.** A trapezoid whose edge advances by a fraction
 * of a pixel per row grows one pixel every few rows in a ragged, uneven way, which is precisely
 * what an anti-aliased edge looks like. Snapping makes the edge advance in deliberate two-pixel
 * steps — a visible staircase, which is what a light shaft looks like when it is drawn rather than
 * rendered.
 */
export function lightShaft(
  ctx: CanvasRenderingContext2D,
  cx: number,
  yTop: number,
  yBot: number,
  wTop: number,
  wBot: number,
  color: string,
  alpha: number,
): void {
  const y0 = Math.round(yTop);
  const y1 = Math.round(yBot);
  const span = y1 - y0;
  if (span <= 0 || alpha <= 0) return;

  for (let py = y0; py < y1; py++) {
    const f = (py - y0) / span;
    const band = Math.min(SHAFT_BANDS.length - 1, Math.floor(f * SHAFT_BANDS.length));
    const a = alpha * SHAFT_BANDS[band];

    // Width is read off a row index quantised to SHAFT_STEP_ROWS, so the edge sits still for a few
    // rows and then jumps by a whole step instead of creeping outward a pixel at a time.
    const fq = Math.min(1, (Math.floor((py - y0) / SHAFT_STEP_ROWS) * SHAFT_STEP_ROWS) / span);
    const half = Math.max(2, Math.round((wTop + (wBot - wTop) * fq) / 4) * 2);
    // The core is snapped on the same 2px grid, so its staircase steps in sympathy with the outer
    // edge instead of beating against it.
    const core = Math.max(1, Math.round(half * 0.52 * 0.5) * 2);

    rect(ctx, cx - core, py, core * 2, 1, color, a);
    rect(ctx, cx - half, py, half - core, 1, color, a * SHAFT_MARGIN);
    rect(ctx, cx + core, py, half - core, 1, color, a * SHAFT_MARGIN);
  }
}

/**
 * The cool spill a monitor throws onto the desk and onto the face in front of it.
 *
 * Three bands rather than four: this pool is small, and a fourth band at this radius is a one-pixel
 * ring nobody can see that costs a fill. Tight on purpose — a wide screen glow washes the desk out
 * and the room loses the warm/cool split it is built on.
 */
export function screenGlow(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  rx: number,
  ry: number,
  strength: number,
): void {
  const s = clamp01(strength);
  if (s <= 0) return;
  pool(ctx, cx, cy, rx, ry, PAL.scg, s * 0.4, 3);
}

/**
 * Directions the puff throws, roughly a fan: out to the sides and a little up.
 *
 * `[dx, dy, wide]` — `wide` marks the two ground-level motes, which stay 2px across for the first
 * half of the puff's life. Without that the effect leaves the foot as five separate specks that
 * were never a single body of air; with it there is a visible shape that breaks apart.
 */
const PUFF_DIRS = [
  [-1, 0.06, 1],
  [1, 0.06, 1],
  [-0.72, -0.5, 0],
  [0.72, -0.5, 0],
  [0, -0.85, 0],
] as const;

/** Four hard alpha steps as the puff ages, so it dies in visible stages. */
const PUFF_FADE = [1, 0.82, 0.55, 0.28] as const;

/**
 * A small kick of floor dust under a foot, at ankle height. `age` runs 0 to 1 over the puff's life.
 *
 * Five pixels pushed outward along fixed directions, so the shape is the same every step and only
 * the radius changes — a puff whose particles also jitter reads as noise, not as displaced air.
 * Bright `wht` rather than `gry` on the ground pair: this lands on a mid-brown floor, and a grey
 * pixel on `fl3` is a pixel nobody sees.
 */
export function footPuff(ctx: CanvasRenderingContext2D, cx: number, yBase: number, age: number): void {
  if (age < 0 || age >= 1) return;
  const spread = 1 + age * 6;
  const a = PUFF_FADE[Math.min(PUFF_FADE.length - 1, Math.floor(age * PUFF_FADE.length))];

  for (const [dx, dy, wide] of PUFF_DIRS) {
    const px = cx + Math.round(dx * spread);
    const py = yBase + Math.round(dy * spread * 0.7) - 1;
    const w = wide && age < 0.5 ? 2 : 1;
    // Grown outward from the centre: a left-going mote widens leftward, a right-going one rightward,
    // so the puff stays symmetric about the foot instead of creeping one pixel to the right.
    rect(ctx, dx < 0 ? px - w + 1 : px, py, w, 1, wide ? PAL.wht : PAL.gry, a);
  }
}

/**
 * A four-point twinkle that grows and shrinks: a centre pixel, then arms at one pixel, then arms at
 * two. Three sizes only, because a star that interpolates its arms is a star that flickers.
 */
export function sparkle(ctx: CanvasRenderingContext2D, cx: number, cy: number, t: number, seed: number): void {
  const h1 = hash2(seed, 101);
  const period = 900 + h1 * 800;
  const p = wrap(t + hash2(seed, 202) * period, period) / period;
  const grow = Math.sin(p * Math.PI);
  if (grow < 0.1) return;

  rect(ctx, cx, cy, 1, 1, PAL.wht, 0.95);
  if (grow >= 0.4) {
    rect(ctx, cx - 1, cy, 1, 1, PAL.wht, 0.8);
    rect(ctx, cx + 1, cy, 1, 1, PAL.wht, 0.8);
    rect(ctx, cx, cy - 1, 1, 1, PAL.wht, 0.8);
    rect(ctx, cx, cy + 1, 1, 1, PAL.wht, 0.8);
  }
  if (grow >= 0.78) {
    rect(ctx, cx - 2, cy, 1, 1, PAL.day, 0.75);
    rect(ctx, cx + 2, cy, 1, 1, PAL.day, 0.75);
    rect(ctx, cx, cy - 2, 1, 1, PAL.day, 0.75);
    rect(ctx, cx, cy + 2, 1, 1, PAL.day, 0.75);
  }
}

// --------------------------------------------------------------------------- scalar drivers

/**
 * Screen brightness, 0..1. Mostly hovering just under 1 with an occasional short dip.
 *
 * The temptation is `0.5 + 0.5 * sin(t)`, which makes every monitor in the room strobe in unison
 * and looks like a fault rather than like a screen. Real ones sit steady and are momentarily
 * disturbed, so this is a shallow slow wave plus a rare 90ms dip chosen by hashing the current
 * time slot — occasional, irregular, and different for every seed.
 */
export function flicker(t: number, seed: number): number {
  const phase = hash2(seed, 7) * 9973;
  const u = t + phase;
  let v = 0.93 + 0.07 * Math.sin(u / 620 + hash2(seed, 13) * TAU);
  const slot = Math.floor(u / 90);
  const r = hash2(slot, seed);
  if (r > 0.96) v *= 0.58 + (r - 0.96) * 6;
  return clamp01(v);
}

/**
 * -1..1 on a 4-6 second cycle, for plants and anything else that should look like it is standing in
 * moving air. Two sines at an irrational-ish ratio so the motion never visibly repeats.
 */
export function sway(t: number, seed: number): number {
  const ph = hash2(seed, 31) * TAU;
  const period = 4200 + hash2(seed, 43) * 1800;
  const a = Math.sin((t / period) * TAU + ph);
  const b = Math.sin((t / (period * 0.61)) * TAU + ph * 1.7);
  return Math.max(-1, Math.min(1, a * 0.76 + b * 0.24));
}

/** 0..1 on a ~2.6 second cycle. The one-pixel lift of a torso, and the pulse of a standby light. */
export function breathe(t: number, seed: number): number {
  const ph = hash2(seed, 53) * 2600;
  return 0.5 - 0.5 * Math.cos(((t + ph) / 2600) * TAU);
}

/** How long an eye stays shut, and how coarsely blink opportunities are spaced. */
const BLINK_MS = 140;
const BLINK_SLOT = 640;

/**
 * True for a brief window, roughly every 3-6 seconds, with the spacing driven by the seed.
 *
 * Twelve agents blinking on one shared timer is the single most obvious way to make a room full of
 * people look like a room full of puppets, so both the slot boundaries (via a per-seed phase) and
 * the choice of which slots blink (via the hash) differ per seed. Result: irregular gaps that never
 * line up between two people.
 */
export function blinkOn(t: number, seed: number): boolean {
  const u = t + hash2(seed, 71) * 9973;
  const slot = Math.floor(u / BLINK_SLOT);
  if (hash2(slot, seed + 1) <= 0.85) return false;
  return wrap(u, BLINK_SLOT) < BLINK_MS;
}

// --------------------------------------------------------------------------- whole-canvas grades

/** One warm spot the night grade lifts back out of the dark: buffer x, buffer y, and its reach. */
type Warm = readonly [number, number, number];

/**
 * The engine's 1600x900 basis to buffer pixels — the renderer's flat x0.3, computed from the two
 * constants that decide it rather than written down as `0.3`.
 */
const S = PIX.w / SCENE.w;

/**
 * How far above its owner's chair a desk's warm pool sits, in buffer pixels.
 *
 * `scene.ts` puts a desk `0.052 * SCENE.h` above the seat and lays that desk's lamp pool two rows
 * below the desk's own base; this is those two numbers folded into the one distance a grade needs.
 * At a twenty-pixel reach the row is approximate anyway — it is the *column* that has to be right.
 */
const LAMP_ABOVE_SEAT = Math.round(0.052 * SCENE.h * S) - 2;

/** How far each kind of lamp's lift reaches: a pod desk, the wider manager desk, table, machine. */
const REACH = { pod: 20, manager: 22, table: 30, machine: 16 } as const;

/** A desk's lamp, from the chair that desk belongs to. */
const overDesk = (seat: { readonly x: number; readonly y: number }, reach: number): Warm => [
  Math.round(seat.x * S),
  Math.round(seat.y * S) - LAMP_ABOVE_SEAT,
  reach,
];

/**
 * The desks the floor plan draws, as warm spots: every pod chair, then the manager's.
 *
 * Derived from the engine's seating rather than restated, because the table this replaces was a
 * copy of a floor plan that has since been rebuilt. It warmed x 79 and 146 — which are now the
 * break corner and the bare floor between the left bank's two columns — and it had no entry at all
 * over the right-hand bank, so every night frame lit three patches of empty boards and left half
 * the room's desks dark. Nothing below is a coordinate, so that cannot happen again: move a chair
 * and its lamp moves with it.
 */
const DESK_LAMPS: readonly Warm[] = [
  ...WAYPOINTS.podSeats.map((seat) => overDesk(seat, REACH.pod)),
  overDesk(WAYPOINTS.managerSeat, REACH.manager),
];

/**
 * The roundtable, from the engine's own table places — the column the four seats are arranged
 * around, and the row halfway between the far one and the near one.
 */
const TABLE_LAMP: Warm = [
  Math.round(WAYPOINTS.tableN.x * S),
  Math.round(((WAYPOINTS.tableN.y + WAYPOINTS.tableS.y) / 2) * S),
  REACH.table,
];

/** The kitchen corner, from the spot an actor stands on to use the machine. */
const MACHINE_LAMP: Warm = [
  Math.round(WAYPOINTS.coffee.x * S),
  Math.round(WAYPOINTS.coffee.y * S),
  REACH.machine,
];

/**
 * Every warm light source in the room, in buffer pixels: the desks, plus the two places the room is
 * warm with no desk under it.
 *
 * The comment this replaces said the positions were "kept here rather than imported, because
 * `effects.ts` may not depend on another pixel module". That was not true of what the file does —
 * it has imported `./art` since it was written — and it is not what the contract says either:
 * `./art` is explicitly allowed, and `engine.ts` is not a pixel module at all. It is the floor plan
 * itself, which is precisely what a grade that has to know where the light is should be reading.
 * The rest of the old claim stands and is the reason this is a handful of pools rather than a light
 * model: a grade only needs to know roughly where the warmth is, not what furniture is under it.
 */
const LAMPS: readonly Warm[] = [...DESK_LAMPS, TABLE_LAMP, MACHINE_LAMP];

function nightGradeIn(ctx: CanvasRenderingContext2D, w: number, h: number, night: number): void {
  const n = clamp01(night);
  if (n <= 0) return;

  // "Multiply" with only source-over available: darken first, then tint cool. Flat passes, which
  // add no edges of their own and therefore cannot muddy anything underneath. The blue pass is the
  // heavier of the two on purpose — dimming alone gives a brown room with the lights off, and the
  // whole palette is built on a warm/cool split that only exists if night is actually *cool*.
  rect(ctx, 0, 0, w, h, PAL.shd, 0.28 * n);
  rect(ctx, 0, 0, w, h, PAL.wa3, 0.42 * n);
  // The ceiling end of the room loses its daylight first.
  rect(ctx, 0, 0, w, Math.round(h * 0.16), PAL.shd, 0.12 * n);

  // ...and the lamps come up to meet it. A lift, not a second sun — but it has to be visible, or
  // the night room is just a dark room and the warm/cool split the whole palette is built on dies.
  const sx = w / PIX.w;
  const sy = h / PIX.h;
  for (const [lx, ly, lr] of LAMPS) {
    pool(
      ctx,
      Math.round(lx * sx),
      Math.round(ly * sy),
      Math.max(3, Math.round(lr * sx)),
      Math.max(2, Math.round(lr * sy * 0.55)),
      PAL.lmp,
      0.26 * n,
      3,
    );
  }
}

/**
 * The whole-canvas day/night grade. 0 draws nothing at all; 1 is a cool deep-blue wash with the
 * lamps lifted back out of it.
 */
export function nightGrade(ctx: CanvasRenderingContext2D, night: number): void {
  nightGradeIn(ctx, PIX.w, PIX.h, night);
}

/**
 * Alpha of each nested frame, outermost first.
 *
 * Four rings, not five, and each roughly half the one outside it. The first version used five rings
 * an eighth of the canvas' height apart with alphas 0.17 / 0.12 / 0.078 / …, and rendered flat it
 * was indistinguishable from a radial gradient — which is the one thing the brief rules out. Wide
 * rings and a halving ratio put the steps where the eye can see them.
 */
const VIGNETTE_RINGS = [0.2, 0.11, 0.058, 0.028] as const;

function vignetteIn(ctx: CanvasRenderingContext2D, w: number, h: number, strength: number): void {
  const s = Math.max(0, strength);
  if (s <= 0) return;
  const th = Math.max(1, Math.round(Math.min(w, h) / 16));

  // Nested hollow frames rather than a radial falloff: a gradient here would be the one soft thing
  // in an otherwise hard-edged picture, and it shows.
  for (let i = 0; i < VIGNETTE_RINGS.length; i++) {
    const a = VIGNETTE_RINGS[i] * s;
    const o = i * th;
    const iw = w - o * 2;
    const ih = h - o * 2;
    if (iw <= 0 || ih <= 0) break;
    rect(ctx, o, o, iw, th, PAL.shd, a);
    rect(ctx, o, h - o - th, iw, th, PAL.shd, a);
    rect(ctx, o, o + th, th, ih - th * 2, PAL.shd, a);
    rect(ctx, w - o - th, o + th, th, ih - th * 2, PAL.shd, a);
  }

  // Corners carry extra weight, or the frames read as a border rather than as a vignette. Two
  // nested squares, each a whole number of ring-thicknesses, so their edges land on ring edges.
  for (const [mult, a] of [
    [5, 0.075],
    [3, 0.075],
    [1, 0.05],
  ] as const) {
    const size = th * mult;
    rect(ctx, 0, 0, size, size, PAL.shd, a * s);
    rect(ctx, w - size, 0, size, size, PAL.shd, a * s);
    rect(ctx, 0, h - size, size, size, PAL.shd, a * s);
    rect(ctx, w - size, h - size, size, size, PAL.shd, a * s);
  }
}

/** Darkened corners over the whole canvas. `strength` 0 draws nothing. */
export function vignette(ctx: CanvasRenderingContext2D, strength: number): void {
  vignetteIn(ctx, PIX.w, PIX.h, strength);
}

// --------------------------------------------------------------------------- preview

/**
 * A stand-in room, so the grades have something to grade. Preview-only.
 *
 * Its desks sit at the same canvas coordinates the lamp records use, so what the night cells show
 * is where the warm lift will actually land — a demo scene laid out somewhere else would make the
 * lift look like it lands on the floor at random.
 *
 * Which is also why it could never have caught the bug it was written to catch. Drawing a desk *at*
 * each lamp makes the two agree by construction: the room could drift out from under the table
 * entirely — and did — and this cell would still show a tidy pool on every desk. The check that
 * actually finds it is `npm run room`, where the desks come from the floor plan and the lamps from
 * here, and the only thing holding the two together is that both are now derived from the same
 * seating.
 */
function demoScene(ctx: CanvasRenderingContext2D, w: number, h: number, night: number): void {
  const sx = w / PIX.w;
  const sy = h / PIX.h;
  const wallH = Math.round(38 * sy);

  rect(ctx, 0, 0, w, wallH, PAL.wal);
  rect(ctx, 0, 0, w, 2, PAL.wa3);
  rect(ctx, 0, wallH - 2, w, 2, PAL.wtr);
  for (const wx of [72, 149, 278]) {
    const x = Math.round(wx * sx) - 6;
    rect(ctx, x - 1, 1, 14, wallH - 4, PAL.out);
    rect(ctx, x, 2, 12, wallH - 6, night > 0.5 ? PAL.wa3 : PAL.day, 0.92);
  }
  rect(ctx, 0, wallH, w, h - wallH, PAL.flr);
  for (let y = wallH + 4; y < h; y += 6) rect(ctx, 0, y, w, 1, PAL.fl4);
  // rug, contract §4: x 262..348, y 154..232
  rect(ctx, Math.round(262 * sx), Math.round(154 * sy), Math.round(86 * sx), Math.round(78 * sy), PAL.wa2);

  // Every desk, not the first five: the point of the cell is that the lift lands on furniture, and
  // with two banks of six plus the manager's it is the *spread* across the room that has to be
  // checked. Sized off the same scale as the lamps, so a pod desk stays a pod desk's width.
  const dw = Math.max(7, Math.round(44 * sx));
  const half = dw >> 1;
  for (const [lx, ly] of DESK_LAMPS) {
    const x = Math.round(lx * sx);
    const y = Math.round(ly * sy) + 3;
    rect(ctx, x - half - 1, y - 6, dw + 2, 1, PAL.out);
    rect(ctx, x - half, y - 5, dw, 3, PAL.wdt);
    rect(ctx, x - half, y - 2, dw, 3, PAL.wdf);
    rect(ctx, x - 2, y - 10, 5, 5, PAL.blk);
    rect(ctx, x - 1, y - 9, 3, 3, PAL.sc2);
  }
  // The roundtable and the coffee machine, the other two warm spots — read off the same records the
  // grade lifts, so the demo cannot show furniture the grade is not lighting.
  const [tx, ty] = TABLE_LAMP;
  rect(ctx, Math.round(tx * sx) - 8, Math.round(ty * sy) - 3, 17, 6, PAL.wdf);
  rect(ctx, Math.round(tx * sx) - 8, Math.round(ty * sy) - 4, 17, 2, PAL.wdt);
  const [mx, my] = MACHINE_LAMP;
  rect(ctx, Math.round(mx * sx) - 4, Math.round(my * sy) - 9, 9, 10, PAL.me2);
}

/** A line plot of a scalar driver, so its shape can be judged instead of guessed. Preview-only. */
function plot(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  msPerPx: number,
  fn: (t: number) => number,
  color: string,
): void {
  let prev = -1;
  for (let x = 0; x < w; x++) {
    const v = clamp01(fn(x * msPerPx));
    const y = h - 1 - Math.round(v * (h - 1));
    if (prev < 0) prev = y;
    const top = Math.min(prev, y);
    rect(ctx, x, top, 1, Math.abs(prev - y) + 1, color, 0.95);
    prev = y;
  }
}

const CHART_W = 150;
const PARTICLE_BG = PAL.wa3;
/** The stand-in room, sized so three of them fit on one sheet row and can be compared side by side. */
const SCENE_W = 144;
const SCENE_H = 81;

export const PREVIEW: PreviewItem[] = [
  {
    name: 'steam',
    w: 20,
    h: 26,
    frames: 10,
    frameMs: 110,
    bg: PAL.wa2,
    draw: (c, t) => {
      rect(c, 6, 21, 8, 5, PAL.pot);
      rect(c, 6, 20, 8, 1, PAL.po2);
      rect(c, 5, 20, 1, 6, PAL.out);
      rect(c, 14, 20, 1, 6, PAL.out);
      steam(c, 10, 20, t, 3, 1);
    },
  },
  {
    name: 'steam-lo',
    w: 20,
    h: 26,
    frames: 10,
    frameMs: 110,
    bg: PAL.wa2,
    draw: (c, t) => steam(c, 10, 24, t, 9, 0.45),
  },
  {
    name: 'steam-x3',
    w: 52,
    h: 26,
    frames: 10,
    frameMs: 110,
    bg: PAL.wa2,
    draw: (c, t) => {
      steam(c, 9, 24, t, 1, 1);
      steam(c, 26, 24, t, 2, 1);
      steam(c, 43, 24, t, 3, 1);
    },
  },
  {
    name: 'dust',
    w: 64,
    h: 44,
    frames: 10,
    frameMs: 260,
    bg: PARTICLE_BG,
    draw: (c, t) => dust(c, 0, 0, 64, 44, t, 26, 0.6),
  },
  {
    name: 'shaft',
    w: 64,
    h: 62,
    frames: 8,
    frameMs: 260,
    bg: PAL.flr,
    draw: (c, t) => {
      rect(c, 0, 0, 64, 14, PAL.wal);
      rect(c, 24, 0, 17, 13, PAL.out);
      rect(c, 25, 0, 15, 12, PAL.day, 0.9);
      rect(c, 0, 12, 64, 2, PAL.wtr);
      lightShaft(c, 32, 13, 58, 15, 40, PAL.day, 0.42);
      dust(c, 16, 14, 32, 40, t, 14, 0.5);
    },
  },
  {
    // No dust, no window, flat floor: nothing to look at but the eight tones, so a soft ramp has
    // nowhere to hide.
    name: 'shaft-bands',
    w: 72,
    h: 50,
    bg: PAL.fl2,
    draw: (c) => lightShaft(c, 36, 0, 50, 14, 60, PAL.day, 0.5),
  },
  {
    name: 'shaft-nar',
    w: 40,
    h: 62,
    bg: PAL.flr,
    draw: (c) => {
      rect(c, 0, 0, 40, 14, PAL.wal);
      rect(c, 0, 12, 40, 2, PAL.wtr);
      lightShaft(c, 20, 13, 60, 8, 22, PAL.lmp, 0.42);
    },
  },
  {
    name: 'scr-glow',
    w: 46,
    h: 30,
    bg: PAL.wdt,
    draw: (c) => {
      rect(c, 0, 22, 46, 8, PAL.wdf);
      rect(c, 0, 21, 46, 1, PAL.wdl);
      screenGlow(c, 23, 20, 15, 7, 0.85);
      rect(c, 14, 2, 18, 13, PAL.blk);
      rect(c, 16, 4, 14, 9, PAL.sc2);
      rect(c, 21, 15, 4, 4, PAL.blk);
    },
  },
  {
    name: 'footpuff',
    w: 24,
    h: 14,
    frames: 8,
    frameMs: 70,
    bg: PAL.fl3,
    draw: (c, t) => {
      rect(c, 11, 12, 3, 2, PAL.out);
      footPuff(c, 12, 12, (t / 70) / 8);
    },
  },
  {
    name: 'sparkle',
    w: 14,
    h: 14,
    frames: 10,
    frameMs: 100,
    bg: PARTICLE_BG,
    draw: (c, t) => sparkle(c, 7, 7, t, 4),
  },
  {
    name: 'sparkle-x3',
    w: 40,
    h: 14,
    frames: 10,
    frameMs: 100,
    bg: PARTICLE_BG,
    draw: (c, t) => {
      sparkle(c, 7, 7, t, 1);
      sparkle(c, 20, 5, t, 2);
      sparkle(c, 32, 9, t, 3);
    },
  },
  {
    name: 'flicker-plot',
    w: CHART_W,
    h: 26,
    bg: PAL.shd,
    draw: (c) => {
      plot(c, CHART_W, 26, 40, (t) => flicker(t, 0), PAL.scg);
      plot(c, CHART_W, 26, 40, (t) => flicker(t, 5), PAL.lmp);
    },
  },
  {
    name: 'flicker-scr',
    w: 22,
    h: 16,
    frames: 12,
    frameMs: 90,
    bg: PAL.blk,
    draw: (c, t) => {
      const f = flicker(t, 2);
      rect(c, 2, 2, 18, 12, PAL.scr);
      rect(c, 2, 2, 18, 12, PAL.sc3, f * 0.85);
    },
  },
  {
    name: 'sway-plot',
    w: CHART_W,
    h: 26,
    bg: PAL.shd,
    draw: (c) => {
      plot(c, CHART_W, 26, 80, (t) => sway(t, 0) * 0.5 + 0.5, PAL.lf3);
      plot(c, CHART_W, 26, 80, (t) => sway(t, 6) * 0.5 + 0.5, PAL.acc);
    },
  },
  {
    name: 'breathe-plot',
    w: CHART_W,
    h: 26,
    bg: PAL.shd,
    draw: (c) => {
      plot(c, CHART_W, 26, 40, (t) => breathe(t, 0), PAL.day);
      plot(c, CHART_W, 26, 40, (t) => breathe(t, 4), PAL.gry);
    },
  },
  {
    name: 'blink-6',
    w: CHART_W,
    h: 26,
    bg: PAL.shd,
    draw: (c) => {
      for (let s = 0; s < 6; s++) {
        const y = s * 4;
        rect(c, 0, y + 1, CHART_W, 1, PAL.ou2);
        for (let x = 0; x < CHART_W; x++) {
          if (blinkOn(x * 100, s)) rect(c, x, y, 1, 3, PAL.day, 0.95);
        }
      }
    },
  },
  {
    name: 'night-0',
    w: SCENE_W,
    h: SCENE_H,
    draw: (c) => {
      demoScene(c, SCENE_W, SCENE_H, 0);
      nightGradeIn(c, SCENE_W, SCENE_H, 0);
    },
  },
  {
    name: 'night-half',
    w: SCENE_W,
    h: SCENE_H,
    draw: (c) => {
      demoScene(c, SCENE_W, SCENE_H, 0.55);
      nightGradeIn(c, SCENE_W, SCENE_H, 0.55);
    },
  },
  {
    name: 'night-1',
    w: SCENE_W,
    h: SCENE_H,
    draw: (c) => {
      demoScene(c, SCENE_W, SCENE_H, 1);
      nightGradeIn(c, SCENE_W, SCENE_H, 1);
    },
  },
  {
    name: 'vignette',
    w: SCENE_W,
    h: SCENE_H,
    draw: (c) => {
      demoScene(c, SCENE_W, SCENE_H, 0);
      vignetteIn(c, SCENE_W, SCENE_H, 1);
    },
  },
  {
    name: 'vign-flat',
    w: SCENE_W,
    h: SCENE_H,
    bg: PAL.wdt,
    draw: (c) => vignetteIn(c, SCENE_W, SCENE_H, 1),
  },
  {
    name: 'night+vign',
    w: SCENE_W,
    h: SCENE_H,
    draw: (c) => {
      demoScene(c, SCENE_W, SCENE_H, 1);
      nightGradeIn(c, SCENE_W, SCENE_H, 1);
      vignetteIn(c, SCENE_W, SCENE_H, 0.8);
    },
  },
];
