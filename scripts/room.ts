/**
 * Renders the whole composed room to a PNG, without a browser.
 *
 *   npx tsx scripts/room.ts            day, night, and the moment a spawn edge is alive
 *   npx tsx scripts/room.ts 6          the same rooms at t = 6s, for checking animation phase
 *
 * The contact sheets prove a sprite is right on its own; only this proves the sprites belong to
 * the same room — that the desks are the right size for the people, that the light lands where
 * the lamps are, and that nothing is drawn behind something it should be in front of.
 *
 * The cast and the paint live in `roomCast.ts`, shared with `tests/room.test.ts`, which hashes
 * these exact pixels. A sheet nobody can regress against is a sheet that stops being reviewed.
 */
import { paintRoom } from './roomCast';
import { save } from './pixpreview';

function shoot(name: string, night: number, seconds: number): void {
  console.log(`${name} -> ${save(name, paintRoom(night, seconds), 3)}`);
}

const seconds = Number(process.argv[2] ?? 3);
shoot('room-day', 0, seconds);
shoot('room-night', 1, seconds);
// A third shot early in the spawn edge's life. The edge lives about two seconds and then draws
// nothing at all, so the two shots above — wound three seconds forward — are taken exactly when
// there is no line to look at, and the one piece of the room that answers "who asked whom" was
// invisible in every sheet anybody reviewed.
shoot('room-spawn', 0, 0.8);
