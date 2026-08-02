/**
 * The room: the approved mockup (`docs/mockup/office-sim-v5.html`) ported to React, plus the
 * loop that keeps it alive.
 *
 * Every block of furniture below cites the mockup lines it was transcribed from. Nothing here
 * decides behaviour — `useOffice` folds the event stream into commands (`mapping.ts`) and hands
 * them to the simulation (`engine.ts`); this file only draws whatever the latest tick reported.
 *
 * The scene is a fixed 1600x900 stage (`SCENE`) scaled to the window, so a percentage means the
 * same thing here as it does in the mockup and an actor's engine coordinates land 1:1 on it.
 */
import { memo, useEffect, useLayoutEffect, useRef, useState, type MutableRefObject } from 'react';
import { agentLook, type RtAgent } from '../store';
import type { EvSink } from '../ws';
import { Actor } from './Actor';
import { Engine, MANAGER_DESK_INDEX, podSeat, SCENE, WAYPOINTS, type ActorState } from './engine';
import { mapEvent } from './mapping';
import './scene.css';

/**
 * The longest frame the simulation is allowed to see. A backgrounded tab stops firing
 * `requestAnimationFrame` entirely, so the first frame after it returns carries the whole
 * absence — minutes of it — and every queued walk would resolve in one jump. Clamping trades
 * that teleport for a few dropped seconds of office time, which nobody can miss.
 */
const MAX_FRAME_MS = 100;

const EMPTY: readonly ActorState[] = [];

type Sim = { engine: Engine; roster: Set<string> };

const freshSim = (): Sim => ({ engine: new Engine(), roster: new Set<string>() });

/** Lazily creates the simulation on first use, so no render allocates a throwaway `Engine`. */
const simOf = (ref: MutableRefObject<Sim | null>): Sim => (ref.current ??= freshSim());

/**
 * True when two ticks describe the same room. The engine hands back a fresh array of fresh
 * objects every frame; without this, an office where nobody is moving would still re-render
 * sixty times a second forever.
 */
function sameActors(a: readonly ActorState[], b: readonly ActorState[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const p = a[i];
    const n = b[i];
    if (
      p.id !== n.id ||
      p.x !== n.x ||
      p.y !== n.y ||
      p.pose !== n.pose ||
      p.flip !== n.flip ||
      p.away !== n.away ||
      p.say !== n.say ||
      p.think !== n.think ||
      p.verdict !== n.verdict ||
      p.status !== n.status
    ) {
      return false;
    }
  }
  return true;
}

/**
 * The office half of the client: an event sink to hand to `useRtStream`, and the actors to draw.
 *
 * `feed.reset` exists because the hub replays a session's whole backlog to every new follower.
 * A reconnect — or a switch to another session — therefore replays history the office has
 * already acted on, and re-applying it would queue every walk a second time. The sink resets in
 * exactly the same places the chat store resets, so the two halves can never disagree about
 * which session they are showing.
 */
export function useOffice(): { actors: readonly ActorState[]; feed: EvSink } {
  const [actors, setActors] = useState<readonly ActorState[]>(EMPTY);
  const sim = useRef<Sim | null>(null);
  const feed = useRef<EvSink | null>(null);

  // One stable sink for the socket's whole lifetime: it reads the simulation through the ref,
  // so a reset can swap the engine underneath it without the hook's effect ever re-running.
  feed.current ??= {
    ev: (ev) => {
      const { engine, roster } = simOf(sim);
      for (const cmd of mapEvent(ev, roster)) {
        if (cmd.op === 'ensureActor') roster.add(cmd.agentId);
        engine.apply(cmd);
      }
    },
    reset: () => {
      sim.current = freshSim();
      setActors(EMPTY);
    },
  };

  useEffect(() => {
    let raf = 0;
    let prev = 0;
    const frame = (now: number): void => {
      raf = requestAnimationFrame(frame);
      const dt = prev === 0 ? 0 : Math.min(MAX_FRAME_MS, now - prev);
      prev = now;
      const next = simOf(sim).engine.tick(dt);
      setActors((current) => (sameActors(current, next) ? current : next));
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, []);

  return { actors, feed: feed.current };
}

// ------------------------------------------------------------------ geometry

/** Scene percentages, which is how the mockup expresses every position. */
const pctX = (px: number): number => (px / SCENE.w) * 100;
const pctY = (px: number): number => (px / SCENE.h) * 100;

/**
 * A workstation, derived from the seat the engine put its owner at. The four mockup pods and
 * its manager desk all sit 5.2% above their chair and centred on it (mockup 396/408/422/434 vs
 * `SEAT`, 590-595), so one rule reproduces all five and extends to a sixth agent for free.
 */
const DESK = {
  pod: { w: 9, matW: 11, matDy: 1.5 },
  manager: { w: 12, matW: 14, matDy: 1 },
} as const;
const DESK_ABOVE_SEAT = 5.2;
const MAT_H = 11;

/** Mockup 396 (`z-index:330` at `top:29%`) — a desk hides whoever is standing behind it. */
const deskZ = (topPct: number): number => Math.round(40 + topPct * 10);

type Station = {
  id: string;
  manager: boolean;
  left: number;
  top: number;
  width: number;
  matLeft: number;
  matTop: number;
  matWidth: number;
};

function station(actor: ActorState): Station {
  const manager = actor.deskIndex === MANAGER_DESK_INDEX;
  const seat = manager ? WAYPOINTS.managerSeat : podSeat(actor.deskIndex);
  const dim = manager ? DESK.manager : DESK.pod;
  const cx = pctX(seat.x);
  const top = pctY(seat.y) - DESK_ABOVE_SEAT;
  return {
    id: actor.id,
    manager,
    left: cx - dim.w / 2,
    top,
    width: dim.w,
    matLeft: cx - dim.matW / 2,
    matTop: top - dim.matDy,
    matWidth: dim.matW,
  };
}

// ----------------------------------------------------------------- furniture

/** Mockup 474-491, three times over. */
function Plant({ style, width, height }: { style: React.CSSProperties; width: number; height: number }) {
  return (
    <svg className="plant" style={style} width={width} height={height} viewBox="0 0 54 76" aria-hidden="true">
      <ellipse cx="27" cy="24" rx="6" ry="17" fill="#4E7A40" transform="rotate(-26 27 28)" />
      <ellipse cx="27" cy="20" rx="6" ry="19" fill="#5A8A4A" />
      <ellipse cx="27" cy="24" rx="6" ry="17" fill="#4E7A40" transform="rotate(26 27 28)" />
      <path d="M15 46h24l-4 27H19Z" fill="#B8674A" />
      <path d="M14 46h26v5H14Z" fill="#A85A40" />
    </svg>
  );
}

/**
 * Everything in the room that never moves and never depends on who is in it. Rendered once:
 * the actors re-render sixty times a second and the furniture has no business joining them.
 */
const Room = memo(function Room() {
  return (
    <>
      <div className="floor" />

      {/* Mockup 357-359: daylight pools under the windows. */}
      <div className="pool" style={{ left: '15.5%' }} />
      <div className="pool" style={{ left: '31.5%' }} />
      <div className="pool" style={{ left: '58%' }} />

      {/* Mockup 362-368: windows, a picture and the office clock. */}
      <div className="wallfix window" style={{ left: '15%' }}>
        <span className="sun" />
        <span className="cloud" style={{ left: 36 }} />
      </div>
      <div className="wallfix window" style={{ left: '31%' }}>
        <span className="cloud" style={{ left: 8, animationDuration: '21s' }} />
      </div>
      <div className="wallfix window" style={{ left: '58%' }}>
        <span className="cloud" style={{ left: 20, animationDuration: '24s' }} />
      </div>
      <div className="wallfix art" style={{ left: '47%' }}>
        <svg width="30" height="38" viewBox="0 0 30 38" aria-hidden="true">
          <rect width="30" height="38" fill="#F3EFE4" />
          <circle cx="15" cy="14" r="8" fill="#D89440" opacity=".8" />
          <path d="M0 30 10 20l8 8 6-5 6 6v9H0Z" fill="#3E9AA8" opacity=".75" />
        </svg>
      </div>
      <div className="wallfix clock" style={{ left: '52.6%' }} aria-hidden="true" />

      {/* Mockup 371-377: the kitchen corner the coffee trips end at. */}
      <div className="kitchen" style={{ left: '2%', top: '13.6%', width: '10.5%' }}>
        <div className="machine">
          <span className="led" />
          <span className="steam">≋</span>
        </div>
        <div className="k-top">
          <span className="sink" />
        </div>
        <div className="k-front" />
        <div className="fridge">
          <div className="f-top" />
          <div className="f-front" />
        </div>
        <span className="k-label">kitchen · coffee</span>
      </div>

      {/* Mockup 393 + 465-471: the rug, the roundtable and its three chairs. */}
      <div className="rug-round" style={{ left: '54.5%', top: '57%', width: '18%', height: '29%' }} />
      <div className="table" style={{ left: '57.5%', top: '63.5%', width: '12%', zIndex: 560 }}>
        <div className="t-top" style={{ height: 68 }}>
          <span className="t-laptop" />
          <span className="t-paper" />
        </div>
        <div className="t-rim" />
      </div>
      <div className="chair" style={{ left: '55%', top: '68.5%', zIndex: 545 }}>
        <div className="c-back" />
        <div className="c-seat" />
      </div>
      <div className="chair" style={{ left: '70.5%', top: '68.5%', zIndex: 545 }}>
        <div className="c-back" />
        <div className="c-seat" />
      </div>
      <div className="chair" style={{ left: '62.8%', top: '59%', zIndex: 520 }}>
        <div className="c-back" />
        <div className="c-seat" />
      </div>

      {/* Mockup 474-491. */}
      <Plant style={{ left: '18.5%', bottom: '3.5%' }} width={56} height={78} />
      <Plant style={{ left: '36%', top: '14.5%' }} width={40} height={56} />
      <Plant style={{ right: '26%', bottom: '5%' }} width={48} height={66} />
    </>
  );
});

/** Mockup 380-385. The task is the session's opening prompt; the tally is what the room adds up to. */
function Board({ task, agents, turns }: { task: string; agents: number; turns: number }) {
  return (
    <div className="board" style={{ left: '39%', top: '15%' }}>
      <div className="b-title">WHITEBOARD</div>
      <div className="b-task" title={task}>
        {task}
      </div>
      <div className="b-tally">
        agents: {agents} · turns: {turns}
      </div>
      <span className="b-leg l" />
      <span className="b-leg r" />
    </div>
  );
}

/** Mockup 399-401: three code lines, the top one in the occupant's own colour. */
function Screen({ tint, small }: { tint: string; small?: boolean }) {
  return (
    <div className="scr">
      <div className="ln" style={{ background: tint, width: small ? '48%' : '55%' }} />
      <div className="ln" style={{ background: 'var(--screen-ln)', width: small ? '60%' : '70%' }} />
      {!small && <div className="ln" style={{ background: 'var(--screen-ln)', width: '44%' }} />}
    </div>
  );
}

/**
 * One desk. Mockup 396-462: pods carry one monitor, the manager desk a second small one; the
 * clutter alternates between a mug and a stack of paper so no two neighbours look identical.
 *
 * The screens flicker while their owner is seated with something to show for it — the engine's
 * status line is the office's only signal of activity, and an empty one means the agent has
 * done nothing yet.
 */
function Desk({ at, name, tint, color, working }: {
  at: Station;
  name: string;
  tint: string;
  color: string;
  working: boolean;
}) {
  const mon = `mon${working ? ' on' : ''}`;
  return (
    <>
      <div
        className="mat"
        style={{ left: `${at.matLeft}%`, top: `${at.matTop}%`, width: `${at.matWidth}%`, height: `${MAT_H}%` }}
      />
      <div
        className="desk"
        style={{ left: `${at.left}%`, top: `${at.top}%`, width: `${at.width}%`, zIndex: deskZ(at.top) }}
      >
        <span className="nametag" style={{ color }} title={at.id}>
          {name}
        </span>
        <div className="d-top">
          <div className={mon} style={{ left: at.manager ? 12 : 8 }}>
            <Screen tint={tint} />
          </div>
          {/* Mockup 454-456: the orchestrator's second screen, green in the mockup and green
              here — it is the room's monitor, not any one agent's, so it takes no tint. */}
          {at.manager && (
            <div className={`${mon} small`} style={{ left: 68, top: -20 }}>
              <Screen tint="#7AC88A" small />
            </div>
          )}
          <div className="kbd" style={{ left: at.manager ? 22 : 14 }} />
          <div className="mouse" style={{ left: at.manager ? 58 : 46 }} />
          {at.manager || at.id.charCodeAt(0) % 2 === 0 ? (
            <div className="d-mug" style={{ right: 10 }} />
          ) : (
            <div className="d-papers" style={{ right: 6 }} />
          )}
        </div>
        <div className="d-front" />
      </div>
    </>
  );
}

// -------------------------------------------------------------------- office

export type OfficeProps = {
  actors: readonly ActorState[];
  agents: Readonly<Record<string, RtAgent>>;
  /** The session's opening prompt, for the whiteboard. */
  task: string;
  turns: number;
};

/** Fits the 1600x900 stage into its container, centred, top-aligned so the wall stays at the top. */
function useSceneFit(ref: MutableRefObject<HTMLDivElement | null>): { scale: number; dx: number } {
  const [fit, setFit] = useState({ scale: 1, dx: 0 });

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = (): void => {
      const { width, height } = el.getBoundingClientRect();
      if (width === 0 || height === 0) return; // never scale to nothing (a hidden tab measures 0)
      const scale = Math.min(width / SCENE.w, height / SCENE.h);
      const dx = Math.round((width - SCENE.w * scale) / 2);
      setFit((prev) => (prev.scale === scale && prev.dx === dx ? prev : { scale, dx }));
    };
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    measure();
    return () => ro.disconnect();
  }, [ref]);

  return fit;
}

export function Office({ actors, agents, task, turns }: OfficeProps) {
  const shell = useRef<HTMLDivElement | null>(null);
  const { scale, dx } = useSceneFit(shell);

  return (
    <div className="office" ref={shell}>
      <div className="scene" style={{ transform: `translate(${dx}px, 0) scale(${scale})` }}>
        <Room />
        <Board task={task} agents={actors.length} turns={turns} />

        {actors.map((a) => {
          const look = agentLook(a.id);
          return (
            <Desk
              key={`desk-${a.id}`}
              at={station(a)}
              name={agents[a.id]?.label ?? a.id}
              tint={look.tint}
              color={look.color}
              working={a.pose === 'sit' && a.status !== ''}
            />
          );
        })}

        {actors.map((a) => (
          <Actor key={a.id} actor={a} look={agentLook(a.id)} />
        ))}
      </div>
    </div>
  );
}
