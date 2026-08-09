/**
 * The room's review cast, and the one code path that paints it.
 *
 * Shared by `scripts/room.ts`, which writes PNGs for a human to look at, and by
 * `tests/room.test.ts`, which hashes the same pixels and fails when they change without anybody
 * meaning them to. Both have to be the *same* room or the test guards a picture nobody reviews.
 *
 * The cast is a checklist, not a scene: every state the room can be in appears exactly once, so a
 * single sheet answers "does the office still draw all of this". A desk that is working, one that
 * is reading, one that keeps failing, one whose agent has gone home, an empty chair, a walk, a
 * huddle, a coffee break, a spawn edge and a verdict.
 */
import type { ActorState } from '../src/office/engine';
import { MANAGER_DESK_INDEX, podSeat, WAYPOINTS } from '../src/office/engine';
import { PAL } from '../src/office/pixel/art';
import { CEILING_H, Scene, type Ghost, type SceneAgent } from '../src/office/pixel/scene';
import {
  blitOf,
  CAM_HOME,
  clampCam,
  headroomBlits,
  type Cam,
  type Geo,
} from '../src/office/pixel/stage';
import { agentLook } from '../src/store';
import { asCtx, blit, SoftCtx } from './pixpreview';

const seat = (i: number): { x: number; y: number } =>
  i === MANAGER_DESK_INDEX ? WAYPOINTS.managerSeat : podSeat(i);

/**
 * One of the cast. Everything the engine reports has a quiet default, so a line here only says
 * what makes that desk *different* — which is also what makes the sheet readable as a checklist.
 */
type Spec = Partial<Omit<ActorState, 'x' | 'y'>> &
  Pick<ActorState, 'id' | 'deskIndex'> & { at?: { x: number; y: number } };

const CAST: Spec[] = [
  { id: 'main', deskIndex: MANAGER_DESK_INDEX, status: '18.4k tok', waiting: 2, busy: 2, act: 'delegate',
    link: { child: 'explore', label: 'map the office layout' } },
  { id: 'explore', deskIndex: 0, status: 'Grep engine.ts', busy: 1, act: 'read', tool: 'Grep', target: 'engine.ts', parent: 'main' },
  { id: 'finder', deskIndex: 1, status: '4.1k tok', think: 'where does the tail step over a huge line' },
  { id: 'verifya', deskIndex: 2, status: 'Read hub.ts', busy: 1, act: 'read', tool: 'Read', target: 'hub.ts', lastOk: true, resolved: 9 },
  { id: 'verifyb', deskIndex: 3, status: '', lastOk: false, fails: 3, resolved: 12 },
  {
    id: 'critic',
    deskIndex: 4,
    pose: 'stand',
    away: false,
    status: 'reporting',
    say: 'CONFIRMED — the tailer stops on a 4 MB line.',
    verdict: 'ok',
    at: { x: WAYPOINTS.managerStand.x - 60, y: WAYPOINTS.managerStand.y },
  },
  { id: 'walker', deskIndex: 5, pose: 'walk', away: false, status: '', at: { x: 700, y: 500 } },
  { id: 'sixth', deskIndex: 6, status: 'Write props.ts', busy: 1, act: 'write', tool: 'Write', target: 'props.ts', edit: 'src/office/pixel/props.ts', edits: 4 },
  { id: 'seventh', deskIndex: 7, status: '912 tok', done: true, doneOk: true },
  // The three behaviours that had no anchor in the room until this session: a huddle at the
  // roundtable, a coffee break, and a desk left empty while its owner is elsewhere.
  { id: 'huddleN', deskIndex: 8, pose: 'stand', away: false, status: 'at the table', at: WAYPOINTS.tableN },
  { id: 'huddleW', deskIndex: 9, pose: 'stand', away: false, status: 'at the table', at: WAYPOINTS.tableW },
  { id: 'huddleE', deskIndex: 10, pose: 'stand', away: false, status: 'at the table', at: WAYPOINTS.tableE },
  { id: 'brewer', deskIndex: 11, pose: 'stand', away: false, status: '', at: WAYPOINTS.coffee },
  // The break corner used to be cast here too — nine finished agents standing about in it. There
  // are no finished agents in the room any more: finishing means walking out of the door, so the
  // corner is furniture the room has rather than a place anybody stands. Its couch, café table and
  // ash stand are still in the shot, drawn by the scene as part of the floor plan.
];

/** Tokens per agent, for the paper stacks — a spread wide enough to see the curve saturate. */
const TOKENS: Readonly<Record<string, number>> = {
  main: 1_400_000,
  explore: 90_000,
  finder: 12_000,
  verifya: 260_000,
  verifyb: 620_000,
  sixth: 40_000,
  seventh: 180_000,
};

/** The engine's own resting state for an actor nobody has said anything about yet. */
const IDLE = {
  pose: 'sit',
  flip: false,
  away: true,
  status: '',
  busy: 0,
  waiting: 0,
  fails: 0,
  resolved: 0,
  edits: 0,
} satisfies Partial<ActorState>;

export const actors: ActorState[] = CAST.map((c) => {
  const p = c.at ?? seat(c.deskIndex);
  return { ...IDLE, ...c, x: p.x, y: p.y };
});

/**
 * The cast's appearances, from the app's own `agentLook` rather than from a copy of it.
 *
 * These used to be eight literal looks — all thirty-two hex values of `src/store.ts`'s `LOOKS`,
 * transcribed — handed out by *array position*: `LOOKS[1 + i % 7]`, where `i` was the actor's index
 * in this file. Which meant the visual-regression baseline was blind to the one table it most
 * needed to guard. Repaint every person in the office by editing the real palette and not a pixel
 * of this room would move, because this room was not reading it; edit an unrelated line here and
 * shift the cast's order and the whole baseline would move for nothing.
 *
 * `agentLook` hashes the id, so the colours now land exactly where the app puts them and follow the
 * agent rather than its position in the list. `src/store.ts` is a pure fold over `shared/` — no
 * React, no DOM — so importing it costs this script nothing.
 */
export const agents: Record<string, SceneAgent> = {};
for (const a of actors) {
  agents[a.id] = {
    label: a.id === 'main' ? 'orchestrator' : a.id,
    look: agentLook(a.id),
    status: a.status,
    errored: a.id === 'verifyb',
    tokens: TOKENS[a.id] ?? 0,
  };
}

export const ghosts: Ghost[] = Array.from({ length: 23 }, (_, i) => ({
  id: `wf-${i}`,
  label: `agent ${i}`,
  look: agentLook(`wf-${i}`),
  busy: i % 3 === 0,
  done: i % 7 === 0,
}));

/**
 * Paints the review room and hands back the buffer, and the scene that painted it.
 *
 * Wound forward in real-sized steps rather than one jump: every animation phase in the room is an
 * accumulation, and a single enormous delta would land them all somewhere they never are.
 *
 * The scene comes back because the ceiling strip is drawn from it — it holds the *eased* night
 * level, and a strip lit for a different instant than the room it sits on has a seam across it.
 */
function run(night: number, seconds: number): { ctx: SoftCtx; scene: Scene } {
  const ctx = new SoftCtx(480, 270);
  const scene = new Scene();
  const step = 16;
  const frames = Math.max(1, Math.round((seconds * 1000) / step));
  for (let i = 0; i < frames; i++) {
    scene.draw(asCtx(ctx), {
      actors,
      agents,
      task: 'find the flaky test in the tail suite and prove the fix',
      turns: 47,
      selected: null,
      ghosts,
      night,
      spend: 0.62,
      dt: step,
    });
  }
  return { ctx, scene };
}

export function paintRoom(night: number, seconds: number): SoftCtx {
  return run(night, seconds).ctx;
}

/**
 * The room as it actually reaches a viewer: blitted onto a stage of a given shape, with whatever
 * the renderer puts in the strip above it.
 *
 * The room sheets show the 480x270 buffer, which is the one thing a viewer never sees on its own.
 * Everything about the strip above the ceiling — whether it is a room or a rectangle of void,
 * whether its pixel grid lines up with the art's, whether the seam where they meet is findable — is
 * invisible in those sheets and was invisible for exactly as long as they were the only picture
 * anybody rendered.
 *
 * The blits come from `headroomBlits`, which is the same list the component's frame loop walks; the
 * only thing this file supplies is a software `drawImage`. A picture drawn by a second copy of the
 * arithmetic would be evidence about the second copy.
 */
export function paintStage(night: number, seconds: number, geo: Geo, cam: Cam = CAM_HOME): SoftCtx {
  const { ctx: buffer, scene } = run(night, seconds);
  const ceiling = new SoftCtx(480, CEILING_H);
  scene.paintCeiling(asCtx(ceiling));

  const out = new SoftCtx(Math.round(geo.w * geo.dpr), Math.round(geo.h * geo.dpr));
  out.fillStyle = PAL.wa3;
  out.fillRect(0, 0, out.width, out.height);

  const b = blitOf(clampCam(cam), geo);
  for (const p of headroomBlits(b, CEILING_H)) {
    blit(out, p.from === 'room' ? buffer : ceiling, p.sx, p.sy, p.sw, p.sh, p.dx, p.dy, p.dw, p.dh);
  }
  blit(out, buffer, b.srcX, b.srcY, b.viewW, b.viewH, b.destX, b.destY, b.destW, b.destH);
  return out;
}
