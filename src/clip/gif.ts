/**
 * An animated GIF encoder, over nothing but typed arrays.
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
 *
 * It returns a `Uint8Array`, not a `Buffer`, because the share dialog runs it in a browser worker
 * where `Buffer` does not exist. `server/gif.ts` wraps the same bytes in a `Buffer` for the CLI,
 * without a copy — a `Buffer` is a `Uint8Array` with methods on it.
 */

/** The index reserved for "same as the previous frame". The palette gets the other 255. */
const TRANSPARENT = 255;
const PALETTE_SIZE = 255;

/** One frame of the clip: packed `0xRRGGBB` per pixel, row-major, at the buffer's own size. */
export type RgbFrame = Uint32Array;

export type GifInput = {
  width: number;
  height: number;
  /** Every frame, whole — or a `FrameLog` of them, which is the same frames in a fraction of the memory. */
  frames: readonly RgbFrame[] | FrameLog;
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

/**
 * Adds one frame's colours to a histogram, a run at a time.
 *
 * Counted a run at a time rather than a pixel at a time. The room is drawn in flat rectangles, so a
 * row is a few dozen runs, not 480 colours, and a map lookup per pixel was most of the cost of a long
 * clip. Runs are flushed in the order they start, so every colour still enters the map at the moment
 * its first pixel is reached — the order `cutPalette` breaks its ties in is unchanged, and so is
 * every byte of the file.
 */
function countColours(hist: Map<number, number>, f: RgbFrame): void {
  let run = 0;
  let n = 0;
  for (let i = 0; i < f.length; i++) {
    const c = f[i];
    if (n > 0 && c === run) {
      n++;
      continue;
    }
    if (n > 0) hist.set(run, (hist.get(run) ?? 0) + n);
    run = c;
    n = 1;
  }
  if (n > 0) hist.set(run, (hist.get(run) ?? 0) + n);
}

/**
 * Unchanged pixels a span of changes may swallow rather than end at. A span costs two words of
 * bookkeeping, so closing one over a single matching pixel and opening the next costs more than
 * carrying the pixel along.
 */
const SPAN_GAP = 2;

/**
 * A clip's frames, kept as what changed since the frame before.
 *
 * The palette is cut from every frame at once, so every frame has to exist before the first can be
 * encoded — and held whole, a frame of the room is 480x281 packed pixels, 540 KB, which put a
 * forty-second clip at close to 300 MB before the encoder wrote a byte. In a browser worker on a
 * phone that is the tab. But consecutive frames of an office are nearly the same picture: two
 * people walking and a clock ticking is a few small rectangles. So each frame is kept as the spans
 * of pixels that differ from the one before, the histogram the palette needs is counted as each
 * frame arrives, and the encoder is handed the frames back one at a time, rebuilt in a single
 * buffer. The frames it sees, and the order it counts their colours in, are exactly the frames and
 * the order it would have been handed as an array, so the file is the same to the byte.
 */
export class FrameLog {
  /** Every frame's colours, counted in the order `encodeGif` would have counted them. */
  readonly hist = new Map<number, number>();
  private readonly spans: Uint32Array[] = [];
  /** The frame before the next one, whole: the one full frame this keeps. */
  private last: Uint32Array | null = null;
  private scratch = new Uint32Array(0);

  get length(): number {
    return this.spans.length;
  }

  /** What the log holds, in bytes — the number the whole design is for, so a test can pin it. */
  get bytes(): number {
    return this.spans.reduce((n, d) => n + d.byteLength, (this.last?.byteLength ?? 0) + this.scratch.byteLength);
  }

  /** Keeps a frame. It is read here and not held, so the caller may reuse the buffer. */
  push(frame: RgbFrame): void {
    countColours(this.hist, frame);
    const prev = this.last;
    if (!prev) {
      const whole = new Uint32Array(frame.length + 2);
      whole[1] = frame.length;
      whole.set(frame, 2);
      this.spans.push(whole);
      this.last = frame.slice();
      return;
    }
    if (prev.length !== frame.length) throw new Error('every frame of a clip is one size');
    // `[start, length, ...pixels]` for each run of changes, in order, written into a scratch buffer
    // that cannot overflow — two spans are always at least SPAN_GAP apart, so even a frame that
    // changed everywhere costs under two words a pixel — and copied out at its real length.
    const n = frame.length;
    if (this.scratch.length < 2 * n + 2) this.scratch = new Uint32Array(2 * n + 2);
    const out = this.scratch;
    let o = 0;
    for (let i = 0; i < n; ) {
      if (frame[i] === prev[i]) {
        i++;
        continue;
      }
      let end = i + 1;
      for (let j = end; j < n && j - end <= SPAN_GAP; j++) if (frame[j] !== prev[j]) end = j + 1;
      out[o++] = i;
      out[o++] = end - i;
      out.set(frame.subarray(i, end), o);
      o += end - i;
      i = end;
    }
    this.spans.push(out.slice(0, o));
    prev.set(frame);
  }

  /** The frames again, in order, each rebuilt into the same buffer — read one before asking for the next. */
  *frames(): Generator<RgbFrame> {
    const cur = new Uint32Array(this.last?.length ?? 0);
    for (const d of this.spans) {
      for (let o = 0; o < d.length; o += 2 + d[o + 1]) cur.set(d.subarray(o + 2, o + 2 + d[o + 1]), d[o]);
      yield cur;
    }
  }
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

/**
 * LZW's string table, as two flat arrays indexed by `prefix << 8 | byte` — under 2^20, since a code
 * is at most twelve bits.
 *
 * It was a `Map`. At 2x scale a twenty-second clip feeds LZW a few hundred million bytes, one
 * lookup each, and hashing every one of them was the largest single cost of the encode. Clearing
 * the table is bumping `now`: an entry counts only if it was written in the current generation, so
 * a clear touches nothing, and one table serves every frame of a clip.
 */
type Table = { code: Uint16Array; gen: Uint32Array; now: number };
const newTable = (): Table => ({ code: new Uint16Array(1 << 20), gen: new Uint32Array(1 << 20), now: 0 });

/** GIF's variable-width LZW, packed into 255-byte sub-blocks. */
function lzw(indices: Uint8Array, minCodeSize: number, table: Table = newTable()): Uint8Array {
  const clear = 1 << minCodeSize;
  const eoi = clear + 1;
  const out: number[] = [];
  let cur = 0;
  let bits = 0;
  let size = minCodeSize + 1;
  let next = eoi + 1;
  const { code, gen } = table;
  let now = ++table.now;

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
      if (gen[key] === now) {
        prefix = code[key];
        continue;
      }
      emit(prefix);
      if (next < 4096) {
        gen[key] = now;
        code[key] = next++;
        if (next > 1 << size && size < 12) size++;
      } else {
        emit(clear);
        now = ++table.now;
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
const ascii = (s: string): number[] => Array.from(s, (c) => c.charCodeAt(0));

function concat(parts: readonly Uint8Array[]): Uint8Array<ArrayBuffer> {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/**
 * The whole clip as the bytes of one looping GIF89a.
 *
 * `onFrame` hears each frame as it is written, after the palette is cut. It sees the work and
 * cannot change it: the progress bar and the file are two separate facts.
 */
export function encodeGif(input: GifInput, onFrame?: (done: number, total: number) => void): Uint8Array<ArrayBuffer> {
  const { width, height, frames, delayCs, scale } = input;
  let hist: Map<number, number>;
  if (frames instanceof FrameLog) hist = frames.hist;
  else {
    hist = new Map<number, number>();
    for (const f of frames) countColours(hist, f);
  }
  const palette = cutPalette(hist);
  const toIndex = indexer(palette);

  const W = width * scale;
  const H = height * scale;
  const parts: Uint8Array[] = [];

  const table = new Uint8Array(256 * 3);
  palette.forEach((c, i) => {
    table[i * 3] = R(c);
    table[i * 3 + 1] = G(c);
    table[i * 3 + 2] = B(c);
  });
  parts.push(
    Uint8Array.from(ascii('GIF89a')),
    Uint8Array.from([...u16(W), ...u16(H), 0xf7, 0, 0]),
    table,
    // NETSCAPE2.0: loop for ever.
    Uint8Array.from([0x21, 0xff, 0x0b, ...ascii('NETSCAPE2.0'), 0x03, 0x01, 0, 0, 0]),
  );

  let prev: Uint8Array | null = null;
  const idx = new Uint8Array(width * height);
  const strings = newTable();
  const count = frames.length;
  let f = -1;
  for (const src of frames instanceof FrameLog ? frames.frames() : frames) {
    f++;
    // The same run-at-a-time shortcut: a pixel the colour of its left neighbour has its index.
    for (let i = 0, was = -1, at = 0; i < idx.length; i++) {
      const c = src[i];
      if (c !== was) {
        was = c;
        at = toIndex(c);
      }
      idx[i] = at;
    }

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

    const last = f === count - 1;
    const delay = last && input.holdLastCs !== undefined ? input.holdLastCs : delayCs;
    parts.push(
      // Graphic control: disposal 1 (leave the frame in place), transparency on.
      Uint8Array.from([0x21, 0xf9, 0x04, (1 << 2) | 1, ...u16(delay), TRANSPARENT, 0]),
      Uint8Array.from([0x2c, ...u16(x0 * scale), ...u16(y0 * scale), ...u16(bw * scale), ...u16(bh * scale), 0]),
      Uint8Array.from([8]),
      lzw(body, 8, strings),
    );
    prev = prev ?? new Uint8Array(idx.length);
    prev.set(idx);
    onFrame?.(f + 1, count);
  }
  parts.push(Uint8Array.from([0x3b]));
  return concat(parts);
}
