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
import { clampView, frameCols, homeCam } from '../src/office/PixelOffice';
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

  it('does not let a vertical pan bring the ceiling back or cut the floor off', () => {
    // Selecting somebody in the top row glances the camera at them. `clampCam` allowed that to slide
    // the window up, and on a stage taller than the window the band above it filled with ceiling
    // while the floor's bottom edge left the screen — found by clicking a name in the roster.
    for (const g of STAGES) {
      for (const z of [1, 1.2, 1.5, 2, 3]) {
        for (const y of [0, 60, 135, 200, 270]) {
          const c = clampView({ x: 240, y, z }, g);
          expect(clampCam(c), 'still a camera the clamp accepts').toEqual(c);
          const b = blitOf(c, g);
          const hr = headroomOf(b, 72);
          const shown = (g.h * g.dpr) / b.scale;
          if (shown >= PIX.h) {
            // The stage shows the whole height: the window stays on the floor.
            expect(b.srcY + b.viewH, `${g.w}×${g.h} z${z} y${y}`).toBeCloseTo(PIX.h, 6);
          } else {
            // It does not: whatever part is shown, none of it is ceiling.
            expect(hr.ceilRows, `${g.w}×${g.h} z${z} y${y}`).toBeLessThanOrEqual(1);
          }
        }
      }
    }
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

describe('where a phone frame sits across a room it cannot show whole', () => {
  // 390×844's stage and the full twelve-desk room: the window is some 336 of the 480 columns.
  const g = geo(378, 330);
  const scale = PIX.w / SCENE.w;
  /** One pod desk's columns, about as wide as the scene publishes it plus the frame's margin. */
  const desk = (slot: number) => {
    const x = podSeat(slot).x * scale;
    return { from: x - 26, to: x + 26 };
  };
  const windowOf = (c: { x: number; z: number }) => ({ from: c.x - PIX.w / c.z / 2, to: c.x + PIX.w / c.z / 2 });
  const inside = (w: { from: number; to: number }, s: { from: number; to: number }) =>
    s.from >= w.from - 0.5 && s.to <= w.to + 0.5;

  it('still centres on the room when nobody is working', () => {
    const c = homeCam(PIX.w, g);
    expect(c.x).toBeCloseTo(PIX.w / 2, 6);
    expect(homeCam(PIX.w, g, [])).toEqual(c);
  });

  it('goes to the far bank when that is where the work is', () => {
    // The outer desks of the right bank — slots 3 and 7 — are exactly what the centred frame cut.
    const keep = [desk(3), desk(7)];
    const centred = windowOf(homeCam(PIX.w, g));
    expect(keep.some((s) => inside(centred, s))).toBe(false);
    const c = homeCam(PIX.w, g, keep, PIX.w / 2);
    expect(clampCam(c)).toEqual(c);
    for (const s of keep) expect(inside(windowOf(c), s)).toBe(true);
    // The zoom and the height are the frame's own; only where it sits across the room changed.
    expect(c.z).toBe(homeCam(PIX.w, g).z);
    expect(c.y).toBe(homeCam(PIX.w, g).y);
  });

  it('shows as many desks as fit when they cannot all, and stays put while that holds', () => {
    const keep = Array.from({ length: WAYPOINTS.podSeats.length }, (_, i) => desk(i));
    const count = (x: number, z: number) => keep.filter((s) => inside(windowOf({ x, z }), s)).length;
    const c = homeCam(PIX.w, g, keep, PIX.w / 2);
    // The four columns of desks do not all fit, so the frame has to choose: no place across the
    // room shows more whole desks than the one it chose.
    const half = PIX.w / c.z / 2;
    let most = 0;
    for (let x = half; x <= PIX.w - half; x += 0.5) most = Math.max(most, count(x, c.z));
    expect(most).toBeLessThan(keep.length);
    expect(count(c.x, c.z)).toBe(most);
    // Asked again from where it now is, it stays: a frame that re-aimed every tick would never rest.
    expect(homeCam(PIX.w, g, keep, c.x).x).toBe(c.x);
    // From the other side of the room it keeps the equally good place it is already near.
    const right = homeCam(PIX.w, g, keep, PIX.w);
    expect(count(right.x, right.z)).toBe(most);
    expect(right.x).toBeGreaterThan(c.x);
  });

  it('ignores the desks where the stage shows the whole room anyway', () => {
    const wide = geo(1022, 575);
    expect(homeCam(PIX.w, wide, [desk(3)], 0)).toEqual(homeCam(PIX.w, wide));
  });

  it('never leaves the room the session has', () => {
    // A small session draws a room narrower than the plan; the window stays inside it however far
    // toward its edge the desk it is asked to keep sits.
    const cols = frameCols(4);
    const c = homeCam(cols, g, [desk(3)], 0);
    expect(windowOf(c).to).toBeLessThanOrEqual(Math.max(cols, PIX.w / c.z) + 0.5);
    expect(windowOf(c).from).toBeGreaterThanOrEqual(-0.5);
  });
});
