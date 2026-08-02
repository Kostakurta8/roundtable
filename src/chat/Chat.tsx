/** The group chat: every agent of the followed session, in one feed, oldest first. */
import { useEffect, useRef } from 'react';
import type { RtState } from '../store';
import { MessageCard } from './MessageCard';

export type ChatProps = {
  state: RtState;
  /** The line under the header — the session's opening prompt, when there is one. */
  title: string;
  live: boolean;
  truncatedDropped: number;
};

/** Below this many pixels from the bottom, the reader counts as following the live edge. */
const PINNED_SLACK = 48;

export function Chat({ state, title, live, truncatedDropped }: ChatProps) {
  const scroller = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);

  // Auto-scroll only while the reader is already at the bottom. Yanking the view away from
  // someone who scrolled up to read is the one thing a log window must never do.
  useEffect(() => {
    const el = scroller.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  }, [state.msgs.length]);

  const onScroll = (): void => {
    const el = scroller.current;
    if (el) pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < PINNED_SLACK;
  };

  return (
    <aside className="chat glass">
      <div className="chat-head">
        <div className="l1">
          GROUP CHAT
          <span className="cnt">
            {live && <span className="live-dot" />}
            {live ? `${state.msgs.length} msgs` : 'reconnecting…'}
          </span>
        </div>
        <div className="l2" title={title}>
          {title}
        </div>
      </div>

      <div className="chat-scroll" ref={scroller} onScroll={onScroll}>
        {/* The gap is named rather than hidden: a feed that silently starts mid-conversation lies. */}
        {truncatedDropped > 0 && <div className="msg-sys">— {truncatedDropped} earlier events dropped —</div>}
        {state.msgs.length === 0 && <div className="msg-sys">— waiting for the session to say something —</div>}
        {state.msgs.map((m) => (
          <MessageCard key={m.id} msg={m} agent={state.agents[m.agentId]} />
        ))}
      </div>

      <div className="chat-foot">observer mode · read-only · tailing ~/.claude/projects</div>
    </aside>
  );
}
