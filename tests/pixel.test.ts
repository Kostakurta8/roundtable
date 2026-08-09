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
import { actLine, noteLine, subtreeOf } from '../src/office/PixelOffice';
import { clockTurn, WALL_FIXTURES } from '../src/office/pixel/scene';
import {
  blitOf,
  CAM_HOME,
  clampCam,
  headroomOf,
  toBuffer,
  ZOOM_MAX,
  ZOOM_MIN,
  type Blit,
  type Cam,
  type Geo,
} from '../src/office/pixel/stage';
import type { RtAgent } from '../src/store';
import { drawArt, drawText, PAL, PIX, pool, textWidth, type Art, type Look } from '../src/office/pixel/art';
import { nightGrade } from '../src/office/pixel/effects';
import * as JU from '../src/office/pixel/juice';
import * as ENV from '../src/office/pixel/environment';
import { BOARD_TALLY_W, BOARD_TEXT, wrapBoard } from '../src/office/pixel/environment';
import {
  CEILING_H,
  FIXTURE_NAMES,
  fixtureBox,
  LAMP_COLUMNS,
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

describe('the wall the whiteboard hangs on', () => {
  // The board is drawn *before* the wall art and the clock, so anything that overlaps it wins and
  // the board loses the columns silently — which is exactly what happened: a picture at x 240 spanned
  // 229..250 and sat on the last eight columns of the board's surface, the end the tally is written
  // at. Nobody saw it, because a board that is two-thirds full still looks like a board.
  //
  // So this asks the only question that matters and asks it in pixels: does any column carry ink
  // from two of these three fixtures. The board is now as wide as its wall allows, and the next
  // person to widen it will be told by this test rather than by the render.
  const columnsOf = (draw: (c: CanvasRenderingContext2D) => void): Set<number> => {
    const ctx = new SoftCtx(320, 64);
    draw(asCtx(ctx));
    return new Set(inkColumns(ctx));
  };

  it('fits between the window and the clock without touching either', () => {
    const window = columnsOf((c) => ENV.drawWindow(c, 149, 44, 0, 0));
    const board = columnsOf((c) => ENV.drawWhiteboard(c, 206, 44, ['ONE', 'TWO', 'THREE']));
    const clock = columnsOf((c) => ENV.drawClock(c, 253, 40, 0.21));

    const clash = (a: Set<number>, b: Set<number>): number[] => [...a].filter((x) => b.has(x));
    expect(clash(board, window), 'the board paints over the window').toEqual([]);
    expect(clash(board, clock), 'the board paints over the clock').toEqual([]);
  });

  // A guard on the *reason* the board is 76 wide. If someone moves a picture back over it, the
  // overlap test above cannot see it — the art is not in that comparison — so this one names it.
  it('has no wall art hanging over it', () => {
    const board = columnsOf((c) => ENV.drawWhiteboard(c, 206, 44, ['ONE']));
    for (const art of WALL_FIXTURES.art) {
      const cols = columnsOf((c) => ENV.drawWallArt(c, art.x, 44, art.variant));
      const over = [...cols].filter((x) => board.has(x));
      expect(over, `wall art at x ${art.x} overlaps the whiteboard`).toEqual([]);
    }
  });
});

describe('the three moments', () => {
  /** The whole buffer as a string — the cheapest way to ask "is this frame the same frame". */
  const frame = (draw: (c: CanvasRenderingContext2D) => void, w = 120, h = 64): string => {
    const ctx = new SoftCtx(w, h);
    draw(asCtx(ctx));
    return [...ctx.data].join(',');
  };
  const EMPTY = frame(() => {});

  const pulse = (age: number, still = false): string =>
    frame((c) => JU.linkPulse(c, 8, 48, 112, 16, age, PAL.acc, still));

  // A poisoned age is the failure mode this module is most exposed to: a delta over a duration
  // somebody set to zero is all it takes, every comparison against NaN is false, and the result is
  // not a throw but the *first* branch of a beat painted for ever. These four must draw nothing.
  it('paints nothing for an age that is not a live age', () => {
    for (const bad of [NaN, Infinity, -Infinity, -0.5, 1, 4]) {
      expect(pulse(bad), `age ${bad} painted something`).toBe(EMPTY);
      expect(frame((c) => JU.verdictPop(c, 60, 40, { age: bad, ok: true, seed: 7 }))).toBe(EMPTY);
      expect(
        frame((c) => JU.finishBurst(c, 60, 40, { age: bad, ok: true, tint: PAL.acc, papers: 2, seed: 7 })),
      ).toBe(EMPTY);
    }
  });

  // The point of the pulse is that the brief *travels*. Four ages that all painted the same pixels
  // would be a packet sitting still, which is exactly what the still-frame version is for — and a
  // baseline hash could not tell the two apart.
  // The beat has a lead-in and an exit, and both are deliberate: the wire draws *itself* in before
  // anything travels down it, and the packet is gone before the line is. Sampling outside that
  // window is how the first version of the test below failed — it asked whether a packet that had
  // not launched yet looked different from one that had.
  it('leaves the wire to draw itself in, and clears out before the end', () => {
    for (const early of [0.02, 0.05, 0.15]) expect(pulse(early)).toBe(EMPTY);
    expect(pulse(0.95)).toBe(EMPTY);
  });

  it('moves the packet down the wire', () => {
    const ages = [0.25, 0.45, 0.6, 0.7];
    const seen = ages.map((a) => pulse(a));
    for (const f of seen) expect(f).not.toBe(EMPTY);
    for (let i = 0; i < seen.length; i++) {
      for (let j = i + 1; j < seen.length; j++) {
        expect(seen[i], `ages ${ages[i]} and ${ages[j]} drew the same frame`).not.toBe(seen[j]);
      }
    }
  });

  // Reduced motion is not "draw nothing". The packet still says a brief went to that child; it just
  // does not move between one frame and the next, which is the thing the setting actually asks for.
  it('parks the packet under reduced motion instead of hiding it', () => {
    const parked = pulse(0.3, true);
    expect(parked).not.toBe(EMPTY);
    for (const age of [0.45, 0.6, 0.7]) {
      expect(pulse(age, true), 'a still packet moved').toBe(parked);
    }
  });

  // Both beats carry an outcome, and both are drawn in the agent's own colour on top of it. If ok
  // and err ever collapsed to the same pixels the room would be announcing that something landed
  // while refusing to say how — which is worse than not announcing it.
  it('says how it landed, not just that it landed', () => {
    const seal = (ok: boolean): string =>
      frame((c) => JU.verdictPop(c, 60, 40, { age: 0.5, ok, seed: 7 }));
    const burst = (ok: boolean): string =>
      frame((c) => JU.finishBurst(c, 60, 48, { age: 0.35, ok, tint: PAL.acc, papers: 2, seed: 7 }));
    expect(seal(true)).not.toBe(EMPTY);
    expect(burst(true)).not.toBe(EMPTY);
    expect(seal(true)).not.toBe(seal(false));
    expect(burst(true)).not.toBe(burst(false));
  });

  // No `Math.random` anywhere in the module: the same moment rebuilt from the timeline has to
  // explode the same way, or the scrubber is showing you a different past every time you drag it.
  it('is deterministic, so a replayed moment is the moment', () => {
    for (const age of [0.2, 0.55, 0.9]) {
      expect(pulse(age)).toBe(pulse(age));
      const shot = (): string =>
        frame((c) => JU.finishBurst(c, 60, 48, { age, ok: true, tint: PAL.acc, papers: 2, seed: 7 }));
      expect(shot()).toBe(shot());
    }
  });
});

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

// ---------------------------------------------------------------------- the ceiling

/**
 * The strip that fills the stage above the room.
 *
 * Its predecessor was two rectangles of `PAL.out` and `PAL.shd` — the near-blacks the art draws
 * outlines with — which is why the running app had a black band across the top of the office. None
 * of what is asserted here can be caught by the room's baseline hash: the strip is not in the room
 * buffer, so every sheet in `.preview/` was blind to it right up until it had its own shot.
 */
describe('the ceiling strip', () => {
  /** The strip and the room, painted the same way `Scene` paints them, at a given light level. */
  const both = (night: number): { ceil: SoftCtx; room: SoftCtx } => {
    const ceil = new SoftCtx(PIX.w, CEILING_H);
    const roomCtx = new SoftCtx(PIX.w, PIX.h);
    const scene = new Scene();
    // Wound far enough forward that the eased night level has actually arrived: the strip is drawn
    // from the *scene's* night, and comparing a settled room against an unsettled strip would be
    // comparing two different times of day.
    for (let i = 0; i < 200; i++) scene.draw(asCtx(roomCtx), input([actor('main', MANAGER_DESK_INDEX)], { night }));
    scene.paintCeiling(asCtx(ceil));
    return { ceil, room: roomCtx };
  };

  const luma = (c: SoftCtx, x: number, y: number): number => {
    const i = (y * c.width + x) * 4;
    return 0.299 * c.data[i] + 0.587 * c.data[i + 1] + 0.114 * c.data[i + 2];
  };

  const rowMean = (c: SoftCtx, y: number): number => {
    let sum = 0;
    for (let x = 0; x < c.width; x++) sum += luma(c, x, y);
    return sum / c.width;
  };

  for (const [name, night] of [['by day', 0], ['at night', 1]] as const) {
    it(`meets the room's first row with no visible seam ${name}`, () => {
      // The join is one row wide and runs the width of the stage, so if the two sides disagree it
      // disagrees as a line across the picture — the most visible defect a strip like this can
      // have, and the reason the strip carries the room's own night wash and vignette weight.
      const { ceil, room: r } = both(night);
      // The room's first row is mostly wall, with hardware bolted to it — five lamp canopies and
      // the vent. Those are objects hanging in front of the ceiling rather than disagreements about
      // what the ceiling is, so the comparison is made against the columns that are still wall:
      // everything close to the row's own median. Naming the fixtures instead would have to be
      // rewritten every time somebody hangs something else up there, and would quietly stop
      // covering the columns it forgot.
      const row0 = Array.from({ length: PIX.w }, (_, x) => luma(r, x, 0));
      const median = [...row0].sort((a, b) => a - b)[PIX.w >> 1];
      // Grown by two columns either side, because a fixture's own outline is the fixture: the
      // vent's dark edge is within a couple of levels of the wall it is screwed to, and a filter
      // that only asks about the middle of an object lets its border through as a false seam.
      const off = Array.from({ length: PIX.w }, (_, x) => Math.abs(row0[x] - median) > 5);
      const wall = off.map((_, x) => !off.slice(Math.max(0, x - 2), x + 3).some(Boolean));
      let worst = 0;
      let worstX = -1;
      let compared = 0;
      for (let x = 0; x < PIX.w; x++) {
        if (!wall[x]) continue;
        compared += 1;
        const d = Math.abs(luma(ceil, x, CEILING_H - 1) - row0[x]);
        if (d > worst) {
          worst = d;
          worstX = x;
        }
      }
      // ...and most of the row still has to be wall, or the filter above has quietly excused the
      // strip from the comparison entirely.
      expect(compared, 'too little of the room’s first row is wall to compare against')
        .toBeGreaterThan(PIX.w * 0.8);
      // Six levels out of 255, at luminances around 30 — under what an eye resolves across a hard
      // edge, and two orders below the failure it guards: the strip this replaces was black, which
      // met the wall fifty levels down. What is left is the vignette's corner squares weighting the
      // room's outermost columns, and the vent's grille, which is dark enough to pass for wall.
      expect(worst, `seam of ${worst.toFixed(1)} levels at x ${worstX}`).toBeLessThan(6);
    });
  }

  it('is never as dark as the outline colours it used to be painted with', () => {
    // The regression, stated as the thing a viewer complained about: the top of the stage was
    // black. `PAL.out` is the darkest thing the room draws with, and the ceiling is a surface in
    // the room rather than an edge around one — so no pixel of it may be that dark.
    const { ceil } = both(0);
    const floor = 0.299 * 0x14 + 0.587 * 0x18 + 0.114 * 0x21; // PAL.out, #141821
    let worst = Infinity;
    for (let y = 0; y < CEILING_H; y++) {
      for (let x = 0; x < PIX.w; x++) worst = Math.min(worst, luma(ceil, x, y));
    }
    expect(worst, `darkest ceiling pixel is ${worst.toFixed(1)}, outline is ${floor.toFixed(1)}`)
      .toBeGreaterThan(floor);
  });

  it('darkens as it comes toward the viewer, and never the other way', () => {
    // The specific shape of the old bug: `shd` over the top quarter and `out` over the top half put
    // the darkest band in the *middle* of the strip, so the ceiling got darker halfway up and
    // lighter again above that. Nothing in a room does that. Thirds rather than rows, because the
    // joists are deliberately lighter than the field they cross.
    const { ceil } = both(0);
    const third = Math.floor(CEILING_H / 3);
    // The **median** row of each third, not the mean of it. The joists are deliberately lighter
    // than the plane they cross and they are deliberately not evenly spaced — that unevenness is
    // the perspective — so a mean measures how many beams landed in the slice as much as it
    // measures the tone. A median lands on the field between them wherever they fall.
    const band = (y0: number, y1: number): number => {
      const rows = [];
      for (let y = y0; y < y1; y++) rows.push(rowMean(ceil, y));
      return rows.sort((a, b) => a - b)[rows.length >> 1];
    };
    const near = band(0, third);
    const mid = band(third, third * 2);
    const far = band(third * 2, CEILING_H);
    expect(far, 'the ceiling is darker at the wall than in the middle').toBeGreaterThan(mid);
    expect(mid, 'the ceiling is darker in the middle than at the near edge').toBeGreaterThan(near);
  });

  it('is a surface rather than a flat slab', () => {
    // The same check the room's own bands get: a fill with nothing drawn on it is indistinguishable
    // from a fill that was drawn and then painted over, except in the count of colours in it.
    const { ceil } = both(0);
    const seen = new Set<string>();
    for (let y = 0; y < CEILING_H; y++) {
      for (let x = 0; x < PIX.w; x++) {
        const i = (y * PIX.w + x) * 4;
        seen.add(`${ceil.data[i]},${ceil.data[i + 1]},${ceil.data[i + 2]}`);
      }
    }
    expect(seen.size, 'the ceiling is a flat fill — nothing is being drawn on it').toBeGreaterThan(6);
  });

  it('lights up under the lamps at night, and barely at all by day', () => {
    // The one thing that makes the strip read as the room's own ceiling rather than as a lid on it:
    // the pendants throw light up onto it. A lamp glowing at noon reads as a bug, so the day
    // version has to be nearly nothing.
    const warmth = (c: SoftCtx, x: number, y: number): number => {
      const i = (y * c.width + x) * 4;
      return c.data[i] - c.data[i + 2];
    };
    const day = both(0).ceil;
    const night = both(1).ceil;
    // The warmest the strip gets in a column, so the assertion does not have to know how high above
    // the join the bloom is centred — which is a number that was tuned by looking at the render.
    const column = (c: SoftCtx, x: number): number => {
      let best = -Infinity;
      for (let y = 0; y < CEILING_H; y++) best = Math.max(best, warmth(c, x, y));
      return best;
    };
    // A lamp column against the midpoint between two of them.
    const under = LAMP_COLUMNS[1];
    const between = Math.round((LAMP_COLUMNS[1] + LAMP_COLUMNS[2]) / 2);
    const lift = (c: SoftCtx): number => column(c, under) - column(c, between);
    expect(lift(night), 'the lamps do not light the ceiling at night').toBeGreaterThan(40);
    expect(lift(day) * 4, 'the lamps glow at noon').toBeLessThan(lift(night));
  });
});

// ---------------------------------------------------------------------- the whiteboard

/**
 * What the board can say about the session it is standing in.
 *
 * The board is 54 x 18 pixels of writing area and a session's prompt is two hundred characters, so
 * everything here is about the difference between a *fragment* and a *truncation*: the board showed
 * "TASK: I WANT YOU TO" and stopped, which is a sentence somebody cut in half.
 */
describe('the board’s wrap', () => {
  const TASK =
    'work out which of the tailer passes is dropping the last megabyte and prove the fix with a test';

  it('breaks on words, never inside one', () => {
    const { lines } = wrapBoard(TASK, BOARD_TEXT.lines, 0);
    // Every line has to be a run of whole words from the task, in order — which is exactly what
    // "reads as English" means at this size, and what the old two-line-then-elide did not do.
    expect(lines.join(' ')).toBe(TASK.split(' ').slice(0, lines.join(' ').split(' ').length).join(' '));
    for (const line of lines) expect(line.trim()).toBe(line);
  });

  it('uses every line the board has', () => {
    const { lines } = wrapBoard(TASK, BOARD_TEXT.lines, 0);
    expect(lines).toHaveLength(BOARD_TEXT.lines);
  });

  it('fills each line to the board’s own width, not to a guess at it', () => {
    // The wrap ran to 44 against a board that draws and elides at 50. This is the assertion that
    // the two are one number: every line fits, and every line is full enough that the next word
    // genuinely did not.
    const words = TASK.split(' ');
    const { lines } = wrapBoard(TASK, BOARD_TEXT.lines, 0);
    let taken = 0;
    for (const line of lines) {
      expect(textWidth(line), `"${line}" overruns the board`).toBeLessThanOrEqual(BOARD_TEXT.w);
      taken += line.split(' ').length;
      const nextWord = words[taken];
      if (nextWord === undefined) break;
      expect(textWidth(`${line} ${nextWord}`), `"${line}" had room for "${nextWord}"`)
        .toBeGreaterThan(BOARD_TEXT.w);
    }
  });

  it('leaves the tally its reserve on the last line and nowhere else', () => {
    const { lines } = wrapBoard(TASK, BOARD_TEXT.lines, BOARD_TALLY_W);
    const last = lines[lines.length - 1];
    expect(textWidth(last), 'the last line runs under the tally').toBeLessThanOrEqual(
      BOARD_TEXT.w - BOARD_TALLY_W,
    );
    // ...and the earlier lines are still wrapped at the *full* width — the word that ended each of
    // them did not fit in fifty, not merely in thirty. Reserving on every line would cost three
    // lines' worth of characters to buy one line's worth of marks.
    const words = TASK.split(' ');
    let taken = 0;
    for (const line of lines.slice(0, -1)) {
      taken += line.split(' ').length;
      expect(textWidth(`${line} ${words[taken]}`), `"${line}" was cut short of the board's width`)
        .toBeGreaterThan(BOARD_TEXT.w);
    }
  });

  it('breaks a word that is longer than a line rather than losing the rest of the task', () => {
    // The literal "stops mid-word": a single token wider than the board went on to a line of its
    // own and was then elided by `fitLine`, so everything after it vanished with no sign.
    const long = 'src/office/pixel/environment.ts needs a ceiling';
    const { lines } = wrapBoard(long, BOARD_TEXT.lines, 0);
    expect(lines.length).toBeGreaterThan(1);
    expect(lines.join('')).toContain('SRC/OFFICE/PIXEL'.toLowerCase());
    // Nothing is dropped between one line and the next: the pieces of the broken word abut.
    expect(lines[0] + lines[1]).toBe(long.slice(0, lines[0].length + lines[1].length));
  });

  it('says when there is more, and does not when there is not', () => {
    expect(wrapBoard(TASK, BOARD_TEXT.lines, BOARD_TALLY_W).more).toBe(true);
    expect(wrapBoard('ship it', BOARD_TEXT.lines, BOARD_TALLY_W).more).toBe(false);
    expect(wrapBoard('', BOARD_TEXT.lines, 0)).toEqual({ lines: [], more: false });
  });

  it('carries more of the task than the two-line wrap it replaces', () => {
    // The whole point, as a number. The old rule was: wrap at 44, keep two lines.
    const old: string[] = [];
    let line = '';
    for (const w of TASK.split(' ')) {
      const next = line ? `${line} ${w}` : w;
      if (textWidth(next) > 44 && line) {
        old.push(line);
        line = w;
      } else line = next;
      if (old.length === 2) break;
    }
    const before = old.join(' ').length;
    const after = wrapBoard(TASK, BOARD_TEXT.lines, BOARD_TALLY_W).lines.join(' ').length;
    expect(after, `${after} characters vs ${before}`).toBeGreaterThan(before * 1.3);
  });
});

describe('the board’s hit target', () => {
  /**
   * `BOARD_BOX` and `TABLE_BOX` in `PixelOffice.tsx` are `fixtureBox` calls, and `fixtureBox` is
   * held against the paint by "its box covers the pixels it paints" above. That test would still
   * pass if the board's *writing area* moved off the board — every pixel would still be inside the
   * box, because the box would have grown with the ink. What it would not catch is the failure that
   * actually happened: the box hanging fourteen rows low, over the skirting, with the task on the
   * board not clickable at all. So this one asks specifically about the text.
   */
  const boardInk = (state: ENV.BoardState): { x0: number; y0: number; x1: number; y1: number } => {
    const withText = new SoftCtx(PIX.w, PIX.h);
    const without = new SoftCtx(PIX.w, PIX.h);
    ENV.drawWhiteboard(asCtx(withText), 205, 35, state);
    ENV.drawWhiteboard(asCtx(without), 205, 35, { ...state, lines: [] });
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (let y = 0; y < PIX.h; y++) {
      for (let x = 0; x < PIX.w; x++) {
        const i = (y * PIX.w + x) * 4;
        const same =
          withText.data[i] === without.data[i] &&
          withText.data[i + 1] === without.data[i + 1] &&
          withText.data[i + 2] === without.data[i + 2];
        if (same) continue;
        x0 = Math.min(x0, x);
        y0 = Math.min(y0, y);
        x1 = Math.max(x1, x);
        y1 = Math.max(y1, y);
      }
    }
    return { x0, y0, x1, y1 };
  };

  it('covers the task written on the board, every line of it', () => {
    const { lines, more } = wrapBoard(
      'work out which of the tailer passes is dropping the last megabyte',
      BOARD_TEXT.lines,
      BOARD_TALLY_W,
    );
    expect(lines).toHaveLength(BOARD_TEXT.lines);
    const ink = boardInk({ lines, more, done: 4, live: 3, spend: 0.5 });
    const box = fixtureBox('whiteboard');
    expect(ink.x0).toBeGreaterThanOrEqual(box.x);
    expect(ink.y0).toBeGreaterThanOrEqual(box.y);
    expect(ink.x1).toBeLessThanOrEqual(box.x + box.w - 1);
    expect(ink.y1).toBeLessThanOrEqual(box.y + box.h - 1);
    // And it is the box's own upper half that carries the writing — the bug it replaces put the
    // box below the board, which containment alone would not have noticed if the box were big.
    expect(ink.y0).toBeLessThan(box.y + box.h / 2);
  });

  it('keeps the roundtable’s box on the table rather than on the rug in front of it', () => {
    // The other half of the same historical bug, in the other direction: the table's box sat seven
    // rows high, over the rug, missing the pedestal. `yBase` is the bottom row an object occupies,
    // so the box's last row is the anchor row and not its middle.
    const box = fixtureBox('roundtable');
    const ctx = new SoftCtx(PIX.w, PIX.h);
    paintFixture(asCtx(ctx), 'roundtable', input([actor('main', MANAGER_DESK_INDEX)]));
    let lowest = -1;
    for (let y = 0; y < PIX.h; y++) {
      for (let x = 0; x < PIX.w; x++) if (ctx.data[(y * PIX.w + x) * 4 + 3] === 255) lowest = y;
    }
    expect(lowest, 'the table paints below its own box').toBeLessThanOrEqual(box.y + box.h - 1);
    expect(box.y + box.h - 1 - lowest, 'the box hangs below the table').toBeLessThanOrEqual(2);
  });
});

// ------------------------------------------------------------------ where the light is

/**
 * The night grade's warm spots, against the floor plan they are supposed to be lit by.
 *
 * `effects.ts` used to hold a hand-written table of lamp positions copied from a floor plan that
 * was later rebuilt. It warmed x 79 and x 146 — which became the break corner and the bare floor
 * between the left bank's two columns — and had no entry at all over the right-hand bank, so every
 * night frame lit three patches of empty boards and left half the room's desks dark. It is now
 * derived from the engine's own seating, and this is the assertion that says so: nothing here is a
 * coordinate the renderer also holds, so a floor plan that moves takes its lamps with it or fails.
 *
 * Warmth, not brightness. The grade darkens the whole canvas and then lifts the lamps back out of
 * it in `PAL.lmp`, so what marks a lamp is the *warm-cool* balance — red over blue — and not how
 * bright the pixel ended up.
 */
describe('the night grade', () => {
  /** The warmest this column gets anywhere down the room, over a neutral field. */
  const columnWarmth = (ctx: SoftCtx, x: number): number => {
    let best = -Infinity;
    for (let y = 0; y < PIX.h; y++) {
      const i = (y * PIX.w + x) * 4;
      best = Math.max(best, ctx.data[i] - ctx.data[i + 2]);
    }
    return best;
  };

  /** A flat mid-grey room with nothing in it, so the only structure left is the grade's own. */
  const graded = (): SoftCtx => {
    const ctx = new SoftCtx(PIX.w, PIX.h);
    ctx.fillStyle = '#808080';
    ctx.fillRect(0, 0, PIX.w, PIX.h);
    nightGrade(asCtx(ctx), 1);
    return ctx;
  };

  /** Every chair the floor plan seats somebody at, as a buffer column. */
  const seatColumns = [
    ...WAYPOINTS.podSeats.map((s) => Math.round(s.x * S)),
    Math.round(WAYPOINTS.managerSeat.x * S),
  ];

  it('warms every desk the floor plan draws, both banks of it', () => {
    const ctx = graded();
    // Distinct columns, so a failure names the bank rather than the seat index.
    for (const x of [...new Set(seatColumns)]) {
      expect(columnWarmth(ctx, x), `no lamp over the desk column at x ${x}`).toBeGreaterThan(0);
    }
  });

  it('no longer warms the two columns of the floor plan it replaced', () => {
    // The exact failure: 79 is the break corner now, 146 the gap between the left bank's columns.
    // Neither is a desk, and neither may be the warmest thing in its own column.
    const ctx = graded();
    const dimmest = Math.min(...seatColumns.map((x) => columnWarmth(ctx, x)));
    for (const stale of [79, 146]) {
      expect(columnWarmth(ctx, stale), `x ${stale} is still lit like a desk`).toBeLessThan(dimmest);
    }
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

  /**
   * The strip above the room, which bottom-alignment guarantees will usually exist.
   *
   * It was painted black, and a black strip over a room is not a taller room — it is a viewport
   * somebody broke. `headroomOf` says what fills it, and it is held to three things: it never asks
   * the room buffer for a row the room does not have, it hands back a stack of pieces that meet
   * exactly with no seam between them, and every piece lands on the *same* buffer-to-screen map the
   * DOM layer places its marks with. That last one is what lets an actor who is above the view at a
   * high zoom appear in the strip with their nameplate over their head, rather than in it.
   */
  describe('the headroom above the room', () => {
    /** The ceiling strip's own height, in buffer rows — the cap on what can be invented. */
    const CAP = 72;

    it('fills the strip from the room itself wherever the room has rows above the view', () => {
      each((b, _g, _c, where) => {
        const hr = headroomOf(b, CAP);
        expect(hr.roomRows, `sampled above the buffer — ${where}`).toBeLessThanOrEqual(b.srcY);
        expect(hr.roomRows, `negative room rows — ${where}`).toBeGreaterThanOrEqual(0);
        expect(hr.ceilRows, `more ceiling than there is — ${where}`).toBeLessThanOrEqual(CAP);
        expect(hr.ceilRows, `negative ceiling rows — ${where}`).toBeGreaterThanOrEqual(0);
        expect(hr.ceilSrcY, `ceiling sampled off its own top — ${where}`).toBe(CAP - hr.ceilRows);
      });
    });

    it('stacks its pieces so they meet the room exactly, with no seam', () => {
      each((b, _g, _c, where) => {
        const hr = headroomOf(b, CAP);
        expect(hr.roomY + hr.roomRows * b.scale, `room strip does not meet the room — ${where}`)
          .toBeCloseTo(b.destY, 9);
        expect(hr.ceilY + hr.ceilRows * b.scale, `ceiling does not meet the room strip — ${where}`)
          .toBeCloseTo(hr.roomY, 9);
      });
    });

    it('reaches the top of the stage unless the ceiling strip runs out of rows', () => {
      each((b, _g, _c, where) => {
        const hr = headroomOf(b, CAP);
        if (hr.ceilRows < CAP) {
          expect(hr.ceilY, `bare stage above the ceiling — ${where}`).toBeLessThanOrEqual(0);
        } else {
          // Deeper than the art: whatever is left is a flat fill of the ceiling's own top tone,
          // which is a room colour. What must never happen is the fill being *skipped*.
          expect(hr.ceilY, `capped, so there is a flat fill to draw — ${where}`).toBeGreaterThan(0);
        }
      });
    });

    it('places the strip on the same map the DOM layer places marks with', () => {
      // `place` writes `dy + (y - srcY) * px`. Buffer row `srcY - roomRows` therefore has exactly
      // one correct home on the stage, and the strip has to use it or an actor drawn in the
      // headroom would stand a few pixels away from their own hit target.
      each((b, _g, _c, where) => {
        const hr = headroomOf(b, CAP);
        const dpr = b.scale / b.px;
        expect(hr.roomY / dpr, `strip is off the placement map — ${where}`)
          .toBeCloseTo(b.dy - hr.roomRows * b.px, 9);
      });
    });

    it('has nothing to fill when the room already reaches the top of the stage', () => {
      // A stage exactly 16:9 with no rail: `destY` is zero and every piece has to be zero with it,
      // or the ceiling would be painted over the room's own first row.
      const b = blitOf(CAM_HOME, { w: 480, h: 270, dpr: 1, insetLeft: 0 });
      expect(b.destY).toBe(0);
      const hr = headroomOf(b, CAP);
      expect(hr).toEqual({ h: 0, roomRows: 0, roomY: 0, ceilRows: 0, ceilY: 0, ceilSrcY: CAP });
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

/**
 * The wall clock.
 *
 * `drawClock` takes `turn` as 0..1 over a full twelve hours, and the room was passing it
 * `(t / 60000) % 1` — the animation clock — so the hands swept twelve hours every sixty seconds.
 * Not frozen, which is what it looks like in a still: spinning, and agreeing with nothing. A clock
 * on the wall of an observer is read as the time, and the one thing it must not do is invent one.
 */
describe('clockTurn', () => {
  const at = (h: number, m = 0): number => new Date(2026, 0, 1, h, m, 0, 0).getTime();

  it('puts noon and midnight at the top of the dial', () => {
    expect(clockTurn(at(12))).toBeCloseTo(0, 6);
    expect(clockTurn(at(0))).toBeCloseTo(0, 6);
  });

  it('reads a twelve-hour dial, so morning and afternoon share a face', () => {
    expect(clockTurn(at(3))).toBeCloseTo(0.25, 6);
    expect(clockTurn(at(15))).toBeCloseTo(0.25, 6);
    expect(clockTurn(at(6))).toBeCloseTo(0.5, 6);
  });

  it('advances with the minutes, not just the hours', () => {
    // 6:30 is 390 of the 720 minutes in a half-day. An hour hand that jumps on the hour is a clock
    // that is wrong for fifty-nine minutes out of sixty.
    expect(clockTurn(at(6, 30))).toBeCloseTo(390 / 720, 6);
  });

  it('is a pure function of the instant, which is what lets a replay agree with it', () => {
    // The room can be wound back to a past second. If the clock were driven by the animation
    // clock — as it was — the rewound room would show the wrong time on the wall while claiming
    // to be a faithful rebuild of that moment.
    expect(clockTurn(at(9, 17))).toBe(clockTurn(at(9, 17)));
  });

  it('stays inside the dial for any instant', () => {
    for (const h of [0, 1, 5, 11, 12, 13, 18, 23]) {
      const turn = clockTurn(at(h, 45));
      expect(turn).toBeGreaterThanOrEqual(0);
      expect(turn).toBeLessThan(1);
    }
  });
});
