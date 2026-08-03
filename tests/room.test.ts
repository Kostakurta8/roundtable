/**
 * The visual regression the last session did not have.
 *
 * Three of the defects found in the pixel renderer were found by *rendering it and looking* —
 * eleven broken font glyphs, `drawArt` painting transparent pixels under a tint, a light pool a
 * pixel wider on one side. Every one of them was invisible in the source and obvious in a PNG, and
 * every one of them would have been caught the moment it landed by a hash of that PNG.
 *
 * So: paint the review room, hash it, and compare against a committed baseline. This does not
 * assert the room is *good* — nothing automated can — it asserts that nobody changed it by
 * accident, which is the failure mode a room assembled by eight modules actually has.
 *
 * **When this fails and the change was intended**, look at the sheet before you bless it:
 *
 *     npx tsx scripts/room.ts        # writes .preview/room-*.png — open them and check
 *     npm run room:bless             # then rewrite the baseline
 *
 * Blessing without looking is how a regression becomes the baseline.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { paintRoom } from '../scripts/roomCast';

const BASELINE = join(__dirname, 'room.baseline.json');

/**
 * Painting the room is not cheap — three seconds of it is 188 frames of a fully dressed office —
 * and these tests want the same few shots several times over. Memoised by the arguments that
 * decide the picture, which is safe precisely because the renderer is deterministic: that is the
 * first thing asserted below.
 */
const painted = new Map<string, Uint8ClampedArray>();
const pixelsOf = (night: number, seconds: number): Uint8ClampedArray => {
  const key = `${night}:${seconds}`;
  const hit = painted.get(key);
  if (hit) return hit;
  const px = paintRoom(night, seconds).data;
  painted.set(key, px);
  return px;
};

const hashOf = (night: number, seconds: number): string =>
  createHash('sha256').update(Buffer.from(pixelsOf(night, seconds))).digest('hex').slice(0, 16);

/** The three shots `scripts/room.ts` writes, by the name it writes them under. */
const SHOTS: readonly { name: string; night: number; seconds: number }[] = [
  { name: 'room-day', night: 0, seconds: 3 },
  { name: 'room-night', night: 1, seconds: 3 },
  { name: 'room-spawn', night: 0, seconds: 0.8 },
];

// Painting a dressed 480x270 office 188 times is a second or two of real work, and this file does
// it for three different shots while twelve other files compete for the same cores. The default
// five-second budget is a unit-test budget; this is a render.
describe('the composed room', { timeout: 60_000 }, () => {
  it('paints the same pixels twice from the same ticks', () => {
    // The property every other assertion here rests on, and the one the whole renderer is built
    // around: no `Math.random`, no `Date.now`, every phase accumulated from the tick. Without this
    // a baseline hash would be noise — so this one deliberately does *not* use the memo.
    const a = createHash('sha256').update(Buffer.from(paintRoom(0, 3).data)).digest('hex');
    const b = createHash('sha256').update(Buffer.from(paintRoom(0, 3).data)).digest('hex');
    expect(a).toBe(b);
  });

  it('matches the committed baseline', () => {
    const baseline = JSON.parse(readFileSync(BASELINE, 'utf8')) as Record<string, string>;
    const actual: Record<string, string> = {};
    for (const s of SHOTS) actual[s.name] = hashOf(s.night, s.seconds);
    expect(actual, 'the room changed — render it, LOOK at it, then `npm run room:bless`').toEqual(
      baseline,
    );
  });

  it('draws something in every band of the room, not just the middle', () => {
    // A hash catches a change and says nothing about what broke. This says the wall, the floor,
    // the desk rows and the off-site strip all have ink in them — the shape of failure a
    // half-initialised buffer or a layer that stopped being called actually has.
    const px = pixelsOf(0, 3);
    const bands = [
      { name: 'wall', y0: 0, y1: 38 },
      { name: 'back desks', y0: 60, y1: 120 },
      { name: 'mid floor', y0: 120, y1: 180 },
      { name: 'front desks', y0: 180, y1: 240 },
      { name: 'off-site strip', y0: 244, y1: 270 },
    ];
    for (const b of bands) {
      const seen = new Set<string>();
      for (let y = b.y0; y < b.y1; y++) {
        for (let x = 0; x < 480; x++) {
          const i = (y * 480 + x) * 4;
          seen.add(`${px[i]},${px[i + 1]},${px[i + 2]}`);
        }
      }
      expect(seen.size, `${b.name} is a flat fill — nothing is being drawn there`).toBeGreaterThan(6);
    }
  });
});
