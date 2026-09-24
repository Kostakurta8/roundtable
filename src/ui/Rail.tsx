/**
 * The roster: every agent in the room, as a tree — a column beside the office, or a strip under it,
 * whichever the stage's shape can afford (`useRoomLayout` in `App.tsx` decides; this is the same
 * markup either way, and the stylesheet lays it out).
 *
 * It is a control as well as a legend — picking a row selects that agent everywhere, which is how
 * a busy room stays navigable once there are more people in it than you can tell apart by shirt.
 */
import { memo } from 'react';
import { displayPhase, MAIN, type RtAgent } from '../store';
import { modelInfo } from '../../shared/models';
import { clip, tokens } from './format';
import { agentInk, MiniHead } from './MiniHead';
import { peakTokens, type RosterRow } from './roster';

const NAME_MAX = 22;
const STATUS_MAX = 18;

function Row({
  row,
  peak,
  selected,
  now,
  onSelect,
}: {
  row: RosterRow;
  peak: number;
  selected: boolean;
  now: number;
  onSelect: (id: string | null) => void;
}) {
  const a: RtAgent = row.agent;
  const name = a.label ?? a.id;
  const model = a.model ? modelInfo(a.model).short : undefined;
  // What may be claimed about this agent *now* — a `thinking…` from before lunch is not it.
  const { phase, status } = displayPhase(a, now);
  const sub = status ? clip(status, STATUS_MAX) : (model ?? a.agentType ?? '');

  return (
    <button
      type="button"
      // `done` rows step back visually: in a fanned-out session nearly everyone is finished, and
      // the rail's job at a glance is to point at whoever is still working.
      className={`arow${a.phase === 'done' ? ' done' : ''}${selected ? ' on' : ''}`}
      data-depth={Math.min(row.depth, 3)}
      aria-pressed={selected}
      title={`${name}${model ? ` · ${model}` : ''}\n${tokens(a.tokens)} tokens`}
      onClick={() => onSelect(selected ? null : a.id)}
    >
      <MiniHead agentId={a.id} />
      <span className="who">
        <b className="agent-ink" style={agentInk(a.id)}>
          {clip(name, NAME_MAX)}
        </b>
        <span className="sub">{sub}</span>
      </span>
      <span className="right">
        <span className="tokbar" aria-hidden="true">
          <i style={{ width: `${peak > 0 ? Math.round((a.tokens / peak) * 100) : 0}%` }} />
        </span>
        <span className={`phase ${phase}`} title={phase} />
      </span>
    </button>
  );
}

export type RailProps = {
  rows: RosterRow[];
  selected: string | null;
  /** The shell's coarse clock, so a phase can expire without an event to expire it. */
  now: number;
  onSelect: (id: string | null) => void;
};

export const Rail = memo(function Rail({ rows, selected, now, onSelect }: RailProps) {
  if (rows.length === 0) return null;
  const peak = peakTokens(rows);
  // "Workers not yet finished", not "busy this second" — the header answers how much of the
  // roster is still in play, which in a 67-agent session is the number the eye is looking for.
  // `main` is the session, not a worker, and it never receives `agentDone`: counted, it held the
  // figure at "1 active" for ever, which on a finished session is a claim about nobody.
  const working = rows.reduce((n, r) => n + (r.agent.phase === 'done' || r.agent.id === MAIN ? 0 : 1), 0);
  const anyDone = rows.some((r) => r.agent.phase === 'done');

  return (
    <aside className="rail panel" aria-label="agents">
      {/* Three parts rather than one string so the strip under the room can stack them as a label
          column — AGENTS, the count, how many are still working — while the column beside it keeps
          them on one line. */}
      <div className="rail-hd">
        <span className="rail-k">AGENTS</span>
        <span className="spacer" />
        {anyDone && <span className="rail-sub">{working} working</span>}
        <b className="rail-n">{rows.length}</b>
      </div>
      <div
        className="rail-list"
        // Laid out as a strip under the room the list scrolls sideways and shows no scrollbar (it
        // would cost the strip a row), so an ordinary wheel has to be able to move it. The column
        // layout scrolls vertically, where the wheel already works and this never engages.
        onWheel={(e) => {
          const el = e.currentTarget;
          if (el.scrollWidth <= el.clientWidth || Math.abs(e.deltaX) >= Math.abs(e.deltaY)) return;
          el.scrollLeft += e.deltaY;
        }}
      >
        {rows.map((row) => (
          <Row
            key={row.agent.id}
            row={row}
            peak={peak}
            selected={selected === row.agent.id}
            now={now}
            onSelect={onSelect}
          />
        ))}
      </div>
    </aside>
  );
});
