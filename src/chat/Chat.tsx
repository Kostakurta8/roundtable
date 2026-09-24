/** The group chat: every agent of the followed session, in one feed, oldest first. */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useStickToBottom } from '../hooks';
import { SYSTEM, USER, type RtMsg, type RtState } from '../store';
import { MessageCard, SystemRun } from './MessageCard';

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

/**
 * How many messages may land in one render and still count as news.
 *
 * A card that arrives while the panel is on screen fades in; a card that is *replayed* into it
 * must not, and the two are told apart by how many came at once. A live turn is one card, a busy
 * second a handful. A backlog — first load, a reconnect, switching back to a session the hub had
 * evicted — is hundreds in a single batch, and animating all of them is what left the packaged
 * app with an empty feed: sixty simultaneous fades that Chromium ran at a fraction of real time,
 * so that at +1.5s every card in view still had `opacity: 0`. History lands already there.
 */
const FRESH_BATCH_MAX = 8;

/** How the shell titles a session that has an opening prompt; the header sets the word apart. */
const TASK_PREFIX = 'TASK · ';

const laneOf = (m: RtMsg): Lane =>
  m.agentId === SYSTEM ? 'system' : m.agentId === USER ? 'human' : 'agents';

/** A stretch of the feed as it is drawn: one turn, or a run of consecutive system lines. */
export type FeedItem = { kind: 'one'; msg: RtMsg } | { kind: 'run'; msgs: RtMsg[] };

/**
 * Folds every run of two or more consecutive system lines into one item, and leaves the rest alone.
 *
 * Only *consecutive* lines fold, for the reason `tally` gives about tool chips: grouping every
 * system line would move later ones back to the first one's position and rewrite the order the
 * session happened in. A lone system line stays a line — folding one thing into a summary of one
 * thing is a click for nothing.
 */
export function foldSystem(msgs: readonly RtMsg[]): FeedItem[] {
  const out: FeedItem[] = [];
  for (let i = 0; i < msgs.length; ) {
    const m = msgs[i];
    let j = i;
    while (j < msgs.length && msgs[j].agentId === SYSTEM) j += 1;
    if (j - i >= 2) {
      out.push({ kind: 'run', msgs: msgs.slice(i, j) });
      i = j;
    } else {
      out.push({ kind: 'one', msg: m });
      i += 1;
    }
  }
  return out;
}

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
  const items = useMemo(() => foldSystem(visible), [visible]);
  /**
   * Runs open themselves when a fold would hide what the reader asked for: a search (the match may
   * be the line inside), or a feed filtered down to the system lane (where a run would be the whole
   * feed behind one line).
   */
  const openRuns = q.trim() !== '' || (lanes.has('system') && !lanes.has('agents') && !lanes.has('human'));

  /**
   * Which cards are news. Ids are ascending and never reused, so "everything above the id this
   * panel had already seen" names the arrivals exactly — provided they arrived in a live-sized
   * batch. The first render primes the mark without animating anything: whatever is on screen when
   * the panel opens is history by definition. Kept in a ref and read during render, so a re-render
   * for a keystroke in the search box neither advances the mark nor cuts a fade short.
   */
  const lastId = state.msgs.length > 0 ? state.msgs[state.msgs.length - 1].id : -1;
  const fresh = useRef<{ seen: number; from: number; primed: boolean }>({ seen: -1, from: Number.POSITIVE_INFINITY, primed: false });
  const t = fresh.current;
  if (!t.primed) {
    t.primed = true;
    t.seen = lastId;
  } else if (lastId !== t.seen) {
    // A reset replays from id 0, so `lastId` can go *down*; that is a batch, not news.
    t.from = lastId > t.seen && lastId - t.seen <= FRESH_BATCH_MAX ? t.seen : Number.POSITIVE_INFINITY;
    t.seen = lastId;
  }
  const freshFrom = t.from;

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
    // A system line inside a run is found as the line, not as the run: the run opens itself for the
    // seek (`reveal`), and its container carries its first line's id too, so a plain `[data-mid]`
    // would land on the fold's header. The run is only the fallback, for a line not rendered yet.
    const card =
      ref.current?.querySelector(`.sys-line[data-mid="${targetId}"]`) ??
      ref.current?.querySelector(`[data-mid="${targetId}"]`) ??
      ref.current?.querySelector(`[data-run~="${targetId}"]`);
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

  /**
   * Whether the feed is scrolled under the header.
   *
   * The feed follows the live edge, so on load it is scrolled to the bottom and the opening turn —
   * the human's prompt — sits cut off at the top of the scroller, directly under the filter row.
   * Nothing overlapped it; it was clipped by the scroller's edge. But a hard edge with text sliced
   * along it reads as one panel lying on top of another, and that is what people reported. With the
   * header lifted off the feed by a shadow while anything is scrolled under it, the same pixels read
   * as what they are: a list that continues upward. The prompt itself is the header's brief, whole,
   * so nothing a newcomer needs is behind the scroll.
   */
  const [under, setUnder] = useState(false);
  const scrolled = (): void => {
    onScroll();
    const now = (ref.current?.scrollTop ?? 0) > 2;
    if (now !== under) setUnder(now);
  };
  const brief = title.startsWith(TASK_PREFIX) ? title.slice(TASK_PREFIX.length) : null;

  return (
    <>
      <div className={under ? 'chat-top under' : 'chat-top'}>
        <div className="chat-head" title={title}>
          {brief !== null ? (
            <>
              <span className="chat-k">TASK</span>
              <p className="chat-brief">{brief}</p>
            </>
          ) : (
            <p className="chat-brief">{title}</p>
          )}
        </div>

        <div className="tab-tools">
          <input
            className="search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="search this session…"
            aria-label="search the feed"
          />
          <div className="chip-set" role="group" aria-label="show in the feed">
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
        </div>
      </div>

      <div className="scroller" ref={ref} onScroll={scrolled}>
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

        {items.map((it) =>
          it.kind === 'run' ? (
            // Keyed on the run's first line, so a run that grows as the fan-out continues keeps its
            // open or closed state rather than remounting shut under the reader.
            <SystemRun
              key={it.msgs[0].id}
              msgs={it.msgs}
              fresh={it.msgs[0].id > freshFrom}
              forceOpen={openRuns}
              reveal={targetId}
            />
          ) : (
            <MessageCard
              key={it.msg.id}
              msg={it.msg}
              agent={state.agents[it.msg.agentId]}
              focus={focusAgent !== null && it.msg.agentId === focusAgent}
              fresh={it.msg.id > freshFrom}
            />
          ),
        )}
      </div>
    </>
  );
}
