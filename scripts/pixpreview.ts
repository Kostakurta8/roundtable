/**
 * Renders the pixel office to a PNG, without a browser.
 *
 * Pixel art authored blind is frequently wrong, and the only way to know a sprite is right is to
 * look at it. Opening the app for every sprite revision is far too slow a loop, so this is a
 * software rasteriser implementing exactly the slice of `CanvasRenderingContext2D` that
 * `art.ts` uses — `fillStyle`, `globalAlpha`, `fillRect` — plus a PNG encoder over node's own
 * zlib. Nothing else is needed: the whole renderer draws with filled rectangles.
 *
 *   npx tsx scripts/pixpreview.ts sheet   contact sheet of every exported sprite
 *   npx tsx scripts/pixpreview.ts scene   the composed room, as the app would draw it
 *
 * Output lands in `.preview/`, which is git-ignored.
 */
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = resolvePath(HERE, '..', '.preview');

// --------------------------------------------------------------- software canvas

/** `#rgb`, `#rrggbb` and `#rrggbbaa` — the only colour forms the renderer writes. */
function parseColor(css: string): [number, number, number, number] {
  const s = css.trim();
  if (s[0] !== '#') return [255, 0, 255, 255]; // loud magenta: an unparsed colour must be visible
  const hex = s.slice(1);
  const grab = (i: number, n: number): number =>
    n === 1 ? parseInt(hex[i] + hex[i], 16) : parseInt(hex.slice(i, i + 2), 16);
  if (hex.length === 3) return [grab(0, 1), grab(1, 1), grab(2, 1), 255];
  if (hex.length === 6) return [grab(0, 2), grab(2, 2), grab(4, 2), 255];
  if (hex.length === 8) return [grab(0, 2), grab(2, 2), grab(4, 2), grab(6, 2)];
  return [255, 0, 255, 255];
}

/**
 * The subset of the 2D context the renderer touches, over a flat RGBA buffer.
 *
 * Source-over blending is done by hand because that is the whole job: a sprite is a stack of
 * translucent rectangles and the compositing has to match what the browser would do, or a
 * light pool previewed here would not be the light pool that ships.
 */
export class SoftCtx {
  readonly data: Uint8ClampedArray;
  fillStyle = '#000000';
  globalAlpha = 1;
  imageSmoothingEnabled = false;

  private rgba: [number, number, number, number] = [0, 0, 0, 255];
  private lastStyle = '';

  constructor(
    readonly width: number,
    readonly height: number,
  ) {
    this.data = new Uint8ClampedArray(width * height * 4);
  }

  private color(): [number, number, number, number] {
    if (this.fillStyle !== this.lastStyle) {
      this.rgba = parseColor(this.fillStyle);
      this.lastStyle = this.fillStyle;
    }
    return this.rgba;
  }

  fillRect(x: number, y: number, w: number, h: number): void {
    const [r, g, b, ca] = this.color();
    const a = this.globalAlpha * (ca / 255);
    if (a <= 0) return;
    const x0 = Math.max(0, Math.round(x));
    const y0 = Math.max(0, Math.round(y));
    const x1 = Math.min(this.width, Math.round(x) + Math.round(w));
    const y1 = Math.min(this.height, Math.round(y) + Math.round(h));
    for (let py = y0; py < y1; py++) {
      for (let px = x0; px < x1; px++) {
        const i = (py * this.width + px) * 4;
        const d = this.data;
        d[i] = r * a + d[i] * (1 - a);
        d[i + 1] = g * a + d[i + 1] * (1 - a);
        d[i + 2] = b * a + d[i + 2] * (1 - a);
        d[i + 3] = 255 * a + d[i + 3] * (1 - a);
      }
    }
  }

  /** `save`/`restore` are not used by the renderer, but a stray call must not crash a preview. */
  save(): void {}
  restore(): void {}
  clearRect(x: number, y: number, w: number, h: number): void {
    const x0 = Math.max(0, Math.round(x));
    const y0 = Math.max(0, Math.round(y));
    const x1 = Math.min(this.width, x0 + Math.round(w));
    const y1 = Math.min(this.height, y0 + Math.round(h));
    for (let py = y0; py < y1; py++) this.data.fill(0, (py * this.width + x0) * 4, (py * this.width + x1) * 4);
  }
}

/** A `SoftCtx` typed as the real thing, for calling code that wants the DOM signature. */
export const asCtx = (c: SoftCtx): CanvasRenderingContext2D => c as unknown as CanvasRenderingContext2D;

// --------------------------------------------------------------- PNG

function crc32(buf: Uint8Array): number {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function chunk(type: string, body: Uint8Array): Uint8Array {
  const out = new Uint8Array(body.length + 12);
  const view = new DataView(out.buffer);
  view.setUint32(0, body.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(body, 8);
  view.setUint32(8 + body.length, crc32(out.subarray(4, 8 + body.length)));
  return out;
}

/** Truecolour-with-alpha PNG, one filter byte per scanline, filter 0. */
export function encodePng(w: number, h: number, rgba: Uint8ClampedArray): Buffer {
  const raw = new Uint8Array(h * (w * 4 + 1));
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0;
    raw.set(rgba.subarray(y * w * 4, (y + 1) * w * 4), y * (w * 4 + 1) + 1);
  }
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, w);
  dv.setUint32(4, h);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', new Uint8Array(0)),
  ]);
}

/** Nearest-neighbour upscale — the same filtering the browser does with `image-rendering`. */
export function upscale(src: Uint8ClampedArray, w: number, h: number, n: number): Uint8ClampedArray {
  if (n === 1) return src;
  const out = new Uint8ClampedArray(w * n * h * n * 4);
  for (let y = 0; y < h * n; y++) {
    const sy = (y / n) | 0;
    for (let x = 0; x < w * n; x++) {
      const si = (sy * w + ((x / n) | 0)) * 4;
      const di = (y * w * n + x) * 4;
      out[di] = src[si];
      out[di + 1] = src[si + 1];
      out[di + 2] = src[si + 2];
      out[di + 3] = src[si + 3];
    }
  }
  return out;
}

export function save(name: string, ctx: SoftCtx, zoom = 3): string {
  mkdirSync(OUT_DIR, { recursive: true });
  const px = upscale(ctx.data, ctx.width, ctx.height, zoom);
  const file = resolvePath(OUT_DIR, `${name}.png`);
  writeFileSync(file, encodePng(ctx.width * zoom, ctx.height * zoom, px));
  return file;
}
