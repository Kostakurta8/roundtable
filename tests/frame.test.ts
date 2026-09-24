/**
 * Where the camera rests.
 *
 * The room used to rest at zoom 1 — the whole 480×270 buffer fitted to the stage — and every stage
 * in the shell is taller than 16:9, so at 1440×900 it came out as a 776px-wide office under a third
 * of a stage of ceiling, its people ten pixels tall. The resting frame is now computed from the
 * stage and the session's own room (`homeCam`, `frameCols`), and what it owes the viewer is a short
 * list, each item of which is asserted here rather than eyeballed:
 *
 * - the whole height, wall to floor, is on screen — never cropped, whatever the zoom;
 * - the room the session actually has fits across it, whenever the stage can afford that;
 * - no band of ceiling is left over when the room is narrow enough to fill the stage;
 * - it is a camera `clampCam` would accept, so it cannot show the void past the buffer;
 * - and the frame only ever widens as a session grows, because the room only ever does.
 */
import { describe, expect, it } from 'vitest';
import { podSeat, SCENE, WAYPOINTS } from '../src/office/engine';
import { frameCols, homeCam } from '../src/office/PixelOffice';
import { PIX } from '../src/office/pixel/art';
import { blitOf, clampCam, headroomOf, ZOOM_MAX, ZOOM_MIN, type Geo } from '../src/office/pixel/stage';

const geo = (w: number, h: number, insetLeft = 0, dpr = 1): Geo => ({ w, h, dpr, insetLeft });

/** Stages the shell actually produces, and a few it could: desktop, laptop, tablet, phone, odd. */
const STAGES: readonly Geo[] = [
  geo(1022, 575), // 1440×900 with the roster strip under the room
  geo(1022, 701),
  geo(674, 526), // 1024×700
  geo(378, 330), // 390×844, stacked
  geo(1500, 846),
  geo(1898, 946, 244), // very wide, roster column beside the room
  geo(800, 1400), // tall portrait window
  geo(1022, 575, 0, 2),
];

const COLS = [frameCols(0), frameCols(2), frameCols(4), PIX.w];

describe('how wide the session’s room is', () => {
  it('is the whole plan once the room has drawn every desk, and less than it before', () => {
    expect(frameCols(WAYPOINTS.podSeats.length)).toBe(PIX.w);
    expect(frameCols(0)).toBeLessThan(PIX.w);
  });

  it('only ever widens as desks are added', () => {
    for (let n = 1; n <= WAYPOINTS.podSeats.length + 2; n++) {
      expect(frameCols(n), `high water ${n}`).toBeGreaterThanOrEqual(frameCols(n - 1));
    }
  });

  it('reaches past every desk the room has drawn', () => {
    // The desk's centre is its seat; its right edge and nameplate are some pixels further. A frame
    // that stopped at the seat would cut the right-hand desk in half.
    const scale = PIX.w / SCENE.w;
    for (let n = 0; n <= WAYPOINTS.podSeats.length; n++) {
      for (let i = 0; i < n; i++) {
        expect(frameCols(n), `desk ${i} at high water ${n}`).toBeGreaterThan(podSeat(i).x * scale + 20);
      }
    }
  });
});

describe('where the camera rests', () => {
  it('is always a camera the clamp accepts', () => {
    for (const g of STAGES) {
      for (const cols of COLS) {
        const c = homeCam(cols, g);
        expect(clampCam(c)).toEqual(c);
        expect(c.z).toBeGreaterThanOrEqual(ZOOM_MIN);
        expect(c.z).toBeLessThanOrEqual(ZOOM_MAX);
      }
    }
  });

  it('shows the whole height of the room — the wall is never what gets cropped', () => {
    for (const g of STAGES) {
      for (const cols of COLS) {
        const b = blitOf(homeCam(cols, g), g);
        // The window rests on the floor's bottom edge…
        expect(b.srcY + b.viewH, `${g.w}×${g.h} cols ${cols}`).toBeCloseTo(PIX.h, 6);
        // …and every row above it is painted from the room itself in the headroom, down from row 0.
        const hr = headroomOf(b, 72);
        expect(hr.roomRows, `${g.w}×${g.h} cols ${cols}`).toBe(Math.max(0, b.srcY));
      }
    }
  });

  it('fits the session’s room across the stage whenever the stage can afford it', () => {
    for (const g of STAGES.filter((s) => s.w - s.insetLeft > 600)) {
      for (const cols of COLS) {
        const b = blitOf(homeCam(cols, g), g);
        expect(b.srcX, `${g.w}×${g.h} cols ${cols}`).toBeLessThanOrEqual(0.5);
        expect(b.srcX + b.viewW, `${g.w}×${g.h} cols ${cols}`).toBeGreaterThanOrEqual(cols - 0.5);
      }
    }
  });

  it('leaves no band of ceiling when a narrow room can fill a tall stage', () => {
    // 1440×900 with one row of roster under the room — which is what the shell gives a two-desk
    // session — and that session's room: narrow enough to be drawn at the stage's full height, so
    // it is, and the band of ceiling it used to sit under is gone.
    const g = geo(1022, 661);
    const b = blitOf(homeCam(frameCols(2), g), g);
    const hr = headroomOf(b, 72);
    expect(hr.ceilRows).toBeLessThanOrEqual(1);
    expect(b.px).toBeGreaterThan(1022 / PIX.w);
  });

  it('is the whole room at zoom 1 on a stage the room already fills', () => {
    const g = geo(1024, 576);
    expect(homeCam(PIX.w, g)).toEqual(clampCam({ x: PIX.w / 2, y: PIX.h / 2, z: 1 }));
  });

  it('crops the sides rather than draw a phone’s people ten pixels tall', () => {
    // 378 CSS pixels for 480 columns is 0.79px a pixel. The rest frame trades the outer desks for a
    // readable room, but only as far as the stage's height allows — the wall is still never cut.
    const g = geo(378, 330);
    const b = blitOf(homeCam(PIX.w, g), g);
    expect(b.px).toBeGreaterThan(378 / PIX.w);
    expect(b.viewW).toBeLessThan(PIX.w);
    expect(headroomOf(b, 72).roomRows).toBe(Math.max(0, b.srcY));
  });
});
