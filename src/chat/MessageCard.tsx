/** One line of the feed: a human turn, an agent's card, or a system note. */
import { memo } from 'react';
import { modelInfo } from '../../shared/models';
import { agentLook, SYSTEM, USER, type RtAgent, type RtMsg, type RtTool } from '../store';
import { clock, duration, editLines, isoOrUndefined } from '../ui/format';
import { MiniHead } from '../ui/MiniHead';

const NAME_MAX = 16;

/**
 * Past this many characters a machine-written `user` line is folded away behind a summary.
 *
 * Aimed at the compaction summary, which is the CLI's account of everything it had to forget and
 * runs to around 14 500 characters — roughly two hundred lines of the feed, arriving in one card,
 * burying the conversation on either side of it. It is worth keeping and worth reading; it is not
 * worth the whole panel. Nothing the human actually typed is ever folded.
 */
const FOLD_OVER = 1200;

/** Blank lines are paragraph breaks. Everything else is rendered verbatim, as text — never HTML. */
const paragraphs = (text: string): string[] => {
  const parts = text.split(/\n{2,}/).filter((p) => p.trim().length > 0);
  return parts.length > 0 ? parts : [text];
};

/** One chip: a run of identical adjacent calls, and how they ended. */
export type ToolGroup = {
  key: string;
  label: string;
  n: number;
  /** `undefined` while at least one call in the run is still open. */
  ok?: boolean;
  /** Total wall time of the run, when every call in it has returned. */
  ms?: number;
  /**
   * Lines the run added and removed, when every call in it could be counted.
   *
   * Same all-or-nothing rule as the duration, for the same reason: `+12` over two edits of which
   * only one was countable is not that run's total, it is a floor wearing a total's clothes.
   */
  added?: number;
  removed?: number;
};

/** `a + b`, or nothing at all when either side is unknown. */
const sum = (a: number | undefined, b: number | undefined): number | undefined =>
  a === undefined || b === undefined ? undefined : a + b;

/** `undefined` (running) is its own bucket, so a finished call never merges into a pending one. */
const outcome = (t: RtTool): string => (t.ok === undefined ? 'run' : t.ok ? 'ok' : 'err');

/**
 * Counts repeats instead of listing them — "Grep ×4", not four Grep chips. It matters on real
 * data: tools called without a file or pattern (Bash, TodoWrite…) all label as the bare tool
 * name, so a busy turn would otherwise read "Bash Bash Bash Bash".
 *
 * Only *consecutive* repeats collapse, because only those actually happened consecutively.
 * Grouping every occurrence of a label would move later calls back to the first one's position
 * and quietly rewrite the order of the turn: `Bash, Read x, Bash` is three things that happened,
 * not two. Purely a display tally — the store keeps every call, in order, for anything that
 * needs them individually.
 */
export function tally(tools: readonly RtTool[]): ToolGroup[] {
  const out: ToolGroup[] = [];
  for (let i = 0; i < tools.length; ) {
    const head = tools[i];
    const key = `${head.label}\0${outcome(head)}`;
    let n = 1;
    let ms = head.ms;
    let added = head.added;
    let removed = head.removed;
    while (i + n < tools.length && `${tools[i + n].label}\0${outcome(tools[i + n])}` === key) {
      const next = tools[i + n];
      ms = sum(ms, next.ms);
      added = sum(added, next.added);
      removed = sum(removed, next.removed);
      n += 1;
    }
    out.push({ key: `${i}-${key}`, label: head.label, n, ok: head.ok, ms, added, removed });
    i += n;
  }
  return out;
}

function Chip({ g }: { g: ToolGroup }) {
  const cls = g.ok === false ? 'chip failed' : g.ok === undefined ? 'chip running' : 'chip';
  // What the edit did, where the edit is already named. The chip said which file an agent had
  // touched and stopped there, which is the half of the sentence nobody needed.
  const lines = editLines(g.added, g.removed);
  const title = [g.label, lines && `${lines} lines`, g.ms !== undefined ? duration(g.ms) : undefined]
    .filter(Boolean)
    .join(' · ');
  return (
    <span className={cls} title={title}>
      <span className="t">{g.label}</span>
      {g.n > 1 && <span>×{g.n}</span>}
      {lines && <span className="edits">{lines}</span>}
      {g.ms !== undefined && g.ms >= 1000 && <span className="ms">{duration(g.ms)}</span>}
    </span>
  );
}

const displayName = (msg: RtMsg, agent?: RtAgent): string => {
  const name = agent?.label ?? msg.agentId;
  return name.length > NAME_MAX ? `${name.slice(0, NAME_MAX - 1)}…` : name;
};

/**
 * Memoised because the feed is a list that only ever grows at one end: `reduce` copies the
 * `msgs` array on every event but keeps each `RtMsg` object identical, so without this every
 * arriving event re-renders every card already on screen — hundreds of them, several times a
 * second, while the office is animating alongside. A card whose message and agent are the same
 * objects as last time draws the same pixels, so it can be skipped outright.
 */
export const MessageCard = memo(function MessageCard({
  msg,
  agent,
  focus,
  fresh,
}: {
  msg: RtMsg;
  agent?: RtAgent;
  focus?: boolean;
  /**
   * Whether this card arrived while the panel was on screen, as opposed to being replayed into
   * it. Only a fresh card gets the entrance animation — see `Chat` for why a replay must not.
   */
  fresh?: boolean;
}) {
  // `data-mid` is how the timeline finds a card to scroll to: seeking by index would break the
  // moment a filter is on, and seeking by scroll fraction assumes every card is the same height.
  if (msg.agentId === SYSTEM) {
    return (
      <div className={fresh ? 'msg-sys fresh' : 'msg-sys'} data-mid={msg.id}>
        — {msg.text} —
      </div>
    );
  }

  const isUser = msg.agentId === USER;
  // A `user` line the CLI wrote itself — a slash-command echo, a hook, a reminder. Real, and
  // worth showing, but it is not the human speaking and must not be dressed as if it were.
  const machine = isUser && msg.source !== undefined && msg.source !== 'human';
  const who = isUser ? (machine ? msg.source : 'you') : displayName(msg, agent);
  const folded = machine && msg.text.length > FOLD_OVER;
  const color = isUser ? 'var(--ink-2)' : agentLook(msg.agentId).color;
  const model = agent?.model ? modelInfo(agent.model).short : undefined;

  const cls = [isUser ? 'msg msg-user' : 'msg', machine ? 'machine' : '', focus ? 'focus' : '', fresh ? 'fresh' : '']
    .filter(Boolean)
    .join(' ');

  return (
    <div className={cls} data-mid={msg.id}>
      {!isUser && <MiniHead agentId={msg.agentId} />}
      <div className={`msg-card${msg.verdict ? ` verdict-${msg.verdict}` : ''}`}>
        <div className="msg-head">
          <span className="who" style={{ color }} title={agent?.model ?? msg.agentId}>
            {who}
          </span>
          {model && <span className="model">{model}</span>}
          <time dateTime={isoOrUndefined(msg.ts)}>{clock(msg.ts)}</time>
        </div>

        {/* The verdict is stated as well as drawn: a colour alone is not a claim anyone can read. */}
        {msg.verdict && (
          <div className="chips chips-verdict">
            <span className={msg.verdict === 'ok' ? 'chip chip--ok' : 'chip chip--refuted'}>
              {msg.verdict === 'ok' ? '✓ CONFIRMED' : '✕ REFUTED'}
            </span>
          </div>
        )}

        {folded ? (
          <details className="monologue">
            <summary>{`${msg.source === 'compaction' ? 'summary of the forgotten conversation' : who} · ${msg.text.length.toLocaleString()} characters`}</summary>
            <div className="msg-body">
              {paragraphs(msg.text).map((p, i) => (
                <p key={i}>{p}</p>
              ))}
            </div>
          </details>
        ) : (
          <div className="msg-body">
            {paragraphs(msg.text).map((p, i) => (
              <p key={i}>{p}</p>
            ))}
          </div>
        )}

        {msg.thinking && (
          <details className="monologue">
            <summary>internal monologue</summary>
            <div className="monologue-body">{msg.thinking}</div>
          </details>
        )}

        {msg.tools.length > 0 && (
          <div className="chips">
            {tally(msg.tools).map((g) => (
              <Chip key={g.key} g={g} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
});
