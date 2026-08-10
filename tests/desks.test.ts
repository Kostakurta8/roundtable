/**
 * How much of the floor plan a session is allowed to draw.
 *
 * The room seats twelve and used to draw all twelve whatever was happening, so a one-agent run
 * rendered one person among eleven vacant workstations — an office after a layoff rather than a
 * small job. Desks are now drawn up to the high-water mark of the session, which is a rule with
 * exactly two things to prove: that it never draws a desk nobody has ever needed, and that it never
 * *takes one away*, because a room that dismantles itself as agents finish is the worse bug of the
 * two and is the one the previous behaviour was protecting against.
 */
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { ActorState } from '../src/office/engine';
import { MANAGER_DESK_INDEX, podSeat, WAYPOINTS } from '../src/office/engine';
import { desksFor, Scene, type SceneAgent } from '../src/office/pixel/scene';
import { agentLook } from '../src/store';
import { asCtx, SoftCtx } from '../scripts/pixpreview';

const IDLE = {
  pose: 'sit', flip: false, away: true, status: '', busy: 0, waiting: 0,
  fails: 0, resolved: 0, edits: 0,
} satisfies Partial<ActorState>;

/** `main` at the manager desk plus `n` agents in the first `n` pod chairs. */
function cast(n: number): ActorState[] {
  const specs: (Partial<ActorState> & Pick<ActorState, 'id' | 'deskIndex'>)[] = [
    { id: 'main', deskIndex: MANAGER_DESK_INDEX, busy: 2 },
  ];
  for (let i = 0; i < n; i++) specs.push({ id: `a${i}`, deskIndex: i, busy: 1 });
  return specs.map((c) => {
    const p = c.deskIndex === MANAGER_DESK_INDEX ? WAYPOINTS.managerSeat : podSeat(c.deskIndex);
    return { ...IDLE, ...c, x: p.x, y: p.y } as ActorState;
  });
}

/**
 * Paints one scene through the casts given, in order, and hashes the last frame.
 *
 * The casts are a history, not a choice of picture: the whole property under test is that what the
 * room draws depends on what it has *seen*, so the only way to observe it is to show it one cast
 * and then another and look at what is left.
 */
function paintThrough(...casts: ActorState[][]): string {
  return regionHash(bufferThrough(...casts), 0, 0, 480, 270);
}

/**
 * The right-hand bank's top desk, in buffer pixels.
 *
 * Seat 1 is the first chair on that side of the room — 78.75% of the scene's width — so this
 * rectangle holds a desk exactly when the room has ever seated two agents and is bare floor
 * otherwise. That is what makes it the region worth hashing: comparing whole buffers would pass
 * even if desks *were* recomputed from the live cast every frame, because a departed agent leaves
 * its paper stack behind and the two pictures would differ over that alone.
 */
const RIGHT_BANK = { x: 360, y: 78, w: 120, h: 46 } as const;

function regionHash(px: Uint8ClampedArray, x0: number, y0: number, w: number, h: number): string {
  const out = createHash('sha256');
  for (let y = y0; y < y0 + h; y++) {
    out.update(Buffer.from(px.buffer, (y * 480 + x0) * 4, w * 4));
  }
  return out.digest('hex').slice(0, 16);
}

function bufferThrough(...casts: ActorState[][]): Uint8ClampedArray {
  const ctx = new SoftCtx(480, 270);
  const scene = new Scene();
  for (const actors of casts) {
    const agents: Record<string, SceneAgent> = {};
    for (const a of actors) {
      agents[a.id] = { label: a.id, look: agentLook(a.id), status: '', tokens: 0 };
    }
    for (let i = 0; i < 8; i++) {
      scene.draw(asCtx(ctx), {
        actors, agents, task: 't', turns: 1, selected: null, ghosts: [], night: 0, dt: 16,
      });
    }
  }
  return ctx.data;
}

describe('how many desks the room draws', () => {
  it('draws the manager desk and nothing else before anyone has been seated', () => {
    expect(desksFor(0)).toEqual([MANAGER_DESK_INDEX]);
  });

  it('grows one desk at a time and never skips one', () => {
    for (let n = 0; n <= 12; n++) {
      const desks = desksFor(n);
      expect(desks[0], 'the orchestrator always has somewhere to sit').toBe(MANAGER_DESK_INDEX);
      expect(desks).toHaveLength(n + 1);
      expect(desks.slice(1)).toEqual([...Array(n).keys()]);
    }
  });

  it('is the whole floor plan once the room is full, and never more than it', () => {
    // The fixed point that makes this rule safe to add at all: at twelve it is the room that was
    // already being drawn, so a busy office cannot be made worse by it. Past twelve there is no
    // thirteenth desk to invent — the surplus is the off-site strip, not more furniture.
    const full = desksFor(12);
    expect(full).toHaveLength(13);
    expect(desksFor(40)).toEqual(full);
  });

  it('keeps a desk after its agent has gone home', () => {
    // Four agents arrive and three leave. If the room recomputed its furniture from the live cast
    // it would take their desks with them, and the survivor would be sitting in a room being
    // dismantled around them.
    // Both sides are painted through two casts so that the same number of frames, and therefore
    // the same animation phase, reaches the hash: the room is deliberately time-dependent, and a
    // comparison between a long history and a short one would differ for reasons that have nothing
    // to do with furniture.
    const r = (px: Uint8ClampedArray): string =>
      regionHash(px, RIGHT_BANK.x, RIGHT_BANK.y, RIGHT_BANK.w, RIGHT_BANK.h);
    const shrunk = r(bufferThrough(cast(4), cast(1)));
    const onlyEverOne = r(bufferThrough(cast(1), cast(1)));
    expect(shrunk).not.toBe(onlyEverOne);
  });

  it('has a right-hand bank at all only once a second agent has needed one', () => {
    // The other half of the pair above: the region really is empty floor at a high-water of one,
    // so the inequality there is the desk being kept rather than two arbitrary pictures differing.
    const r = (px: Uint8ClampedArray): string =>
      regionHash(px, RIGHT_BANK.x, RIGHT_BANK.y, RIGHT_BANK.w, RIGHT_BANK.h);
    expect(r(bufferThrough(cast(1), cast(1)))).not.toBe(r(bufferThrough(cast(2), cast(2))));
  });
});
