/**
 * `FrameLog`: a clip's frames held as the changes between them, so the share dialog's worker does
 * not need three hundred megabytes for a forty-second clip.
 *
 * The one thing it may not do is change the file. So what is pinned is that a GIF encoded from a log
 * is the GIF encoded from the same frames as an array, byte for byte — for noise, where nothing is
 * shared between frames, and for a real clip of the room — and then that it is actually smaller.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Ev } from '../shared/events';
import { Normalizer } from '../server/normalize';
import { parseLine } from '../server/parse';
import { encodeGif, FrameLog, type RgbFrame } from '../src/clip/gif';
import { CLIP_DEFAULTS, clipFrames, renderClip } from '../src/clip/render';

function fixtureSession(): Ev[] {
  const feed = (file: string, agentId: string): Ev[] => {
    const n = new Normalizer('fix-sess', agentId);
    return readFileSync(join(__dirname, '..', 'fixtures', file), 'utf8')
      .split('\n')
      .filter(Boolean)
      .flatMap((l) => {
        const r = parseLine(l);
        return r ? n.feed(r) : [];
      });
  };
  return [...feed('main-session.jsonl', 'main'), ...feed('agent-abc123.jsonl', 'abc123')];
}

/** A seeded generator, so the noise is the same noise every run. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s;
  };
}

const logOf = (frames: readonly RgbFrame[]): FrameLog => {
  const log = new FrameLog();
  for (const f of frames) log.push(f);
  return log;
};

describe('FrameLog', () => {
  it('gives every frame back exactly, in order, whatever changed between them', () => {
    const next = rng(7);
    const w = 23;
    const h = 11;
    const frames: RgbFrame[] = [];
    let cur = Uint32Array.from({ length: w * h }, () => next() & 0xffffff);
    for (let f = 0; f < 12; f++) {
      cur = cur.slice();
      // Changes of every shape: none, one pixel, runs with small gaps, and the whole frame.
      const n = f === 3 ? 0 : f === 7 ? cur.length : (next() % 40) + 1;
      for (let k = 0; k < n; k++) cur[f === 7 ? k : next() % cur.length] = next() & 0xffffff;
      frames.push(cur);
    }
    const back = [...logOf(frames).frames()].length;
    expect(back).toBe(frames.length);
    let i = 0;
    for (const f of logOf(frames).frames()) expect([...f]).toEqual([...frames[i++]]);
  });

  it('does not hold on to the buffer it is handed, so the caller can pack the next frame into it', () => {
    const buf = new Uint32Array(8);
    const log = new FrameLog();
    const seen: number[][] = [];
    for (let f = 0; f < 5; f++) {
      buf.fill(f * 3, f, 8);
      seen.push([...buf]);
      log.push(buf);
    }
    expect([...log.frames()].length).toBe(5);
    let i = 0;
    for (const f of log.frames()) expect([...f]).toEqual(seen[i++]);
  });

  it('encodes to the same bytes as the frames it holds, noise included', () => {
    const next = rng(42);
    const frames = Array.from({ length: 6 }, () => Uint32Array.from({ length: 40 * 30 }, () => next() & 0xffffff));
    const input = { width: 40, height: 30, delayCs: 8, holdLastCs: 250, scale: 2 };
    const fromArray = encodeGif({ ...input, frames });
    const fromLog = encodeGif({ ...input, frames: logOf(frames) });
    expect(Buffer.from(fromLog).equals(Buffer.from(fromArray))).toBe(true);
  });

  it('is how renderClip makes the file, and the file is the one the whole frames make', { timeout: 60_000 }, () => {
    const evs = fixtureSession();
    const opts = { ...CLIP_DEFAULTS, seconds: 3, scale: 1 };
    const c = clipFrames(evs, opts);
    const whole = encodeGif({ width: c.width, height: c.height, frames: c.frames, delayCs: c.delayCs, holdLastCs: 250, scale: c.scale });
    expect(Buffer.from(renderClip(evs, opts).gif).equals(Buffer.from(whole))).toBe(true);
  });

  it('holds a clip of the room in a small part of what its frames weigh', { timeout: 60_000 }, () => {
    const c = clipFrames(fixtureSession(), { ...CLIP_DEFAULTS, seconds: 6 });
    const weight = c.frames.reduce((n, f) => n + f.byteLength, 0);
    const log = logOf(c.frames);
    // The showcase session's 40 s clip went from 277 MB to 13 MB; this is a smaller room.
    expect(log.bytes).toBeLessThan(weight / 8);
  });
});
