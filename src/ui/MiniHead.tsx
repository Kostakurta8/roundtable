/** The 15px avatar — skin, hair and a sliver of torso, in the agent's own tints. */
import { memo } from 'react';
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
