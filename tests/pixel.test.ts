/**
 * The pixel renderer, checked without a browser.
 *
 * `scripts/pixpreview.ts` implements exactly the slice of the 2D context the renderer uses, over a
 * flat RGBA buffer — which means the room can be *drawn* in a unit test and the result inspected
 * pixel by pixel. That is worth far more here than asserting on the calls made: a sprite that
 * draws the right rectangles in the wrong order is still wrong, and only the buffer knows.
 */
import { describe, expect, it } from 'vitest';
import { asCtx, SoftCtx } from '../scripts/pixpreview';
import type { ActorState } from '../src/office/engine';
import { MANAGER_DESK_INDEX, podSeat, SCENE, WAYPOINTS } from '../src/office/engine';
import {
  actLine,
  blitOf,
  CAM_HOME,
  clampCam,
  noteLine,
  subtreeOf,
  toBuffer,
  ZOOM_MAX,
  ZOOM_MIN,
  type Blit,
  type Cam,
  type Geo,
} from '../src/office/PixelOffice';
import type { RtAgent } from '../src/store';
import { drawArt, drawText, PAL, PIX, pool, textWidth, type Art, type Look } from '../src/office/pixel/art';
import {
  FIXTURE_NAMES,
  fixtureBox,
  paintFixture,
  S,
  Scene,
  type SceneAgent,
  type SceneInput,
} from '../src/office/pixel/scene';

const LOOK: Look = {
  skin: '#e2a87c',
  skinShade: '#a06a44',
  hair: '#2e2a26',
  hairShade: '#151312',
  shirt: '#3e9aa8',
  shirtShade: '#1e7280',
  trouser: '#3a3e44',
};

/** The colour at (x, y), as `#rrggbb`, or `null` where nothing was drawn. */
function at(ctx: SoftCtx, x: number, y: number): string | null {
  const i = (y * ctx.width + x) * 4;
  if (ctx.data[i + 3] === 0) return null;
  const hex = (n: number): string => n.toString(16).padStart(2, '0');
  return `#${hex(ctx.data[i])}${hex(ctx.data[i + 1])}${hex(ctx.data[i + 2])}`;
}

const inkColumns = (ctx: SoftCtx): number[] => {
  const cols: number[] = [];
  for (let x = 0; x < ctx.width; x++) {
    for (let y = 0; y < ctx.height; y++) {
      if (ctx.data[(y * ctx.width + x) * 4 + 3] > 0) {
        cols.push(x);
        break;
      }
    }
  }
  return cols;
};

describe('the label font', () => {
  // Every character the room can be asked to draw: agent ids and labels are arbitrary text, and a
  // glyph that renders as nothing turns a name into a shorter, different name.
  const CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789.,:-_/+?!#%()<>*@$&';

  it('draws ink for every glyph it claims to have', () => {
    for (const ch of CHARS) {
      const ctx = new SoftCtx(6, 8);
      drawText(asCtx(ctx), ch, 1, 1, '#ffffff');
      expect(inkColumns(ctx).length, `glyph ${ch} drew nothing`).toBeGreaterThan(0);
    }
  });

  it('gives visibly different shapes to the pairs a 3px grid tends to collide', () => {
    const bitmap = (ch: string): string => {
      const ctx = new SoftCtx(4, 6);
      drawText(asCtx(ctx), ch, 0, 0, '#ffffff');
      return [...ctx.data].join(',');
    };
    for (const [a, b] of [
      ['M', 'N'],
      ['U', 'V'],
      ['V', 'Y'],
      ['O', 'Q'],
      ['B', 'R'],
      ['E', 'F'],
      ['C', 'G'],
      ['0', 'O'],
      ['1', 'I'],
    ]) {
      expect(bitmap(a), `${a} and ${b} render identically`).not.toBe(bitmap(b));
    }
  });

  it('renders an unknown character as a block rather than as a gap', () => {
    const ctx = new SoftCtx(6, 8);
    drawText(asCtx(ctx), 'Ж', 1, 1, '#ffffff');
    expect(inkColumns(ctx).length).toBeGreaterThan(0);
  });

  it('reports a width that matches what it draws', () => {
    for (const s of ['MAIN', 'QA-2', '12.4K TOK', 'A B']) {
      const ctx = new SoftCtx(120, 8);
      drawText(asCtx(ctx), s, 0, 1, '#ffffff');
      const cols = inkColumns(ctx);
      // The advance includes the 1px gap after the last glyph's cell only for inner glyphs, so the
      // rightmost ink must land inside the reported width and within a pixel of its edge.
      expect(Math.max(...cols)).toBeLessThan(textWidth(s));
      expect(Math.max(...cols)).toBeGreaterThanOrEqual(textWidth(s) - 3);
    }
  });
});

describe('the blitter', () => {
  const SPR: Art = { rows: ['ab.', 'TS.'], map: { a: 'ok', b: 'err' } };

  it('resolves the reserved slots from the look, not from the palette', () => {
    const ctx = new SoftCtx(4, 3);
    drawArt(asCtx(ctx), SPR, 0, 0, { look: LOOK });
    expect(at(ctx, 0, 0)).toBe(PAL.ok);
    expect(at(ctx, 1, 0)).toBe(PAL.err);
    expect(at(ctx, 0, 1)).toBe(LOOK.shirt);
    expect(at(ctx, 1, 1)).toBe(LOOK.skin);
    expect(at(ctx, 2, 0)).toBeNull();
  });

  it('mirrors about the sprite width when flipped', () => {
    const ctx = new SoftCtx(4, 3);
    drawArt(asCtx(ctx), SPR, 0, 0, { look: LOOK, flip: true });
    // Column 0 becomes column 2 in a 3-wide sprite.
    expect(at(ctx, 2, 0)).toBe(PAL.ok);
    expect(at(ctx, 1, 0)).toBe(PAL.err);
  });

  it('paints a silhouette when tinted, ignoring every colour the sprite declares', () => {
    const ctx = new SoftCtx(4, 3);
    drawArt(asCtx(ctx), SPR, 0, 0, { look: LOOK, tint: '#ff00ff' });
    expect(at(ctx, 0, 0)).toBe('#ff00ff');
    expect(at(ctx, 1, 1)).toBe('#ff00ff');
    expect(at(ctx, 2, 0)).toBeNull(); // transparent stays transparent
  });

  it('draws nothing at all at zero alpha', () => {
    const ctx = new SoftCtx(4, 3);
    drawArt(asCtx(ctx), SPR, 0, 0, { look: LOOK, alpha: 0 });
    expect(inkColumns(ctx)).toEqual([]);
  });
});

describe('light pools', () => {
  it('are symmetric about their centre and stay inside their radii', () => {
    const ctx = new SoftCtx(41, 21);
    pool(asCtx(ctx), 20, 10, 15, 7, PAL.lmp, 0.8);
    for (let d = 1; d <= 15; d++) {
      expect(at(ctx, 20 - d, 10), `asymmetric at ${d}`).toBe(at(ctx, 20 + d, 10));
    }
    expect(at(ctx, 0, 10)).toBeNull();
    expect(at(ctx, 20, 0)).toBeNull();
  });
});

// ------------------------------------------------------------------ the room

const seatOf = (i: number): { x: number; y: number } =>
  i === MANAGER_DESK_INDEX ? WAYPOINTS.managerSeat : podSeat(i);

function actor(id: string, deskIndex: number, over: Partial<ActorState> = {}): ActorState {
  const p = seatOf(deskIndex);
  return {
    id,
    x: p.x,
    y: p.y,
    pose: 'sit',
    flip: false,
    away: true,
    status: '2.1k tok',
    deskIndex,
    busy: 0,
    waiting: 0,
    fails: 0,
    resolved: 0,
    edits: 0,
    ...over,
  };
}

function input(actors: readonly ActorState[], over: Partial<SceneInput> = {}): SceneInput {
  const agents: Record<string, SceneAgent> = {};
  for (const a of actors) {
    agents[a.id] = {
      label: a.id,
      look: { tint: '#3e9aa8', color: '#1e7280', skin: '#b97c50', hair: '#1f1c19' },
      status: a.status,
    };
  }
  return {
    actors,
    agents,
    task: 'find the flaky test',
    turns: 12,
    selected: null,
    ghosts: [],
    night: 0,
    dt: 16,
    ...over,
  };
}

/** Draws `frames` ticks of a room and hands back the buffer. */
function room(actors: readonly ActorState[], over: Partial<SceneInput> = {}, frames = 8): SoftCtx {
  const ctx = new SoftCtx(PIX.w, PIX.h);
  const scene = new Scene();
  for (let i = 0; i < frames; i++) scene.draw(asCtx(ctx), input(actors, over));
  return ctx;
}

describe('the scene', () => {
  const CAST = [actor('main', MANAGER_DESK_INDEX), actor('explore', 0), actor('finder', 1)];

  it('maps the engine basis onto the buffer exactly', () => {
    // 1600x900 to 480x270 is a flat x0.3 with no remainder, which is what lets an actor's engine
    // coordinate be a canvas coordinate with no special case anywhere in the renderer.
    expect(S).toBe(0.3);
    expect(SCENE.w * S).toBe(PIX.w);
    expect(SCENE.h * S).toBe(PIX.h);
  });

  it('covers every pixel of the buffer, so no frame can show through to the last one', () => {
    const ctx = room(CAST);
    for (let y = 0; y < PIX.h; y++) {
      for (let x = 0; x < PIX.w; x++) {
        expect(ctx.data[(y * PIX.w + x) * 4 + 3], `transparent hole at ${x},${y}`).toBe(255);
      }
    }
  });

  it('is deterministic: the same ticks always paint the same room', () => {
    // The whole point of driving animation off the tick delta rather than the wall clock. Without
    // it a recorded session could not be replayed, because the air in the room would differ.
    const a = room(CAST, {}, 30);
    const b = room(CAST, {}, 30);
    expect([...a.data]).toEqual([...b.data]);
  });

  it('puts an actor exactly where the simulation says, in canvas pixels', () => {
    const ctx = new SoftCtx(PIX.w, PIX.h);
    const scene = new Scene();
    const walker = actor('walker', 0, { x: 1000, y: 600, pose: 'walk', away: false });
    scene.draw(asCtx(ctx), input([walker]));
    const box = scene.boxOf('walker');
    expect(box).toBeDefined();
    expect(box!.x + box!.w / 2).toBe(300); // 1000 * 0.3
    expect(box!.y + box!.h).toBe(180); // 600 * 0.3, feet on the reported row
  });

  it('forgets an actor that leaves, so a later agent cannot inherit its position', () => {
    const ctx = new SoftCtx(PIX.w, PIX.h);
    const scene = new Scene();
    scene.draw(asCtx(ctx), input([actor('gone', 0)]));
    expect(scene.boxOf('gone')).toBeDefined();
    scene.draw(asCtx(ctx), input([actor('other', 1)]));
    expect(scene.boxOf('gone')).toBeUndefined();
  });

  it('paints a different room by night than by day', () => {
    const day = room(CAST, { night: 0 }, 60);
    const dusk = room(CAST, { night: 1 }, 60);
    expect([...day.data]).not.toEqual([...dusk.data]);
  });

  it('draws the off-site strip only when there is someone off-site', () => {
    const without = room(CAST, { ghosts: [] });
    const with_ = room(CAST, {
      ghosts: Array.from({ length: 30 }, (_, i) => ({
        id: `wf-${i}`,
        label: `agent ${i}`,
        look: { tint: '#d89440', color: '#a06a18', skin: '#8e5a38', hair: '#14110e' },
        busy: i % 2 === 0,
      })),
    });
    // The band is at the very bottom of the buffer, so that is where they must differ.
    const bottomRow = (c: SoftCtx): number[] => [...c.data.slice((PIX.h - 4) * PIX.w * 4)];
    expect(bottomRow(without)).not.toEqual(bottomRow(with_));
  });

  it('survives an actor parked outside the room without throwing', () => {
    // A truncated backlog can hand the office a position it never walked to. Clipping is the
    // software canvas's job; not crashing is the renderer's.
    expect(() => room([actor('stray', 0, { x: -400, y: 4000 })])).not.toThrow();
  });
});

// -------------------------------------------------------------- clickable fixtures

/**
 * A fixture's hit box against the pixels that fixture actually paints.
 *
 * The whiteboard and the roundtable are the only two things in the room that are clicked as
 * *objects* rather than as people, and their boxes were both wrong for the same reason: they were
 * written by hand, next to a comment about where the scene draws them, rather than derived from
 * the draw call. A test that pinned the corrected numbers would have been worth nothing — it would
 * have re-frozen exactly the copy that drifted the first time. So nothing here mentions a
 * coordinate. Each fixture is painted alone into an empty buffer, the ink is measured, and the box
 * it publishes has to sit on that ink: move the anchor, resize the sprite, or change which draw
 * function paints it, and this fails until the two agree again.
 */
describe('the clickable fixtures', () => {
  /**
   * How far the paint may fall short of its box's edge before the box has stopped being a hit
   * target for that fixture and started being a rectangle it happens to sit inside.
   *
   * Two pixels, because a footprint is declared in whole pixels and an anchor need not be: the
   * table's centre falls on 304.8, so its 58-wide box cannot land flush against a sprite whose own
   * columns rounded away from it. It is nowhere near loose enough to hide either bug this replaces
   * — those were out by fourteen rows and by seven.
   */
  const FIT_SLACK = 2;

  /**
   * The bounds of everything drawn at full opacity, or `null` if nothing was.
   *
   * Opacity is the discriminator between the object and the light it casts. `drawRoundtable` lays
   * a banded contact shadow on the floor under the table, wider than the table and reaching past
   * its near edge; that shadow is not the table, and a button covering it would be a button over
   * the rug. Every pixel of the fixture's own body is laid down opaque.
   */
  function solidBounds(ctx: SoftCtx): { x0: number; y0: number; x1: number; y1: number } | null {
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (let y = 0; y < ctx.height; y++) {
      for (let x = 0; x < ctx.width; x++) {
        if (ctx.data[(y * ctx.width + x) * 4 + 3] !== 255) continue;
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
    return x1 < x0 ? null : { x0, y0, x1, y1 };
  }

  // A busy session, so the whiteboard paints everything it has: two wrapped lines of task, a tally
  // of live and finished agents, and a full spend bar.
  const BUSY = input([actor('main', MANAGER_DESK_INDEX), actor('explore', 0)], {
    task: 'work out which of the tailer passes is dropping the last megabyte',
    spend: 1,
    ghosts: [
      {
        id: 'gone',
        label: 'gone',
        look: { tint: '#d89440', color: '#a06a18', skin: '#8e5a38', hair: '#14110e' },
        busy: false,
        done: true,
      },
    ],
  });

  it('knows about every fixture the room can be clicked on', () => {
    expect([...FIXTURE_NAMES].sort()).toEqual(['roundtable', 'whiteboard']);
  });

  for (const name of FIXTURE_NAMES) {
    it(`${name}: its box covers the pixels it paints, and no more`, () => {
      const ctx = new SoftCtx(PIX.w, PIX.h);
      paintFixture(asCtx(ctx), name, BUSY);
      const ink = solidBounds(ctx);
      expect(ink, `${name} painted nothing at all`).not.toBeNull();
      const { x0, y0, x1, y1 } = ink!;

      // The box is published in top-left/width/height; the ink in inclusive bounds.
      const box = fixtureBox(name);
      const right = box.x + box.w - 1;
      const bottom = box.y + box.h - 1;

      // Every pixel of the fixture is inside its own hit target. This is the half that both of the
      // hand-written boxes failed: the board's missed its top fourteen rows including both lines
      // of the task, the table's missed its pedestal and foot.
      expect(x0, `${name} paints ${box.x - x0} px left of its box`).toBeGreaterThanOrEqual(box.x);
      expect(y0, `${name} paints ${box.y - y0} px above its box`).toBeGreaterThanOrEqual(box.y);
      expect(x1, `${name} paints ${x1 - right} px right of its box`).toBeLessThanOrEqual(right);
      expect(y1, `${name} paints ${y1 - bottom} px below its box`).toBeLessThanOrEqual(bottom);

      // And the box is the fixture rather than a generous rectangle around it — otherwise the
      // containment above could always be satisfied by claiming the whole wall.
      expect(x0 - box.x, `${name}'s box has bare space on its left`).toBeLessThanOrEqual(FIT_SLACK);
      expect(y0 - box.y, `${name}'s box has bare space above it`).toBeLessThanOrEqual(FIT_SLACK);
      expect(right - x1, `${name}'s box has bare space on its right`).toBeLessThanOrEqual(FIT_SLACK);
      expect(bottom - y1, `${name}'s box has bare space below it`).toBeLessThanOrEqual(FIT_SLACK);
    });

  }

  it('gives the two fixtures boxes that do not overlap', () => {
    // A click has to have one answer. They are at opposite ends of the room today; this is the
    // assertion that notices if one of them is ever moved on top of the other.
    const [a, b] = FIXTURE_NAMES.map(fixtureBox);
    const apart = a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y;
    expect(apart).toBe(true);
  });
});

// ------------------------------------------------------- the blit and its inverse

/**
 * The one piece of arithmetic in the renderer that exists twice.
 *
 * `PixelOffice.tsx`'s header used to say that because everything goes through `blitOf`, "there is
 * no second copy of that arithmetic to drift". `toBuffer` is that second copy. It is the algebraic
 * inverse of the placement, hand-written, and it is what the wheel zooms about and what turns a
 * pointer into a room coordinate — so the failure it can have is silent and total: the room paints
 * correctly and the hit layer sits somewhere else, or a zoom about the cursor walks the room out
 * from under the hand. Nothing had ever asserted the two agree.
 *
 * This is that assertion, as a property rather than as a table of expected numbers: for a spread of
 * cameras, zooms, device pixel ratios and rail insets, every buffer point taken to the screen and
 * back has to come home.
 */
describe('the blit and its inverse', () => {
  /**
   * Buffer pixels to CSS pixels on the stage.
   *
   * Written here exactly as `place`, the fixtures and the hover card all write it inside
   * `PixelOffice` — `b.dx + (v - b.srcX) * b.px`. Restating it is the test: `toBuffer` claims to
   * invert *this*, so this is the thing it has to be held against. If the component's placement
   * ever stops being this expression, or `toBuffer` ever stops inverting it, the two disagree here
   * before anybody has to notice a mis-aimed click in a browser.
   */
  const toScreen = (b: Blit, x: number, y: number): { x: number; y: number } => ({
    x: b.dx + (x - b.srcX) * b.px,
    y: b.dy + (y - b.srcY) * b.px,
  });

  /**
   * Stages worth checking, not stages picked for variety.
   *
   * The rail's three real widths are in here on purpose: `--rail-w` is 264 normally, drops to 210
   * at ≤1180px, and the rail is `display: none` at ≤900px — so `insetLeft` is one of three numbers
   * in practice and the third one is zero. The 420-wide stage is the case where the inset is more
   * than 45% of the width and `blitOf`'s `Math.max(g.w * 0.55, …)` floor takes over, which is the
   * only branch in the function.
   */
  const GEOS: readonly Geo[] = [
    { w: 1440, h: 780, dpr: 1, insetLeft: 0 },
    { w: 1440, h: 780, dpr: 2, insetLeft: 264 },
    { w: 1100, h: 620, dpr: 1.5, insetLeft: 210 },
    { w: 860, h: 500, dpr: 3, insetLeft: 0 },
    { w: 420, h: 900, dpr: 2, insetLeft: 264 },
    { w: 1920, h: 1080, dpr: 1, insetLeft: 0 },
    { w: 1, h: 1, dpr: 1, insetLeft: 0 },
  ];

  /** Both zoom limits, both diagonal corners, and a few positions that land on no round number. */
  const CAMS: readonly Cam[] = [
    CAM_HOME,
    { x: 0, y: 0, z: ZOOM_MAX },
    { x: PIX.w, y: PIX.h, z: ZOOM_MAX },
    { x: 137, y: 211, z: 2.2 },
    { x: 401, y: 93, z: 1.37 },
    { x: 240, y: 135, z: ZOOM_MIN },
  ];

  /** The buffer's own corners and centre, plus three anchors the room actually cares about. */
  const POINTS: readonly (readonly [number, number])[] = [
    [0, 0],
    [PIX.w - 1, PIX.h - 1],
    [PIX.w / 2, PIX.h / 2],
    [0, PIX.h - 1],
    [PIX.w - 1, 0],
    [205, 35], // the whiteboard
    [305, 190], // the roundtable
    [31, 68], // the coffee machine
  ];

  /**
   * How far a buffer point may move by going to the screen and back.
   *
   * The two functions are exact inverses over the reals — one adds `dx` and multiplies by `px`, the
   * other subtracts `dx` and divides by `px` — so on a machine the only error there can be is
   * `((v - srcX) * px) / px` losing a couple of units in the last place. Over coordinates bounded
   * by 480 that is on the order of 1e-13, so a nanopixel is a thousand times the noise floor and
   * still five hundred million times tighter than "a rounding step". Anything that fails this is a
   * formula that changed, not a float that rounded — which is exactly the distinction a tolerance
   * of half a pixel would have thrown away.
   */
  const EXACT = 1e-9;

  const each = (fn: (b: Blit, g: Geo, c: Cam, where: string) => void): void => {
    for (const g of GEOS) {
      for (const c of CAMS) {
        const cam = clampCam(c);
        fn(
          blitOf(cam, g),
          g,
          cam,
          `cam ${c.x},${c.y}@${c.z}x on ${g.w}x${g.h}@${g.dpr}dpr, rail ${g.insetLeft}`,
        );
      }
    }
  };

  it('takes a buffer point to the screen and back to itself', () => {
    each((b, _g, _c, where) => {
      for (const [x, y] of POINTS) {
        const s = toScreen(b, x, y);
        const back = toBuffer(b, s.x, s.y);
        expect(Math.abs(back.x - x), `x drifted at ${x},${y} — ${where}`).toBeLessThan(EXACT);
        expect(Math.abs(back.y - y), `y drifted at ${x},${y} — ${where}`).toBeLessThan(EXACT);
      }
    });
  });

  it('still lands within one rounding step once the DOM layer has rounded the placement', () => {
    // The trip a real click makes is not the algebra above: `place` rounds `left` and `top` to
    // whole CSS pixels, because a mark cannot be positioned on a fraction of one. What the pair
    // must not do is lose *more* than that rounding — half a CSS pixel, which is `0.5 / px` in
    // buffer pixels, and which is the whole reason the tolerance above is not simply "a pixel".
    each((b, _g, _c, where) => {
      const slack = 0.5 / b.px + EXACT;
      for (const [x, y] of POINTS) {
        const s = toScreen(b, x, y);
        const back = toBuffer(b, Math.round(s.x), Math.round(s.y));
        expect(Math.abs(back.x - x), `x lost more than a rounding step at ${x},${y} — ${where}`)
          .toBeLessThanOrEqual(slack);
        expect(Math.abs(back.y - y), `y lost more than a rounding step at ${x},${y} — ${where}`)
          .toBeLessThanOrEqual(slack);
      }
    });
  });

  it('puts the buffer’s source origin exactly at the room’s top left corner on screen', () => {
    // The one point where the round trip is not a round trip but an identity: `(dx, dy)` is where
    // the room's `(srcX, srcY)` is drawn, so inverting it must give those back with no arithmetic
    // at all. It fails the moment `dx` stops being `destX / dpr`.
    each((b, _g, _c, where) => {
      const origin = toBuffer(b, b.dx, b.dy);
      expect(origin.x, `origin x — ${where}`).toBe(b.srcX);
      expect(origin.y, `origin y — ${where}`).toBe(b.srcY);
    });
  });

  it('keeps the room bottom-aligned on the stage, at every ratio', () => {
    // Not the inverse, but the property the inverse is derived from and the one thing about the
    // blit a reader has to trust: the room's last row is the stage's last row. The comment in
    // `blitOf` says so; nothing said it twice.
    each((b, g, _c, where) => {
      expect(b.px, `zero magnification — ${where}`).toBeGreaterThan(0);
      expect(b.destY, `room starts above the stage — ${where}`).toBeGreaterThanOrEqual(0);
      expect(Math.abs(b.destY + b.destH - g.h * g.dpr), `not bottom-aligned — ${where}`)
        .toBeLessThanOrEqual(0.5);
    });
  });
});

// ---------------------------------------------------------------------- the camera

/** Float slack for the clamp's inequalities. Its arithmetic is min/max, so this is noise only. */
const EPS = 1e-9;

describe('the camera clamp', () => {
  /** The half-extents of the view at a zoom — the arithmetic the clamp exists to respect. */
  const halfOf = (z: number): { w: number; h: number } => ({ w: PIX.w / z / 2, h: PIX.h / z / 2 });

  it('holds the zoom between its two limits', () => {
    expect(clampCam({ x: 0, y: 0, z: 0 }).z).toBe(ZOOM_MIN);
    expect(clampCam({ x: 0, y: 0, z: -4 }).z).toBe(ZOOM_MIN);
    expect(clampCam({ x: 0, y: 0, z: 1e6 }).z).toBe(ZOOM_MAX);
    expect(clampCam({ x: 0, y: 0, z: 2.2 }).z).toBe(2.2);
  });

  it('pins the camera to the room’s centre when the whole room is in view', () => {
    // At `ZOOM_MIN` the half-extents *are* the buffer's, so the lower and upper bounds meet and
    // there is exactly one legal camera. This is why selecting somebody appears to do nothing
    // until you have zoomed in — the glance is computed and then clamped away.
    for (const c of [{ x: -9000, y: -9000 }, { x: 9000, y: 9000 }, { x: 1, y: PIX.h - 1 }]) {
      expect(clampCam({ ...c, z: ZOOM_MIN })).toEqual({ x: PIX.w / 2, y: PIX.h / 2, z: ZOOM_MIN });
    }
    expect(clampCam(CAM_HOME)).toEqual(CAM_HOME);
  });

  it('stops exactly on the buffer’s edges at full zoom', () => {
    const h = halfOf(ZOOM_MAX);
    expect(clampCam({ x: -1e6, y: -1e6, z: ZOOM_MAX })).toEqual({ x: h.w, y: h.h, z: ZOOM_MAX });
    expect(clampCam({ x: 1e6, y: 1e6, z: ZOOM_MAX })).toEqual({
      x: PIX.w - h.w,
      y: PIX.h - h.h,
      z: ZOOM_MAX,
    });
  });

  it('never lets the view leave the buffer, at any zoom or position', () => {
    // The invariant, rather than the formula: whatever comes back, the rectangle it is the centre
    // of lies inside the room. A clamp written per-axis against the wrong half-extent would still
    // return plausible numbers and would still show the void past the wall.
    for (const z of [ZOOM_MIN, 1.001, 1.37, 2, 2.2, 2.999, ZOOM_MAX]) {
      for (const x of [-500, 0, 79, 240, PIX.w - 1, 900]) {
        for (const y of [-500, 0, 68, 135, PIX.h - 1, 900]) {
          const c = clampCam({ x, y, z });
          const h = halfOf(c.z);
          const at = `${x},${y}@${z}x`;
          expect(c.x - h.w, `view spills left at ${at}`).toBeGreaterThanOrEqual(-EPS);
          expect(c.x + h.w, `view spills right at ${at}`).toBeLessThanOrEqual(PIX.w + EPS);
          expect(c.y - h.h, `view spills above at ${at}`).toBeGreaterThanOrEqual(-EPS);
          expect(c.y + h.h, `view spills below at ${at}`).toBeLessThanOrEqual(PIX.h + EPS);
        }
      }
    }
  });

  it('is idempotent, so the frame loop easing toward a clamped camera cannot creep', () => {
    // The loop clamps the eased camera on every frame and stores the result back. A clamp that
    // moved an already-clamped camera by anything at all would drift the room sixty times a second.
    for (const c of [
      { x: -50, y: 400, z: 4 },
      { x: 240, y: 135, z: 1 },
      { x: 137, y: 211, z: 2.2 },
      { x: 1e6, y: -1e6, z: 0.1 },
    ]) {
      const once = clampCam(c);
      expect(clampCam(once)).toEqual(once);
    }
  });
});

// ----------------------------------------------------------------- the spawn tree

describe('the spawn subtree', () => {
  /**
   * A spawn forest from nothing but its edges.
   *
   * `subtreeOf` reads exactly one field of an `RtAgent`. Building thirteen-field agents per node
   * would be noise that asserts nothing, and would quietly freeze the shape of a type this function
   * does not depend on into a test about tree walking.
   */
  const forest = (edges: Readonly<Record<string, string | undefined>>): Record<string, RtAgent> => {
    const out: Record<string, Partial<RtAgent>> = {};
    for (const [id, parentId] of Object.entries(edges)) out[id] = { id, parentId };
    return out as Record<string, RtAgent>;
  };

  const TREE = forest({
    main: undefined,
    explore: 'main',
    verify: 'main',
    grep: 'explore',
    read: 'explore',
    deep: 'grep',
    orphan: undefined,
  });

  it('returns the root and everything under it', () => {
    expect([...subtreeOf(TREE, 'main')].sort()).toEqual(
      ['deep', 'explore', 'grep', 'main', 'read', 'verify'].sort(),
    );
  });

  it('returns a branch without its siblings or its parent', () => {
    expect([...subtreeOf(TREE, 'explore')].sort()).toEqual(['deep', 'explore', 'grep', 'read']);
  });

  it('returns a leaf as itself alone', () => {
    expect([...subtreeOf(TREE, 'deep')]).toEqual(['deep']);
    expect([...subtreeOf(TREE, 'orphan')]).toEqual(['orphan']);
  });

  it('returns an id it has never heard of as itself, rather than as nothing', () => {
    // The dim rule is "everyone outside the tree", so an empty set would grey out the entire room
    // on a selection the agent map has not caught up with yet.
    expect([...subtreeOf(TREE, 'nobody')]).toEqual(['nobody']);
    expect([...subtreeOf({}, 'main')]).toEqual(['main']);
  });

  it('terminates on a cycle instead of hanging the room', () => {
    // A malformed transcript is allowed to be malformed: `parentId` comes off the wire, and two
    // agents each claiming the other is unlikely but not impossible. The room is not allowed to
    // spin on it — this test hangs the whole suite if the visited guard is ever dropped.
    const ring = forest({ a: 'b', b: 'c', c: 'a' });
    expect([...subtreeOf(ring, 'a')].sort()).toEqual(['a', 'b', 'c']);
    expect([...subtreeOf(ring, 'b')].sort()).toEqual(['a', 'b', 'c']);

    const selfParent = forest({ z: 'z' });
    expect([...subtreeOf(selfParent, 'z')]).toEqual(['z']);

    // Every agent carries exactly one `parentId`, so a ring can never be *entered* from outside
    // it: what a malformed transcript can produce is a cycle standing beside the tree, not one
    // hanging off it. Both have to come back, and neither may drag the other into its answer.
    const both = forest({ main: undefined, kid: 'main', a: 'b', b: 'a' });
    expect([...subtreeOf(both, 'main')].sort()).toEqual(['kid', 'main']);
    expect([...subtreeOf(both, 'a')].sort()).toEqual(['a', 'b']);
  });
});

// ------------------------------------------------------------- the hover card lines

describe('what the hover card says an agent is doing', () => {
  it('names the states in the order they outrank each other', () => {
    expect(actLine(undefined)).toBe('off the floor');
    expect(actLine(actor('a', 0, { done: true }))).toBe('finished');
    expect(actLine(actor('a', 0, { done: true, doneOk: true }))).toBe('finished');
    expect(actLine(actor('a', 0, { done: true, doneOk: false }))).toBe('finished — failed');
    expect(actLine(actor('a', 0, { waiting: 1, busy: 1 }))).toBe('waiting on 1 agent');
    expect(actLine(actor('a', 0, { waiting: 3, busy: 3 }))).toBe('waiting on 3 agents');
    expect(actLine(actor('a', 0, { tool: 'Grep', target: 'engine.ts' }))).toBe('Grep engine.ts');
    expect(actLine(actor('a', 0, { tool: 'Read' }))).toBe('Read');
    expect(actLine(actor('a', 0, { busy: 2 }))).toBe('working');
    expect(actLine(actor('a', 0, { status: '4.1k tok' }))).toBe('4.1k tok');
    expect(actLine(actor('a', 0, { status: '' }))).toBe('idle');
  });

  it('lets the stronger state win when several are true at once', () => {
    // An agent can easily be done, have an unresolved tool call and a status line all at once —
    // the card has one line, and "finished" is the answer to the question being asked.
    const busy = { tool: 'Bash', target: 'npm test', busy: 1, waiting: 2, status: '9k tok' };
    expect(actLine(actor('a', 0, { ...busy, done: true }))).toBe('finished');
    expect(actLine(actor('a', 0, busy))).toBe('waiting on 2 agents');
    expect(actLine(actor('a', 0, { ...busy, waiting: 0 }))).toBe('Bash npm test');
    expect(actLine(actor('a', 0, { ...busy, waiting: 0, tool: undefined }))).toBe('working');
  });

  it('cuts a line that will not fit the card rather than letting it push the card wide', () => {
    const line = actLine(
      actor('a', 0, { tool: 'Read', target: 'src/office/pixel/environment.ts, all of it, twice' }),
    );
    expect(line.length).toBeLessThanOrEqual(42);
    expect(line.startsWith('Read src/office')).toBe(true);
    expect(line.endsWith('…')).toBe(true);

    const status = actLine(actor('a', 0, { status: 'x'.repeat(80) }));
    expect(status.length).toBeLessThanOrEqual(42);
    expect(status.endsWith('…')).toBe(true);
  });
});

describe('what the hover card says an agent has done', () => {
  it('says nothing at all when there is nothing worth a second line', () => {
    expect(noteLine(undefined)).toBe('');
    expect(noteLine(actor('a', 0))).toBe('');
    expect(noteLine(actor('a', 0, { edits: 0, fails: 0 }))).toBe('');
  });

  it('counts edits and failures, and agrees with itself about plurals', () => {
    expect(noteLine(actor('a', 0, { edits: 1 }))).toBe('1 edit');
    expect(noteLine(actor('a', 0, { edits: 4 }))).toBe('4 edits');
    expect(noteLine(actor('a', 0, { fails: 1 }))).toBe('1 failing in a row');
    expect(noteLine(actor('a', 0, { fails: 3 }))).toBe('3 failing in a row');
  });

  it('names the file when it knows it, and joins the two halves with one separator', () => {
    expect(noteLine(actor('a', 0, { edits: 2, edit: 'src/office/pixel/props.ts' }))).toBe(
      '2 edits · src/office/pixel/props.ts',
    );
    expect(noteLine(actor('a', 0, { edits: 2, fails: 3 }))).toBe('2 edits · 3 failing in a row');
    expect(noteLine(actor('a', 0, { edits: 2, edit: 'a.ts', fails: 1 }))).toBe(
      '2 edits · a.ts · 1 failing in a row',
    );
  });

  it('cuts a long path to the tail of the card rather than to the tail of the file', () => {
    const note = noteLine(actor('a', 0, { edits: 1, edit: 'a/very/long/path/to/some/file.ts' }));
    expect(note.startsWith('1 edit · a/very/long/')).toBe(true);
    expect(note.endsWith('…')).toBe(true);
    // 26 characters of path, plus the `1 edit · ` that precedes it.
    expect(note.length).toBeLessThanOrEqual('1 edit · '.length + 26);
  });
});
