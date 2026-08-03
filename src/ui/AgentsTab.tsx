/**
 * The agents tab: one card per agent, in spawn-tree order, with the numbers the rail has no room
 * for — model, type, spend, tool count, failures, and how long it has been in the room.
 */
import { memo } from 'react';
import { modelInfo } from '../../shared/models';
import { agentLook, type RtAgent } from '../store';
import { duration, money, tokens } from './format';
import { MiniHead } from './MiniHead';
import { peakTokens, type RosterRow } from './roster';

function Card({
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
  const model = a.model ? modelInfo(a.model).short : undefined;
  const alive = a.lastTs > a.firstTs ? a.lastTs - a.firstTs : 0;
  const share = peak > 0 ? Math.round((a.tokens / peak) * 100) : 0;
  const toolTotal = Object.values(a.toolCounts).reduce((n, v) => n + v, 0);

  return (
    <div
      className={selected ? 'acard on' : 'acard'}
      style={{ marginLeft: Math.min(row.depth, 3) * 10 }}
      onClick={() => onSelect(selected ? null : a.id)}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onSelect(selected ? null : a.id);
        }
      }}
    >
      <div className="acard-head">
        <MiniHead agentId={a.id} />
        <b style={{ color: agentLook(a.id).color }}>{a.label ?? a.id}</b>
        <span className="right">
          <span className={`phase ${a.phase}`} title={a.phase} />
          {a.phase}
        </span>
      </div>

      <dl className="kv">
        {model && (
          <>
            <dt>MODEL</dt>
            <dd title={a.model}>{model}</dd>
          </>
        )}
        {a.agentType && (
          <>
            <dt>TYPE</dt>
            <dd>
              {a.agentType}
              {a.workflowId ? ` · ${a.workflowId}` : ''}
            </dd>
          </>
        )}
        <dt>ID</dt>
        <dd title={a.id}>{a.id}</dd>
        <dt>TOKENS</dt>
        <dd>
          {tokens(a.tokens)} · {money(a.cost)}
        </dd>
        <dt>CACHE</dt>
        <dd>
          {tokens(a.use.cacheRead)} read · {tokens(a.use.cacheWrite)} written
        </dd>
        <dt>TOOLS</dt>
        <dd>
          {toolTotal}
          {a.errors > 0 ? ` · ${a.errors} failed` : ''}
          {a.activeTools > 0 ? ` · ${a.activeTools} running` : ''}
        </dd>
        <dt>TURNS</dt>
        <dd>{a.says}</dd>
        <dt>ACTIVE</dt>
        <dd title={new Date(a.firstTs).toLocaleString()}>
          {alive > 0 ? duration(alive) : '—'}
          {a.phase !== 'done' && now - a.lastTs > 60_000 ? ` · quiet ${duration(now - a.lastTs)}` : ''}
        </dd>
      </dl>

      <div className="bar" style={{ marginTop: 6 }}>
        <span className="name">spend</span>
        <span className="track">
          <i style={{ width: `${share}%` }} />
        </span>
        <span className="val">{share}%</span>
      </div>
    </div>
  );
}

export type AgentsTabProps = {
  rows: RosterRow[];
  selected: string | null;
  now: number;
  onSelect: (id: string | null) => void;
};

export const AgentsTab = memo(function AgentsTab({ rows, selected, now, onSelect }: AgentsTabProps) {
  if (rows.length === 0) {
    return <div className="empty-note">no agents have appeared in this session yet</div>;
  }
  const peak = peakTokens(rows);
  return (
    <div className="scroller">
      {rows.map((row) => (
        <Card
          key={row.agent.id}
          row={row}
          peak={peak}
          now={now}
          selected={selected === row.agent.id}
          onSelect={onSelect}
        />
      ))}
    </div>
  );
});
