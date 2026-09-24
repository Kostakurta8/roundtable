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
// The canvas itself lives in `src/clip/softctx.ts` now, where a browser worker can load it without
// this file's `node:zlib` and `node:fs` coming along. Re-exported so every sheet, test and script
// that has always imported it from here still does.
import { SoftCtx } from '../src/clip/softctx';
export { asCtx, SoftCtx } from '../src/clip/softctx';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = resolvePath(HERE, '..', '.preview');

// --------------------------------------------------------------- software canvas

/**
 * `drawImage`'s nine-argument form, nearest-neighbour, over two software canvases.
 *
 * The renderer scales the room onto the stage with `imageSmoothingEnabled = false`, which is
 * nearest-neighbour sampling of the source rectangle — so this is not an approximation of what the
 * browser does, it is the same rule. Source pixels outside the buffer are skipped rather than
 * clamped: a blit that asks for rows the source does not have should leave a hole a reviewer can
 * see, not repeat the edge and look plausible.
 */
export function blit(
  dst: SoftCtx,
  src: SoftCtx,
  sx: number,
  sy: number,
  sw: number,
  sh: number,
  dx: number,
  dy: number,
  dw: number,
  dh: number,
): void {
  if (sw <= 0 || sh <= 0 || dw <= 0 || dh <= 0) return;
  const x0 = Math.max(0, Math.round(dx));
  const y0 = Math.max(0, Math.round(dy));
  const x1 = Math.min(dst.width, Math.round(dx + dw));
  const y1 = Math.min(dst.height, Math.round(dy + dh));
  for (let py = y0; py < y1; py++) {
    const v = Math.floor(sy + ((py + 0.5 - dy) / dh) * sh);
    if (v < 0 || v >= src.height) continue;
    for (let px = x0; px < x1; px++) {
      const u = Math.floor(sx + ((px + 0.5 - dx) / dw) * sw);
      if (u < 0 || u >= src.width) continue;
      const si = (v * src.width + u) * 4;
      const di = (py * dst.width + px) * 4;
      dst.data[di] = src.data[si];
      dst.data[di + 1] = src.data[si + 1];
      dst.data[di + 2] = src.data[si + 2];
      dst.data[di + 3] = src.data[si + 3];
    }
  }
}

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
