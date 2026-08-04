/**
 * The roster rail: every agent in the room, as a tree, floating over the office's bottom corner.
 *
 * It is a control as well as a legend — picking a row selects that agent everywhere, which is how
 * a busy room stays navigable once there are more people in it than you can tell apart by shirt.
 */
import { memo } from 'react';
import { agentLook, MAIN, type RtAgent } from '../store';
import { modelInfo } from '../../shared/models';
import { clip, tokens } from './format';
import { MiniHead } from './MiniHead';
import { peakTokens, type RosterRow } from './roster';

const NAME_MAX = 22;
const STATUS_MAX = 18;

function Row({
  row,
  peak,
  selected,
  onSelect,
}: {
  row: RosterRow;
  peak: number;
  selected: boolean;
  onSelect: (id: string | null) => void;
}) {
  const a: RtAgent = row.agent;
  const name = a.label ?? a.id;
  const model = a.model ? modelInfo(a.model).short : undefined;
  const sub = a.status ? clip(a.status, STATUS_MAX) : (model ?? a.agentType ?? '');

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
        <b style={{ color: agentLook(a.id).color }}>{clip(name, NAME_MAX)}</b>
        <span className="sub">{sub}</span>
      </span>
      <span className="right">
        <span className="tokbar" aria-hidden="true">
          <i style={{ width: `${peak > 0 ? Math.round((a.tokens / peak) * 100) : 0}%` }} />
        </span>
        <span className={`phase ${a.phase}`} title={a.phase} />
      </span>
    </button>
  );
}

export type RailProps = {
  rows: RosterRow[];
  selected: string | null;
  onSelect: (id: string | null) => void;
};

export const Rail = memo(function Rail({ rows, selected, onSelect }: RailProps) {
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
      <div className="rail-hd">
        AGENTS
        <span className="spacer" />
        <span>{anyDone ? `${working} working · ${rows.length}` : rows.length}</span>
      </div>
      <div className="rail-list">
        {rows.map((row) => (
          <Row
            key={row.agent.id}
            row={row}
            peak={peak}
            selected={selected === row.agent.id}
            onSelect={onSelect}
          />
        ))}
      </div>
    </aside>
  );
});
