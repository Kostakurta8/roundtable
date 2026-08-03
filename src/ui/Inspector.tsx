/**
 * The inspector: everything known about one agent, pinned over the room next to it.
 *
 * It opens by clicking a person in the office or a row in the rail, which is what makes the room
 * navigable rather than merely pretty — a face at a desk becomes a name, a model, a bill, and the
 * last thing it said.
 */
import { memo } from 'react';
import { modelInfo } from '../../shared/models';
import { agentLook, type RtMsg, type RtState } from '../store';
import { clip, clockSec, duration, money, oneLine, shortPath, tokens } from './format';
import { MiniHead } from './MiniHead';

const LAST_TOOLS = 5;
const EXCERPT = 180;

export type InspectorProps = {
  state: RtState;
  agentId: string;
  now: number;
  onClose: () => void;
};

export const Inspector = memo(function Inspector({ state, agentId, now, onClose }: InspectorProps) {
  const a = state.agents[agentId];
  if (!a) return null;

  const model = a.model ? modelInfo(a.model).short : undefined;
  const parent = a.parentId ? state.agents[a.parentId] : undefined;
  const alive = a.lastTs > a.firstTs ? a.lastTs - a.firstTs : 0;
  const recent = state.tools.filter((t) => t.agentId === agentId).slice(-LAST_TOOLS).reverse();
  const last: RtMsg | undefined = [...state.msgs].reverse().find((m) => m.agentId === agentId);

  return (
    <aside className="inspector panel" aria-label={`details for ${a.label ?? a.id}`}>
      <button type="button" className="btn icon close" onClick={onClose} aria-label="close">
        ✕
      </button>

      <h3>
        <MiniHead agentId={a.id} /> <span style={{ color: agentLook(a.id).color }}>{a.label ?? a.id}</span>
      </h3>
      <div className="sub">
        {model ?? 'model unknown'}
        {a.agentType ? ` · ${a.agentType}` : ''}
        {a.workflowId ? ` · ${a.workflowId}` : ''}
      </div>

      <dl className="kv">
        <dt>PHASE</dt>
        <dd>
          {a.phase}
          {a.status ? ` · ${clip(a.status, 26)}` : ''}
        </dd>
        <dt>ID</dt>
        <dd title={a.id}>{a.id}</dd>
        {parent && (
          <>
            <dt>PARENT</dt>
            <dd title={parent.id}>{parent.label ?? parent.id}</dd>
          </>
        )}
        <dt>TOKENS</dt>
        <dd>{tokens(a.tokens)}</dd>
        <dt>IN / OUT</dt>
        <dd>
          {tokens(a.use.in)} / {tokens(a.use.out)}
        </dd>
        <dt>CACHE</dt>
        <dd>
          {tokens(a.use.cacheRead)} r · {tokens(a.use.cacheWrite)} w
        </dd>
        <dt>EST</dt>
        <dd>{money(a.cost)}</dd>
        <dt>TURNS</dt>
        <dd>{a.says}</dd>
        <dt>ACTIVE</dt>
        <dd>{alive > 0 ? duration(alive) : '—'}</dd>
        <dt>LAST SEEN</dt>
        <dd>{a.lastTs > 0 ? `${duration(Math.max(0, now - a.lastTs))} ago` : '—'}</dd>
      </dl>

      {recent.length > 0 && (
        <>
          <div className="section-hd">RECENT TOOLS</div>
          {recent.map((t) => (
            <div className={t.ok === false ? 'trow failed' : 'trow'} key={t.id}>
              <span className={`phase ${t.ok === undefined ? 'working' : 'idle'}`} aria-hidden="true" />
              <span className="tool">{t.tool}</span>
              <bdi className="target">{t.target ? shortPath(t.target) : ''}</bdi>
              <span className="ms">{t.ms === undefined ? clockSec(t.ts) : duration(t.ms)}</span>
            </div>
          ))}
        </>
      )}

      {last && (
        <>
          <div className="section-hd">LAST MESSAGE</div>
          <div style={{ color: 'var(--ink-2)', fontSize: 10, lineHeight: 1.6 }}>
            {clip(oneLine(last.text), EXCERPT)}
          </div>
        </>
      )}
    </aside>
  );
});
