/**
 * Rewrites the room's visual baseline.
 *
 *   npx tsx scripts/bless.ts       (or `npm run room:bless`)
 *
 * Run this only after rendering the room and *looking* at it — `tests/room.test.ts` exists to
 * catch a change nobody meant to make, and blessing without looking turns the regression into the
 * thing the next change is measured against.
 */
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { paintRoom } from './roomCast';

const SHOTS: readonly { name: string; night: number; seconds: number }[] = [
  { name: 'room-day', night: 0, seconds: 3 },
  { name: 'room-night', night: 1, seconds: 3 },
  { name: 'room-spawn', night: 0, seconds: 0.8 },
];

const out: Record<string, string> = {};
for (const s of SHOTS) {
  out[s.name] = createHash('sha256')
    .update(Buffer.from(paintRoom(s.night, s.seconds).data))
    .digest('hex')
    .slice(0, 16);
}

const file = join(__dirname, '..', 'tests', 'room.baseline.json');
writeFileSync(file, `${JSON.stringify(out, null, 2)}\n`);
console.log(`blessed -> ${file}`);
for (const [name, hash] of Object.entries(out)) console.log(`  ${name} ${hash}`);
