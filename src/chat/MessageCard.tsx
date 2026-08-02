/** One line of the feed: a human turn, an agent's card, or a system note. */
import { agentLook, SYSTEM, USER, type RtAgent, type RtMsg } from '../store';

/** The 15px avatar — skin, hair and a sliver of torso, in the agent's own tints. */
export function MiniHead({ agentId }: { agentId: string }) {
  const look = agentLook(agentId);
  return (
    <span className="mini" aria-hidden="true">
      <span className="mh" style={{ background: look.skin }} />
      <span className="mha" style={{ background: look.hair }} />
      <span className="mc" style={{ background: look.tint }} />
    </span>
  );
}

const NAME_MAX = 14;

const clock = (ts: number): string =>
  new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

/** Blank lines are paragraph breaks. Everything else is rendered verbatim, as text — never HTML. */
const paragraphs = (text: string): string[] => {
  const parts = text.split(/\n{2,}/).filter((p) => p.trim().length > 0);
  return parts.length > 0 ? parts : [text];
};

/**
 * The mockup counts repeats instead of listing them — "Grep ×4", not four Grep chips. It matters
 * on real data: tools called without a file or pattern (Bash, TodoWrite…) all label as the bare
 * tool name, so a busy turn would otherwise read "Bash Bash Bash Bash".
 *
 * Only *consecutive* repeats collapse, because only those actually happened consecutively.
 * Grouping every occurrence of a label would move later calls back to the first one's position
 * and quietly rewrite the order of the turn: `Bash, Read x, Bash` is three things that happened,
 * not two. Purely a display tally — the store keeps every call, in order, for anything that
 * needs them individually.
 */
export const tally = (chips: readonly string[]): string[] => {
  const out: string[] = [];
  for (let i = 0; i < chips.length; ) {
    let n = 1;
    while (i + n < chips.length && chips[i + n] === chips[i]) n += 1;
    out.push(n > 1 ? `${chips[i]} ×${n}` : chips[i]);
    i += n;
  }
  return out;
};

const displayName = (msg: RtMsg, agent?: RtAgent): string => {
  const name = agent?.label ?? msg.agentId;
  return name.length > NAME_MAX ? `${name.slice(0, NAME_MAX - 1)}…` : name;
};

export function MessageCard({ msg, agent }: { msg: RtMsg; agent?: RtAgent }) {
  if (msg.agentId === SYSTEM) return <div className="msg-sys">— {msg.text} —</div>;

  const isUser = msg.agentId === USER;
  const who = isUser ? 'you' : displayName(msg, agent);
  const color = isUser ? 'var(--ink-soft)' : agentLook(msg.agentId).color;

  return (
    <div className={isUser ? 'msg msg-user' : 'msg'}>
      {!isUser && <MiniHead agentId={msg.agentId} />}
      <div className={`msg-card${msg.verdict ? ` verdict-${msg.verdict}` : ''}`}>
        <div className="msg-head">
          <span className="who" style={{ color }} title={agent?.model ?? msg.agentId}>
            {who}
          </span>
          <time dateTime={new Date(msg.ts).toISOString()}>{clock(msg.ts)}</time>
        </div>

        {/* The verdict is stated as well as drawn: a colour alone is not a claim anyone can read. */}
        {msg.verdict && (
          <div className="chips chips-verdict">
            <span className={msg.verdict === 'ok' ? 'chip chip--ok' : 'chip chip--refuted'}>
              {msg.verdict === 'ok' ? '✓ CONFIRMED' : '✕ REFUTED'}
            </span>
          </div>
        )}

        <div className="msg-body">
          {paragraphs(msg.text).map((p, i) => (
            <p key={i}>{p}</p>
          ))}
        </div>

        {msg.thinking && (
          <details className="monologue">
            <summary>internal monologue</summary>
            <div className="monologue-body">{msg.thinking}</div>
          </details>
        )}

        {msg.chips.length > 0 && (
          <div className="chips">
            {/* A label can legitimately appear twice now (one run, then another), so the key
                has to carry the position — the label alone would collide. */}
            {tally(msg.chips).map((c, i) => (
              <span className="chip" key={`${i}-${c}`}>
                {c}
              </span>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
