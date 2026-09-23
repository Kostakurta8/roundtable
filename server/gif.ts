/**
 * An animated GIF encoder, over node alone.
 *
 * Written rather than installed for the same reason `scripts/pixpreview.ts` writes its own PNG: the
 * room is drawn with filled rectangles into a flat RGBA buffer, and turning a stack of those into a
 * file anybody can post is a palette, a diff and an LZW loop — a few hundred lines that are easier
 * to read than a dependency is to audit, in a tool whose whole promise is that it does nothing you
 * cannot see.
 *
 * Three decisions carry the size:
 *
 *   - **One palette for the whole clip.** Pixel art lives on a small palette, and a global table
 *     means a colour cannot shimmer between two indices from one frame to the next. It is cut from
 *     a histogram of every frame, weighted by how often each colour is actually on screen.
 *   - **Each frame carries only what changed.** A frame is cropped to the box around the pixels that
 *     differ from the one before it, and inside that box an unchanged pixel is written as the
 *     transparent index. An office where two people are walking is two small rectangles, not a
 *     whole room.
 *   - **Scaling happens after indexing.** The clip is drawn at the buffer's own 480x270 and blown up
 *     by an integer, nearest-neighbour, which is exactly how the browser shows it — so a pixel in
 *     the GIF is a square of pixels, the way the art was drawn, and LZW eats the repeats.
 */

/** The index reserved for "same as the previous frame". The palette gets the other 255. */
const TRANSPARENT = 255;
const PALETTE_SIZE = 255;

/** One frame of the clip: packed `0xRRGGBB` per pixel, row-major, at the buffer's own size. */
export type RgbFrame = Uint32Array;

export type GifInput = {
  width: number;
  height: number;
  frames: readonly RgbFrame[];
  /** Hundredths of a second each frame is shown for — the unit the format uses. */
  delayCs: number;
  /** How long the last frame holds before the loop restarts, in hundredths of a second. */
  holdLastCs?: number;
  /** Integer nearest-neighbour upscale applied on the way out. */
  scale: number;
};

/** RGBA from a software canvas into the packed form the encoder works in. Alpha is dropped. */
export function packRgb(rgba: Uint8ClampedArray, out?: Uint32Array): Uint32Array {
  const n = rgba.length >> 2;
  const px = out ?? new Uint32Array(n);
  for (let i = 0, j = 0; i < n; i++, j += 4) px[i] = (rgba[j] << 16) | (rgba[j + 1] << 8) | rgba[j + 2];
  return px;
}

// --------------------------------------------------------------- palette

type Box = { colors: Uint32Array; weights: Float64Array; lo: number; hi: number };

const R = (c: number): number => (c >>> 16) & 255;
const G = (c: number): number => (c >>> 8) & 255;
const B = (c: number): number => c & 255;

/**
 * Median cut over a weighted histogram.
 *
 * The box with the most weighted spread is split at its weighted median along its longest axis,
 * until there are as many boxes as the palette has room for; each box becomes the weighted mean of
 * its colours. A room with fewer distinct colours than that gets every one of them exactly.
 */
export function cutPalette(hist: ReadonlyMap<number, number>, size = PALETTE_SIZE): number[] {
  const colors = Uint32Array.from(hist.keys());
  if (colors.length <= size) return [...colors];
  const weights = Float64Array.from(colors, (c) => hist.get(c) ?? 0);
  const boxes: Box[] = [{ colors, weights, lo: 0, hi: colors.length }];

  const spread = (b: Box): { axis: number; range: number } => {
    let rMin = 255, rMax = 0, gMin = 255, gMax = 0, bMin = 255, bMax = 0;
    for (let i = b.lo; i < b.hi; i++) {
      const c = b.colors[i];
      const r = R(c), g = G(c), bl = B(c);
      if (r < rMin) rMin = r;
      if (r > rMax) rMax = r;
      if (g < gMin) gMin = g;
      if (g > gMax) gMax = g;
      if (bl < bMin) bMin = bl;
      if (bl > bMax) bMax = bl;
    }
    const rr = rMax - rMin, gr = gMax - gMin, br = bMax - bMin;
    if (rr >= gr && rr >= br) return { axis: 16, range: rr };
    if (gr >= br) return { axis: 8, range: gr };
    return { axis: 0, range: br };
  };

  while (boxes.length < size) {
    // Split whichever box is doing the most harm: widest range, weighted by how much it is used.
    let pick = -1;
    let best = 0;
    for (let i = 0; i < boxes.length; i++) {
      const b = boxes[i];
      if (b.hi - b.lo < 2) continue;
      let w = 0;
      for (let k = b.lo; k < b.hi; k++) w += b.weights[k];
      const score = spread(b).range * Math.sqrt(w);
      if (score > best) {
        best = score;
        pick = i;
      }
    }
    if (pick === -1) break;
    const b = boxes[pick];
    const { axis } = spread(b);
    // Sort the slice by the chosen channel, carrying weights along.
    const idx = Array.from({ length: b.hi - b.lo }, (_, k) => b.lo + k);
    idx.sort((x, y) => ((b.colors[x] >>> axis) & 255) - ((b.colors[y] >>> axis) & 255));
    const cs = idx.map((k) => b.colors[k]);
    const ws = idx.map((k) => b.weights[k]);
    for (let k = 0; k < cs.length; k++) {
      b.colors[b.lo + k] = cs[k];
      b.weights[b.lo + k] = ws[k];
    }
    let total = 0;
    for (let k = b.lo; k < b.hi; k++) total += b.weights[k];
    let acc = 0;
    let cut = b.lo + 1;
    for (let k = b.lo; k < b.hi - 1; k++) {
      acc += b.weights[k];
      if (acc >= total / 2) {
        cut = k + 1;
        break;
      }
      cut = k + 2;
    }
    cut = Math.min(Math.max(cut, b.lo + 1), b.hi - 1);
    boxes.splice(pick, 1, { ...b, hi: cut }, { ...b, lo: cut });
  }

  return boxes.map((b) => {
    let w = 0, r = 0, g = 0, bl = 0;
    for (let k = b.lo; k < b.hi; k++) {
      const c = b.colors[k];
      const wt = b.weights[k] || 1e-9;
      w += wt;
      r += R(c) * wt;
      g += G(c) * wt;
      bl += B(c) * wt;
    }
    return (Math.round(r / w) << 16) | (Math.round(g / w) << 8) | Math.round(bl / w);
  });
}

/** Maps a packed colour to its nearest palette index, remembering every answer. */
function indexer(palette: readonly number[]): (c: number) => number {
  const cache = new Map<number, number>();
  return (c) => {
    const hit = cache.get(c);
    if (hit !== undefined) return hit;
    const r = R(c), g = G(c), b = B(c);
    let best = 0;
    let bestD = Infinity;
    for (let i = 0; i < palette.length; i++) {
      const p = palette[i];
      const dr = R(p) - r, dg = G(p) - g, db = B(p) - b;
      // Weighted towards green the way the eye is, so a dark blue floor does not snap to grey.
      const d = 2 * dr * dr + 4 * dg * dg + 3 * db * db;
      if (d < bestD) {
        bestD = d;
        best = i;
        if (d === 0) break;
      }
    }
    cache.set(c, best);
    return best;
  };
}

// --------------------------------------------------------------- LZW

/** GIF's variable-width LZW, packed into 255-byte sub-blocks. */
function lzw(indices: Uint8Array, minCodeSize: number): Uint8Array {
  const clear = 1 << minCodeSize;
  const eoi = clear + 1;
  const out: number[] = [];
  let cur = 0;
  let bits = 0;
  let size = minCodeSize + 1;
  let next = eoi + 1;
  const dict = new Map<number, number>();

  const emit = (code: number): void => {
    cur |= code << bits;
    bits += size;
    while (bits >= 8) {
      out.push(cur & 255);
      cur >>>= 8;
      bits -= 8;
    }
  };

  emit(clear);
  if (indices.length === 0) {
    emit(eoi);
  } else {
    let prefix = indices[0];
    for (let i = 1; i < indices.length; i++) {
      const k = indices[i];
      const key = (prefix << 8) | k;
      const found = dict.get(key);
      if (found !== undefined) {
        prefix = found;
        continue;
      }
      emit(prefix);
      if (next < 4096) {
        dict.set(key, next++);
        if (next > 1 << size && size < 12) size++;
      } else {
        emit(clear);
        dict.clear();
        size = minCodeSize + 1;
        next = eoi + 1;
      }
      prefix = k;
    }
    emit(prefix);
    emit(eoi);
  }
  if (bits > 0) out.push(cur & 255);

  const blocks: number[] = [];
  for (let i = 0; i < out.length; i += 255) {
    const n = Math.min(255, out.length - i);
    blocks.push(n);
    for (let k = 0; k < n; k++) blocks.push(out[i + k]);
  }
  blocks.push(0);
  return Uint8Array.from(blocks);
}

// --------------------------------------------------------------- file

const u16 = (n: number): number[] => [n & 255, (n >> 8) & 255];

/** The whole clip as the bytes of one looping GIF89a. */
export function encodeGif(input: GifInput): Buffer {
  const { width, height, frames, delayCs, scale } = input;
  const hist = new Map<number, number>();
  for (const f of frames) for (let i = 0; i < f.length; i++) hist.set(f[i], (hist.get(f[i]) ?? 0) + 1);
  const palette = cutPalette(hist);
  const toIndex = indexer(palette);

  const W = width * scale;
  const H = height * scale;
  const parts: Buffer[] = [];

  const table = new Uint8Array(256 * 3);
  palette.forEach((c, i) => {
    table[i * 3] = R(c);
    table[i * 3 + 1] = G(c);
    table[i * 3 + 2] = B(c);
  });
  parts.push(
    Buffer.from('GIF89a', 'ascii'),
    Buffer.from([...u16(W), ...u16(H), 0xf7, 0, 0]),
    Buffer.from(table),
    // NETSCAPE2.0: loop for ever.
    Buffer.from([0x21, 0xff, 0x0b, ...Buffer.from('NETSCAPE2.0', 'ascii'), 0x03, 0x01, 0, 0, 0]),
  );

  let prev: Uint8Array | null = null;
  const idx = new Uint8Array(width * height);
  for (let f = 0; f < frames.length; f++) {
    const src = frames[f];
    for (let i = 0; i < idx.length; i++) idx[i] = toIndex(src[i]);

    // The box around everything that changed. The first frame is the whole picture.
    let x0 = 0, y0 = 0, x1 = width - 1, y1 = height - 1;
    if (prev) {
      x0 = width;
      y0 = height;
      x1 = -1;
      y1 = -1;
      for (let y = 0; y < height; y++) {
        const row = y * width;
        for (let x = 0; x < width; x++) {
          if (idx[row + x] === prev[row + x]) continue;
          if (x < x0) x0 = x;
          if (x > x1) x1 = x;
          if (y < y0) y0 = y;
          if (y > y1) y1 = y;
        }
      }
      // Nothing moved: a one-pixel transparent frame still has to carry the delay.
      if (x1 < 0) {
        x0 = 0;
        y0 = 0;
        x1 = 0;
        y1 = 0;
      }
    }
    const bw = x1 - x0 + 1;
    const bh = y1 - y0 + 1;
    const body = new Uint8Array(bw * scale * bh * scale);
    let o = 0;
    for (let y = y0; y <= y1; y++) {
      const rowStart = o;
      for (let x = x0; x <= x1; x++) {
        const i = y * width + x;
        const v = prev && idx[i] === prev[i] ? TRANSPARENT : idx[i];
        for (let s = 0; s < scale; s++) body[o++] = v;
      }
      // The same row again for each extra line of scale.
      const rowLen = o - rowStart;
      for (let s = 1; s < scale; s++) {
        body.copyWithin(o, rowStart, rowStart + rowLen);
        o += rowLen;
      }
    }

    const last = f === frames.length - 1;
    const delay = last && input.holdLastCs !== undefined ? input.holdLastCs : delayCs;
    parts.push(
      // Graphic control: disposal 1 (leave the frame in place), transparency on.
      Buffer.from([0x21, 0xf9, 0x04, (1 << 2) | 1, ...u16(delay), TRANSPARENT, 0]),
      Buffer.from([0x2c, ...u16(x0 * scale), ...u16(y0 * scale), ...u16(bw * scale), ...u16(bh * scale), 0]),
      Buffer.from([8]),
      Buffer.from(lzw(body, 8)),
    );
    prev = prev ?? new Uint8Array(idx.length);
    prev.set(idx);
  }
  parts.push(Buffer.from([0x3b]));
  return Buffer.concat(parts);
}
