/**
 * The pixel-art substrate: a locked palette, a sprite format, and the blitter.
 *
 * Everything in the room is drawn into a small canvas — 480x270 — and scaled up with
 * nearest-neighbour filtering, so a "pixel" here really is one pixel and the upscale is what
 * makes it chunky. That constraint is the whole point: the previous renderer drew the office as
 * DOM boxes with CSS gradients, which can be made *smooth* but never *crisp*, and every attempt
 * at realism came out as a soft airbrushed diagram. Hard edges and a small palette are what read
 * as a real place at this size.
 *
 * Sprites are authored as rows of characters rather than as draw calls. A sprite you can read in
 * the source is a sprite anyone can fix; a sequence of forty `fillRect`s is not.
 */

/** The internal canvas. 16:9, and small enough that every pixel is a deliberate decision. */
export const PIX = { w: 480, h: 270 } as const;

/**
 * The palette.
 *
 * Deliberately small and deliberately warm-vs-cool: the room is lit by cool daylight and warm
 * lamps, and every surface picks a side. Keys are three characters so that art rows stay legible
 * when a sprite uses a dozen of them.
 */
export const PAL = {
  // outlines and shadow — the black is never pure, or the art reads as clip-art
  out: '#141821',
  ou2: '#232a37',
  shd: '#0d1017',

  // walls
  wal: '#2f5265',
  wa2: '#264454',
  wa3: '#1d3644',
  wtr: '#16262f', // trim / skirting
  wlt: '#3d6a80', // wall catching light

  // floor
  flr: '#8a5a3c',
  fl2: '#7d5034',
  fl3: '#6b4229',
  fl4: '#5a3722', // plank seam
  flt: '#a06a46', // floor in a light pool

  // wood furniture
  wdt: '#c08a52', // desk top
  wdf: '#a9713f', // desk front
  wdd: '#8a5a30', // desk shadow side
  wdl: '#d9a068', // lit edge

  // metal / plastic
  met: '#6b7a8a',
  me2: '#55636f',
  me3: '#8b9aa8',
  blk: '#1b2430', // monitor bezel, dark plastic
  bl2: '#2a3644',

  // screens
  scr: '#1d3a52',
  sc2: '#2b6fa8',
  sc3: '#5fb0e0',
  scg: '#7ad0ff', // screen glow

  // light
  lmp: '#ffd27a', // lamp warm
  lm2: '#ffb347',
  day: '#cfeaff', // daylight cool
  wht: '#f2efe6',
  gry: '#b9b3a6',

  // plants
  lf1: '#3f8a4a',
  lf2: '#2f6a3a',
  lf3: '#57a862',
  pot: '#b8674a',
  po2: '#96503a',

  // accents (used only for status, never as decoration)
  ok: '#5cc98a',
  err: '#e56a6a',
  wrn: '#e8b04a',
  acc: '#4fb3c2',

  // paper
  pap: '#efe7d4',
  pa2: '#d6cdb8',
} as const;

export type PalKey = keyof typeof PAL;

/**
 * A character's colours, resolved into the reserved slots below at draw time.
 *
 * Recolouring one sprite is what lets twelve agents look like twelve people without twelve
 * sprites: the art says "this pixel is hair", and who is wearing it decides what colour that is.
 */
export type Look = {
  skin: string;
  skinShade: string;
  hair: string;
  hairShade: string;
  shirt: string;
  shirtShade: string;
  trouser: string;
};

/** Reserved art keys, resolved from a `Look` rather than from `PAL`. */
const SLOT = {
  S: 'skin',
  s: 'skinShade',
  H: 'hair',
  h: 'hairShade',
  T: 'shirt',
  t: 'shirtShade',
  P: 'trouser',
} as const satisfies Record<string, keyof Look>;

/**
 * One sprite.
 *
 * `rows` are the pixels, one character per pixel, `.` transparent. `map` translates the remaining
 * characters to palette keys; the reserved slots above are not listed there and are filled from
 * the drawing `Look` instead. Rows do not have to be padded to equal length — trailing
 * transparency is implied, which keeps the source readable.
 */
export type Art = {
  rows: readonly string[];
  map: Readonly<Record<string, PalKey>>;
};

export type DrawOpts = {
  /** Mirror horizontally, for a character facing the other way. */
  flip?: boolean;
  /** Colours for the reserved slots. Required by any sprite that uses them. */
  look?: Look;
  /** 0..1, multiplied into every pixel's alpha. */
  alpha?: number;
  /** Drawn instead of the sprite's own colours — for silhouettes and drop shadows. */
  tint?: string;
};

const isSlot = (ch: string): ch is keyof typeof SLOT => Object.hasOwn(SLOT, ch);

/** Resolves one art character to a CSS colour, or `undefined` for transparent. */
function colorOf(ch: string, art: Art, look: Look | undefined): string | undefined {
  if (ch === '.' || ch === ' ') return undefined;
  if (isSlot(ch)) return look?.[SLOT[ch]];
  const key = art.map[ch];
  return key ? PAL[key] : undefined;
}

/**
 * A sprite's extent, in art pixels.
 *
 * Width is a maximum rather than the first row's length because art rows are written ragged — a
 * trailing run of transparent pixels is simply not typed — so the widest row is the sprite.
 *
 * Height existed as a contract export that nothing called, while `drawArt` bounded its own loop
 * with `art.rows.length` a few lines below: the module published a name for the measurement and
 * then took the measurement by hand. Exporting only one of the two was the real defect, since
 * anything outside this file holding an `Art` could ask how wide it was and not how tall.
 */
export const artWidth = (art: Art): number => art.rows.reduce((w, r) => Math.max(w, r.length), 0);
export const artHeight = (art: Art): number => art.rows.length;

/**
 * Blits a sprite with its top-left at (x, y), in canvas pixels.
 *
 * Runs of identical colour on a row are merged into one `fillRect`. A 480x270 scene redrawn sixty
 * times a second is around 130 000 pixels per frame; issued one at a time that is enough calls to
 * cost real milliseconds, and merged it is closer to a few thousand.
 */
export function drawArt(
  ctx: CanvasRenderingContext2D,
  art: Art,
  x: number,
  y: number,
  opts: DrawOpts = {},
): void {
  const { flip = false, look, alpha = 1, tint } = opts;
  if (alpha <= 0) return;
  const w = artWidth(art);
  const h = artHeight(art);

  const prevAlpha = ctx.globalAlpha;
  if (alpha !== 1) ctx.globalAlpha = prevAlpha * alpha;

  for (let row = 0; row < h; row++) {
    const line = art.rows[row];
    let col = 0;
    while (col < line.length) {
      // Resolve the sprite's own colour first even when a tint will replace it: the resolution is
      // what says whether the pixel exists at all. Reading the tint first painted the transparent
      // pixels too, so every silhouette and every drop shadow came out as a solid rectangle.
      const own = colorOf(line[col], art, look);
      if (own === undefined) {
        col += 1;
        continue;
      }
      const color = tint ?? own;
      // Extend the run while the resolved colour stays the same.
      let run = 1;
      while (col + run < line.length) {
        const next = colorOf(line[col + run], art, look);
        if (next === undefined || (tint ?? next) !== color) break;
        run += 1;
      }
      const px = flip ? x + w - col - run : x + col;
      ctx.fillStyle = color;
      ctx.fillRect(px, y + row, run, 1);
      col += run;
    }
  }

  ctx.globalAlpha = prevAlpha;
}

/** A filled rectangle in palette colour — the workhorse for floors, walls and light pools. */
export function rect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  color: string,
  alpha = 1,
): void {
  if (w <= 0 || h <= 0 || alpha <= 0) return;
  const prev = ctx.globalAlpha;
  if (alpha !== 1) ctx.globalAlpha = prev * alpha;
  ctx.fillStyle = color;
  ctx.fillRect(Math.round(x), Math.round(y), Math.round(w), Math.round(h));
  ctx.globalAlpha = prev;
}

/**
 * A soft elliptical pool, quantised to the pixel grid.
 *
 * Canvas gradients are the one place smoothness leaks into pixel art, so light and shadow are
 * drawn as concentric hard-edged bands instead. Four bands is enough to read as a falloff and few
 * enough that the steps stay visible, which is what makes it look drawn rather than blurred.
 */
export function pool(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  rx: number,
  ry: number,
  color: string,
  strength = 0.35,
  bands = 4,
): void {
  for (let b = bands; b >= 1; b--) {
    const f = b / bands;
    const a = strength * (1 - f) ** 1.3 + strength * 0.16;
    const w = rx * f;
    const h = ry * f;
    const prev = ctx.globalAlpha;
    ctx.globalAlpha = prev * a;
    ctx.fillStyle = color;
    // An ellipse of whole-pixel rows: one fillRect per scanline, so the edge stays stepped.
    const top = Math.round(cy - h);
    const bot = Math.round(cy + h);
    for (let py = top; py <= bot; py++) {
      const t = (py - cy) / h;
      if (t < -1 || t > 1) continue;
      const half = Math.round(w * Math.sqrt(1 - t * t));
      if (half <= 0) continue;
      // `half * 2 + 1`, not `half * 2`: a run of an even width around a centre column has to fall
      // a pixel further one way than the other, and every pool in the room was lopsided.
      ctx.fillRect(Math.round(cx) - half, py, half * 2 + 1, 1);
    }
    ctx.globalAlpha = prev;
  }
}

/**
 * A 3px-tall pixel font, for the labels that float over each desk.
 *
 * Bundling a font is not an option here: a webfont would be rasterised with anti-aliasing and
 * every label would turn to grey mush against the hard-edged art. Only the characters that appear
 * in agent names and status lines are defined; anything else falls back to a solid block, which
 * is legible as "a character was here" and never silently disappears.
 */
const GLYPH_W = 3;
const GLYPH_H = 5;

/**
 * Glyphs as 3x5 bitmaps, written as five rows of three so that a wrong pixel is visible in the
 * source rather than hidden in the middle of a fifteen-character run.
 *
 * The first version of this table was written as those flat runs, and eleven glyphs were silently
 * wrong — `B`, `N`, `O`, `R`, `S` and half the digits rendered as unrelated shapes, which only
 * showed up the moment a contact sheet was rendered and the labels came out as mush. Rows cost two
 * lines each and make that class of mistake impossible to miss.
 *
 * Uppercase only: labels are uppercased before drawing, which halves the table and matches the
 * chunky look. `M`/`N`, `U`/`V`/`Y` and `O`/`0` are the pairs a 3px grid struggles to separate, so
 * each is drawn deliberately differently rather than left to collide.
 */
type Glyph = readonly [string, string, string, string, string];

const FONT_ROWS: Record<string, Glyph> = {
  A: ['.#.', '#.#', '###', '#.#', '#.#'],
  B: ['##.', '#.#', '##.', '#.#', '##.'],
  C: ['.##', '#..', '#..', '#..', '.##'],
  D: ['##.', '#.#', '#.#', '#.#', '##.'],
  E: ['###', '#..', '##.', '#..', '###'],
  F: ['###', '#..', '##.', '#..', '#..'],
  G: ['.##', '#..', '#.#', '#.#', '.##'],
  H: ['#.#', '#.#', '###', '#.#', '#.#'],
  I: ['###', '.#.', '.#.', '.#.', '###'],
  J: ['..#', '..#', '..#', '#.#', '.#.'],
  K: ['#.#', '#.#', '##.', '#.#', '#.#'],
  L: ['#..', '#..', '#..', '#..', '###'],
  M: ['#.#', '###', '###', '#.#', '#.#'],
  N: ['##.', '#.#', '#.#', '#.#', '#.#'],
  O: ['.#.', '#.#', '#.#', '#.#', '.#.'],
  P: ['##.', '#.#', '##.', '#..', '#..'],
  Q: ['.#.', '#.#', '#.#', '.#.', '..#'],
  R: ['##.', '#.#', '##.', '#.#', '#.#'],
  S: ['.##', '#..', '.#.', '..#', '##.'],
  T: ['###', '.#.', '.#.', '.#.', '.#.'],
  U: ['#.#', '#.#', '#.#', '#.#', '###'],
  V: ['#.#', '#.#', '#.#', '#.#', '.#.'],
  W: ['#.#', '#.#', '###', '###', '#.#'],
  X: ['#.#', '#.#', '.#.', '#.#', '#.#'],
  Y: ['#.#', '#.#', '.#.', '.#.', '.#.'],
  Z: ['###', '..#', '.#.', '#..', '###'],
  '0': ['###', '#.#', '#.#', '#.#', '###'],
  '1': ['.#.', '##.', '.#.', '.#.', '###'],
  '2': ['##.', '..#', '.#.', '#..', '###'],
  '3': ['##.', '..#', '.#.', '..#', '##.'],
  '4': ['#.#', '#.#', '###', '..#', '..#'],
  '5': ['###', '#..', '##.', '..#', '##.'],
  '6': ['.##', '#..', '##.', '#.#', '.#.'],
  '7': ['###', '..#', '.#.', '.#.', '.#.'],
  '8': ['.#.', '#.#', '.#.', '#.#', '.#.'],
  '9': ['.#.', '#.#', '.##', '..#', '##.'],
  '.': ['...', '...', '...', '...', '.#.'],
  ',': ['...', '...', '...', '.#.', '#..'],
  ':': ['...', '.#.', '...', '.#.', '...'],
  ';': ['...', '.#.', '...', '.#.', '#..'],
  '-': ['...', '...', '###', '...', '...'],
  // Agents write em and en dashes constantly, and without these an aside in a speech bubble came
  // out as the fallback block, which reads as a redaction.
  '—': ['...', '...', '###', '...', '...'],
  '–': ['...', '...', '###', '...', '...'],
  '_': ['...', '...', '...', '...', '###'],
  '/': ['..#', '..#', '.#.', '#..', '#..'],
  '\\': ['#..', '#..', '.#.', '..#', '..#'],
  '·': ['...', '...', '.#.', '...', '...'],
  '+': ['...', '.#.', '###', '.#.', '...'],
  '?': ['##.', '..#', '.#.', '...', '.#.'],
  '!': ['.#.', '.#.', '.#.', '...', '.#.'],
  '#': ['#.#', '###', '#.#', '###', '#.#'],
  '%': ['#.#', '..#', '.#.', '#..', '#.#'],
  '(': ['..#', '.#.', '.#.', '.#.', '..#'],
  ')': ['#..', '.#.', '.#.', '.#.', '#..'],
  '[': ['.##', '.#.', '.#.', '.#.', '.##'],
  ']': ['##.', '.#.', '.#.', '.#.', '##.'],
  '<': ['..#', '.#.', '#..', '.#.', '..#'],
  '>': ['#..', '.#.', '..#', '.#.', '#..'],
  '×': ['...', '#.#', '.#.', '#.#', '...'],
  "'": ['.#.', '.#.', '...', '...', '...'],
  '"': ['#.#', '#.#', '...', '...', '...'],
  '~': ['...', '..#', '###', '#..', '...'],
  '=': ['...', '###', '...', '###', '...'],
  '*': ['#.#', '.#.', '###', '.#.', '#.#'],
  '@': ['.#.', '#.#', '###', '#..', '.##'],
  $: ['.#.', '###', '##.', '###', '.#.'],
  '&': ['.#.', '#.#', '.#.', '#.#', '.##'],
};

/** The row form flattened once at module load — the draw loop wants a single indexable run. */
const FONT_SRC: Record<string, string> = Object.fromEntries(
  Object.entries(FONT_ROWS).map(([ch, rows]) => [ch, rows.join('')]),
);

const SPACE_ADV = 2;

/** Width in pixels a string will occupy, including the 1px gaps between glyphs. */
export function textWidth(s: string): number {
  let w = 0;
  for (const ch of s.toUpperCase()) w += ch === ' ' ? SPACE_ADV : GLYPH_W + 1;
  return Math.max(0, w - 1);
}

/**
 * Draws text with its top-left at (x, y). Unknown characters draw as a 2px block rather than a
 * gap, so a name in a script this font does not cover still shows as text of the right length.
 */
export function drawText(
  ctx: CanvasRenderingContext2D,
  s: string,
  x: number,
  y: number,
  color: string,
  alpha = 1,
): void {
  const prev = ctx.globalAlpha;
  if (alpha !== 1) ctx.globalAlpha = prev * alpha;
  ctx.fillStyle = color;

  let px = x;
  for (const raw of s.toUpperCase()) {
    if (raw === ' ') {
      px += SPACE_ADV;
      continue;
    }
    const bits = FONT_SRC[raw];
    if (!bits) {
      ctx.fillRect(px, y + 1, 2, GLYPH_H - 2);
      px += GLYPH_W + 1;
      continue;
    }
    for (let i = 0; i < bits.length; i++) {
      if (bits[i] !== '#') continue;
      ctx.fillRect(px + (i % GLYPH_W), y + Math.floor(i / GLYPH_W), 1, 1);
    }
    px += GLYPH_W + 1;
  }
  ctx.globalAlpha = prev;
}

export const FONT_HEIGHT = GLYPH_H;

/**
 * Text with a one-pixel dark halo. Over a busy floor a bare label is unreadable; an outline is
 * how every pixel-art game has solved this, and it costs one extra pass.
 */
export function drawTextOutlined(
  ctx: CanvasRenderingContext2D,
  s: string,
  x: number,
  y: number,
  color: string,
  halo: string = PAL.out,
  alpha = 1,
): void {
  for (const [dx, dy] of [
    [-1, 0],
    [1, 0],
    [0, -1],
    [0, 1],
  ] as const) {
    drawText(ctx, s, x + dx, y + dy, halo, alpha);
  }
  drawText(ctx, s, x, y, color, alpha);
}
