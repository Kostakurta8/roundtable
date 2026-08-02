/**
 * One person in the room, drawn from one `ActorState`.
 *
 * Markup and class names are the mockup's (`docs/mockup/office-sim-v5.html` lines 207-264 for
 * the CSS contract, 494-500 for the body). The engine owns every number here: this component
 * decides nothing about where anyone is or what they are doing.
 */
import { useRef } from 'react';
import type { AgentLook } from '../store';
import { SCENE, type ActorState } from './engine';

/** Mockup 610: `zIndex = round(400 + y * 10)` with y in percent — nearer the camera, higher up. */
const zAt = (yPct: number): number => Math.round(400 + yPct * 10);

const poseClass = (pose: ActorState['pose']): string =>
  pose === 'sit' ? 'sitting' : pose === 'walk' ? 'walking' : '';

const classes = (a: ActorState): string =>
  ['actor', poseClass(a.pose), a.away ? 'away' : '', a.flip ? 'flip' : ''].filter(Boolean).join(' ');

export function Actor({ actor, look }: { actor: ActorState; look: AgentLook }) {
  // A bubble fades out over 220ms after its text is gone, so the last words have to survive the
  // fade — swapping them for an empty string would collapse the bubble instead of dissolving it.
  const lastSay = useRef('');
  const lastThink = useRef('');
  if (actor.say !== undefined) lastSay.current = actor.say;
  if (actor.think !== undefined) lastThink.current = actor.think;

  const xPct = (actor.x / SCENE.w) * 100;
  const yPct = (actor.y / SCENE.h) * 100;
  const verdict = actor.say !== undefined && actor.verdict ? ` verdict-${actor.verdict}` : '';

  return (
    <div
      className={classes(actor)}
      style={{ left: `${xPct}%`, top: `${yPct}%`, zIndex: zAt(yPct) }}
      data-agent={actor.id}
    >
      <div className={`say${actor.say !== undefined ? ' on' : ''}${verdict}`}>{lastSay.current}</div>
      <div className={`think${actor.think !== undefined ? ' on' : ''}`}>{lastThink.current}</div>

      <div className="person">
        <span className="p-shadow" />
        <span className="p-legs">
          <i />
          <i />
        </span>
        <span className="p-arm l" style={{ background: look.tint }} />
        <span className="p-arm r" style={{ background: look.tint }} />
        <span className="p-torso" style={{ background: look.tint }} />
        <span className="p-head p-eyes" style={{ background: look.skin }} />
        <span className="p-hair" style={{ background: look.hair }} />
      </div>

      {actor.status !== '' && <span className="p-status">{actor.status}</span>}
    </div>
  );
}
