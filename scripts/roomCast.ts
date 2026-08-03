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
import { LOUNGE_DESK_INDEX, loungeSpot, MANAGER_DESK_INDEX, podSeat, WAYPOINTS } from '../src/office/engine';
import { Scene, type Ghost, type SceneAgent } from '../src/office/pixel/scene';
import { agentLook } from '../src/store';
import { asCtx, SoftCtx } from './pixpreview';

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
  // The break corner, one of each kind of place, because this sheet is a checklist: two on the
  // stools at the café table, two standing at it, one at the counter, one on the couch, and one
  // at the ash stand having a cigarette.
  ...['stoolW', 'stoolE', 'tableFar', 'tableNear', 'counter', 'cooler', 'couchL', 'couchR', 'smoker'].map(
    (id, i): Spec => ({
      id,
      deskIndex: LOUNGE_DESK_INDEX,
      pose: 'stand',
      away: false,
      status: 'done',
      done: true,
      doneOk: i !== 4,
      retired: true,
      lounging: true,
      loungeSlot: i,
      at: loungeSpot(i),
    }),
  ),
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
 * Paints the review room and hands back the buffer it painted into.
 *
 * Wound forward in real-sized steps rather than one jump: every animation phase in the room is an
 * accumulation, and a single enormous delta would land them all somewhere they never are.
 */
export function paintRoom(night: number, seconds: number): SoftCtx {
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
  return ctx;
}
