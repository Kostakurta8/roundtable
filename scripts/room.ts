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
import { paintRoom, paintStage } from './roomCast';
import { save } from './pixpreview';
import { type Cam, type Geo } from '../src/office/pixel/stage';

function shoot(name: string, night: number, seconds: number): void {
  console.log(`${name} -> ${save(name, paintRoom(night, seconds), 3)}`);
}

/**
 * The stage the shots below are composed on: a 1600x900 window with the rail out at its full width.
 *
 * Not an arbitrary size. This is the shape that makes the strip above the room as deep as it ever
 * realistically gets — the rail takes 264px off the width, so the fit is decided by width, and
 * around a sixth of the stage is left over across the top. That strip was black, and no sheet in
 * this directory could show it, because every one of them rendered the 480x270 buffer, which is the
 * one thing a viewer never sees on its own.
 */
const STAGE: Geo = { w: 1600, h: 900, dpr: 1, insetLeft: 264 };

/** Zoomed in and pushed to the bottom of the room, where the strip fills with real room instead. */
const LOW: Cam = { x: 240, y: 270, z: 2.2 };

function shootStage(name: string, night: number, seconds: number, cam?: Cam): void {
  console.log(`${name} -> ${save(name, paintStage(night, seconds, STAGE, cam), 1)}`);
}

const seconds = Number(process.argv[2] ?? 3);
shoot('room-day', 0, seconds);
shoot('room-night', 1, seconds);
// A third shot early in the spawn edge's life. The edge lives about two seconds and then draws
// nothing at all, so the two shots above — wound three seconds forward — are taken exactly when
// there is no line to look at, and the one piece of the room that answers "who asked whom" was
// invisible in every sheet anybody reviewed.
shoot('room-spawn', 0, 0.8);
// And the room as a viewer actually gets it. Day and night because the ceiling has to match the
// wall's own night wash at the row they meet, and zoomed-low because that is the case where the
// strip is filled with real buffer rows rather than with ceiling.
shootStage('stage-day', 0, seconds);
shootStage('stage-night', 1, seconds);
shootStage('stage-zoom', 0, seconds, LOW);
