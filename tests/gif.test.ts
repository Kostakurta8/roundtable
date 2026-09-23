import { describe, expect, it } from 'vitest';
import { cutPalette, encodeGif, packRgb } from '../server/gif';

/**
 * The GIF encoder, read back by a decoder written here from the format's own description.
 *
 * A file that "looks like a GIF" in a hex dump proves nothing — the classic failure is an LZW
 * stream that decodes fine for the first few thousand codes and turns to noise the first time the
 * code width grows or the table fills. So the tests decode what was encoded, pixel by pixel, over
 * pictures big and busy enough to cross every one of those boundaries.
 */

type Decoded = { width: number; height: number; loop: boolean; delays: number[]; frames: Uint32Array[] };

function lzwDecode(data: Uint8Array, minCodeSize: number, expected: number): Uint8Array {
  const clear = 1 << minCodeSize;
  const eoi = clear + 1;
  const out = new Uint8Array(expected);
  let o = 0;
  let size = minCodeSize + 1;
  let dict: number[][] = [];
  const reset = (): void => {
    dict = [];
    for (let i = 0; i < clear; i++) dict[i] = [i];
    dict[clear] = [];
    dict[eoi] = [];
    size = minCodeSize + 1;
  };
  reset();
  let prev: number[] | null = null;
  let bitPos = 0;
  const read = (): number => {
    let code = 0;
    for (let i = 0; i < size; i++) {
      const byte = data[(bitPos + i) >> 3] ?? 0;
      code |= ((byte >> ((bitPos + i) & 7)) & 1) << i;
    }
    bitPos += size;
    return code;
  };
  for (;;) {
    const code = read();
    if (code === clear) {
      reset();
      prev = null;
      continue;
    }
    if (code === eoi) break;
    let entry: number[];
    if (code < dict.length) entry = dict[code];
    else if (prev) entry = [...prev, prev[0]];
    else throw new Error(`bad code ${code}`);
    for (const v of entry) out[o++] = v;
    if (prev && dict.length < 4096) {
      dict.push([...prev, entry[0]]);
      if (dict.length === 1 << size && size < 12) size++;
    }
    prev = entry;
  }
  expect(o).toBe(expected);
  return out;
}

function decode(buf: Buffer): Decoded {
  expect(buf.subarray(0, 6).toString('ascii')).toBe('GIF89a');
  const width = buf.readUInt16LE(6);
  const height = buf.readUInt16LE(8);
  const packed = buf[10];
  expect(packed & 0x80).toBe(0x80);
  const tableSize = 2 << (packed & 7);
  const table = buf.subarray(13, 13 + tableSize * 3);
  let p = 13 + tableSize * 3;
  const canvas = new Uint32Array(width * height);
  const frames: Uint32Array[] = [];
  const delays: number[] = [];
  let loop = false;
  let transparent = -1;
  let delay = 0;
  const blocks = (): Uint8Array => {
    const parts: number[] = [];
    for (;;) {
      const n = buf[p++];
      if (n === 0) break;
      for (let i = 0; i < n; i++) parts.push(buf[p++]);
    }
    return Uint8Array.from(parts);
  };
  for (;;) {
    const tag = buf[p++];
    if (tag === 0x3b) break;
    if (tag === 0x21) {
      const label = buf[p++];
      if (label === 0xf9) {
        p++; // block size
        const flags = buf[p++];
        delay = buf.readUInt16LE(p);
        p += 2;
        transparent = flags & 1 ? buf[p] : -1;
        p += 2; // index + terminator
      } else if (label === 0xff) {
        const body = blocks();
        if (Buffer.from(body.subarray(0, 11)).toString('ascii') === 'NETSCAPE2.0') loop = true;
      } else blocks();
      continue;
    }
    expect(tag).toBe(0x2c);
    const x = buf.readUInt16LE(p);
    const y = buf.readUInt16LE(p + 2);
    const w = buf.readUInt16LE(p + 4);
    const h = buf.readUInt16LE(p + 6);
    expect(buf[p + 8] & 0x80).toBe(0); // no local table
    p += 9;
    const min = buf[p++];
    const idx = lzwDecode(blocks(), min, w * h);
    for (let yy = 0; yy < h; yy++) {
      for (let xx = 0; xx < w; xx++) {
        const v = idx[yy * w + xx];
        if (v === transparent) continue;
        canvas[(y + yy) * width + (x + xx)] = (table[v * 3] << 16) | (table[v * 3 + 1] << 8) | table[v * 3 + 2];
      }
    }
    frames.push(canvas.slice());
    delays.push(delay);
  }
  return { width, height, loop, delays, frames };
}

/** A frame with a few hundred distinct colours in stripes, and a block that moves. */
function busy(w: number, h: number, shift: number, colours: number): Uint32Array {
  const f = new Uint32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const c = ((x >> 2) + y * 3) % colours;
      f[y * w + x] = ((c * 37) & 255) << 16 | ((c * 91) & 255) << 8 | ((c * 13) & 255);
    }
  }
  for (let y = 10; y < 20; y++) for (let x = shift; x < shift + 12; x++) f[y * w + x] = 0xffffff;
  return f;
}

describe('encodeGif', () => {
  it('round-trips every pixel of every frame when the palette fits', () => {
    // 200 colours: under the 255 the palette holds, so decoding must reproduce the input exactly.
    const w = 160;
    const h = 90;
    const frames = [0, 7, 7, 30].map((s) => busy(w, h, s, 200));
    const gif = encodeGif({ width: w, height: h, frames, delayCs: 8, holdLastCs: 250, scale: 1 });
    const d = decode(gif);
    expect(d.width).toBe(w);
    expect(d.height).toBe(h);
    expect(d.loop).toBe(true);
    expect(d.delays).toEqual([8, 8, 8, 250]);
    expect(d.frames).toHaveLength(frames.length);
    for (let i = 0; i < frames.length; i++) expect(d.frames[i], `frame ${i}`).toEqual(frames[i]);
  });

  it('scales by whole pixels, the way the room is shown', () => {
    const w = 40;
    const h = 30;
    const frames = [busy(w, h, 0, 50), busy(w, h, 20, 50)];
    const d = decode(encodeGif({ width: w, height: h, frames, delayCs: 10, scale: 3 }));
    expect(d.width).toBe(w * 3);
    for (let i = 0; i < frames.length; i++) {
      for (let y = 0; y < h * 3; y++) {
        for (let x = 0; x < w * 3; x++) {
          if (d.frames[i][y * w * 3 + x] !== frames[i][Math.floor(y / 3) * w + Math.floor(x / 3)]) {
            throw new Error(`frame ${i} differs at ${x},${y}`);
          }
        }
      }
    }
  });

  it('survives the code table filling up many times over', () => {
    // Noise defeats LZW, so the table fills and clears again and again; that is the path that breaks.
    const w = 256;
    const h = 256;
    let seed = 7;
    const noise = new Uint32Array(w * h).map(() => {
      seed = (seed * 1103515245 + 12345) >>> 0;
      return [0x102030, 0x405060, 0x708090, 0xa0b0c0, 0xd0e0f0, 0xff0000, 0x00ff00][seed % 7];
    });
    const d = decode(encodeGif({ width: w, height: h, frames: [noise], delayCs: 10, scale: 1 }));
    expect(d.frames[0]).toEqual(noise);
  });

  it('writes an unchanged frame as almost nothing', () => {
    const w = 200;
    const h = 120;
    const f = busy(w, h, 0, 100);
    const one = encodeGif({ width: w, height: h, frames: [f], delayCs: 10, scale: 1 }).length;
    const two = encodeGif({ width: w, height: h, frames: [f, f.slice()], delayCs: 10, scale: 1 }).length;
    expect(two - one).toBeLessThan(40);
  });
});

describe('cutPalette', () => {
  it('keeps every colour when there are few enough', () => {
    const hist = new Map([
      [0x112233, 5],
      [0x445566, 1],
    ]);
    expect(cutPalette(hist).sort()).toEqual([0x112233, 0x445566].sort());
  });

  it('cuts to the size asked for, and never beyond it', () => {
    const hist = new Map<number, number>();
    for (let i = 0; i < 5000; i++) hist.set((i * 2654435761) & 0xffffff, 1 + (i % 9));
    expect(cutPalette(hist, 255)).toHaveLength(255);
    expect(cutPalette(hist, 16)).toHaveLength(16);
  });
});

describe('packRgb', () => {
  it('drops alpha and keeps the channel order', () => {
    expect([...packRgb(Uint8ClampedArray.from([1, 2, 3, 255, 250, 0, 9, 0]))]).toEqual([0x010203, 0xfa0009]);
  });
});
