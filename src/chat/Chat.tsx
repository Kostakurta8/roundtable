/** The group chat: every agent of the followed session, in one feed, oldest first. */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useStickToBottom } from '../hooks';
import { SYSTEM, USER, type RtMsg, type RtState } from '../store';
import { MessageCard } from './MessageCard';

export type ChatProps = {
  state: RtState;
  /** The line under the header — the session's opening prompt, when there is one. */
  title: string;
  live: boolean;
  truncatedDropped: number;
  /**
   * What the hub said about the completeness of this session's tail, when it is not complete.
   *
   * Two separate losses, and neither used to be visible anywhere: lines too large to parse (each
   * of which may have carried a `tool_result`, which is why a chip can spin for ever), and a
   * catch-up read that has not yet reached the end of the file.
   */
  notice?: { skipped: number; behind: boolean };
  /** When set, only this agent's turns are shown and its cards are highlighted. */
  focusAgent: string | null;
  /** A timestamp the timeline was clicked at; the feed scrolls to the first turn at or after it. */
  seekTs: number | null;
  /**
   * Show only what the agents said to *each other*.
   *
   * The roundtable in the office turns this on, which is the whole reason that fixture is worth
   * clicking: a session's feed is mostly each agent reporting upward, and the interesting minority
   * — one agent confirming or refuting another's work — is buried in it.
   */
  crossTalk?: boolean;
  onCrossTalk?: (on: boolean) => void;
};

/**
 * A turn that is one agent answering another, rather than an agent reporting to the session.
 *
 * A verdict is the honest test: `CONFIRMED` / `REFUTED` are what agents write *about each other's
 * work*, they are already parsed for the office's confront trips, and the office and the feed have
 * to agree on which messages those are. Anything looser — "every subagent message" — is just the
 * feed again with the human removed.
 */
const isCrossTalk = (m: RtMsg): boolean =>
  m.verdict !== undefined && m.agentId !== USER && m.agentId !== SYSTEM;

/** Which lanes of the feed are on. Tools live on the cards themselves, so they are not a lane. */
type Lane = 'human' | 'agents' | 'system';
const LANES: readonly { key: Lane; label: string }[] = [
  { key: 'human', label: 'you' },
  { key: 'agents', label: 'agents' },
  { key: 'system', label: 'system' },
];

/**
 * How many cards are put in the DOM at once.
 *
 * The store keeps a thousand turns so that search and the timeline can reach them; rendering a
 * thousand cards — each with paragraphs, chips and a collapsible monologue — is what made a long
 * session scroll like treacle. The window grows on demand rather than silently hiding history.
 */
const RENDER_WINDOW = 250;

const laneOf = (m: RtMsg): Lane =>
  m.agentId === SYSTEM ? 'system' : m.agentId === USER ? 'human' : 'agents';

export function Chat({
  state,
  title,
  live,
  truncatedDropped,
  notice,
  focusAgent,
  seekTs,
  crossTalk = false,
  onCrossTalk,
}: ChatProps) {
  const [lanes, setLanes] = useState<Set<Lane>>(() => new Set<Lane>(['human', 'agents', 'system']));
  const [q, setQ] = useState('');
  const [limit, setLimit] = useState(RENDER_WINDOW);

  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return state.msgs.filter((m) => {
      if (crossTalk && !isCrossTalk(m)) return false;
      if (!lanes.has(laneOf(m))) return false;
      if (focusAgent && m.agentId !== focusAgent) return false;
      if (!needle) return true;
      return (
        m.text.toLowerCase().includes(needle) ||
        m.thinking?.toLowerCase().includes(needle) === true ||
        m.tools.some((t) => t.label.toLowerCase().includes(needle))
      );
    });
  }, [state.msgs, lanes, q, focusAgent, crossTalk]);

  const hidden = Math.max(0, shown.length - limit);
  const visible = hidden > 0 ? shown.slice(hidden) : shown;

  // Keyed on the newest id rather than on the list length: once the feed reaches its cap the
  // length stops changing, and an effect watching it would stop following the live edge for the
  // rest of the session — exactly when the session is busiest. Ids are never reused.
  const { ref, onScroll } = useStickToBottom<HTMLDivElement>(visible[visible.length - 1]?.id);

  // Seeking from the timeline. The target may be older than the render window, so the window is
  // widened first and the scroll happens on the following commit, once the card actually exists.
  const targetId = useMemo(() => {
    if (seekTs === null) return undefined;
    return (shown.find((m) => m.ts >= seekTs) ?? shown[shown.length - 1])?.id;
  }, [seekTs, shown]);

  /** The list as it stands, for the effect to consult without being re-run by it. */
  const shownRef = useRef(shown);
  shownRef.current = shown;
  /** The card this seek has already scrolled to, so it is scrolled to exactly once. */
  const seekedTo = useRef<number | undefined>(undefined);

  useEffect(() => {
    if (targetId === undefined) {
      seekedTo.current = undefined;
      return;
    }
    // The whole point of the ref: `shown` is a fresh array on every batch of arriving events, so
    // an effect that listed it re-fired `scrollIntoView` several times a second for as long as the
    // seek was held — the feed yanked itself back under the reader on every message the session
    // produced. What the seek is asking for is one journey to one card.
    if (seekedTo.current === targetId) return;
    const list = shownRef.current;
    const idx = list.findIndex((m) => m.id === targetId);
    if (idx !== -1 && list.length - idx > limit) {
      setLimit(list.length - idx + 20);
      return; // re-runs once the card is rendered
    }
    const card = ref.current?.querySelector(`[data-mid="${targetId}"]`);
    if (!card) return; // not in the DOM yet; the widening above will bring the effect back
    card.scrollIntoView({ block: 'center', behavior: 'smooth' });
    seekedTo.current = targetId;
  }, [targetId, limit, ref]);

  const toggle = (lane: Lane): void =>
    setLanes((prev) => {
      const next = new Set(prev);
      if (next.has(lane)) next.delete(lane);
      else next.add(lane);
      return next;
    });

  return (
    <>
      <div className="chat-head">
        <div className="l2" title={title}>
          {title}
        </div>
      </div>

      <div className="tab-tools">
        <input
          className="search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="search this session…"
          aria-label="search the feed"
        />
        {LANES.map(({ key, label }) => (
          <button
            key={key}
            type="button"
            className={lanes.has(key) ? 'filter-chip on' : 'filter-chip'}
            aria-pressed={lanes.has(key)}
            onClick={() => toggle(key)}
          >
            {label}
          </button>
        ))}
        {onCrossTalk && (
          <button
            type="button"
            className={crossTalk ? 'filter-chip on' : 'filter-chip'}
            aria-pressed={crossTalk}
            title="only what the agents said to each other"
            onClick={() => onCrossTalk(!crossTalk)}
          >
            verdicts
          </button>
        )}
      </div>

      <div className="scroller" ref={ref} onScroll={onScroll}>
        {/* The gap is named rather than hidden: a feed that silently starts mid-conversation lies.
            Two separate counts because they are two different losses — events the hub could no
            longer replay, and messages this client's own cap pushed off the top. */}
        {truncatedDropped > 0 && <div className="msg-sys">— {truncatedDropped} earlier events dropped —</div>}
        {/* A third loss, from the other end of the pipe: the hub could not read part of the file.
            It was counted and never shown, so a tool chip that spins for ever because its result
            was on a line too large to parse looked like an agent that had simply stopped. */}
        {notice && notice.skipped > 0 && (
          <div className="msg-sys">
            — {notice.skipped} transcript line{notice.skipped === 1 ? '' : 's'} too large to read; any
            tool call answered on {notice.skipped === 1 ? 'it' : 'them'} will not resolve —
          </div>
        )}
        {notice?.behind === true && <div className="msg-sys">— still catching up on this transcript —</div>}
        {state.trimmed > 0 && <div className="msg-sys">— {state.trimmed} earlier messages trimmed —</div>}
        {hidden > 0 && (
          <div className="msg-sys">
            <button type="button" className="btn" onClick={() => setLimit((w) => w + RENDER_WINDOW)}>
              show {Math.min(hidden, RENDER_WINDOW)} older of {hidden}
            </button>
          </div>
        )}

        {state.msgs.length === 0 && (
          <div className="empty-note">
            {live ? 'waiting for the session to say something' : 'not connected to the observer hub'}
          </div>
        )}
        {state.msgs.length > 0 && shown.length === 0 && (
          <div className="empty-note">nothing here matches the current filter</div>
        )}

        {visible.map((m) => (
          <MessageCard
            key={m.id}
            msg={m}
            agent={state.agents[m.agentId]}
            focus={focusAgent !== null && m.agentId === focusAgent}
          />
        ))}
      </div>
    </>
  );
}
