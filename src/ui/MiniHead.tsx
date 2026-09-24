/** The 15px avatar — skin, hair and a sliver of torso, in the agent's own tints. */
import { memo, type CSSProperties } from 'react';
import { agentLook } from '../store';

export const MiniHead = memo(function MiniHead({ agentId }: { agentId: string }) {
  const look = agentLook(agentId);
  return (
    <span className="mini" aria-hidden="true">
      <span className="mh" style={{ background: look.skin }} />
      <span className="mha" style={{ background: look.hair }} />
      <span className="mc" style={{ background: look.tint }} />
    </span>
  );
});

/**
 * An agent's name colour, handed to the stylesheet rather than painted inline.
 *
 * The looks in the store are one colour per agent, chosen against the day theme's paper — and
 * written straight into `style.color` they were printed unchanged on the night theme's charcoal,
 * where the orchestrator's own charcoal came out at 1.6:1: `main`, the one name every session has,
 * was the least legible word on the screen. As a custom property, `.agent-ink` in `index.css` can
 * keep the agent's hue and move its lightness to wherever each theme needs it, the same way every
 * other colour in the shell is themed — by the stylesheet, never by a branch in a component.
 */
export const agentInk = (agentId: string): CSSProperties =>
  ({ '--agent': agentLook(agentId).color }) as CSSProperties;
