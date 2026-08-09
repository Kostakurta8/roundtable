/**
 * The tools tab: what the room is actually doing, as a live stream plus a histogram.
 *
 * The office shows that an agent is busy and the feed shows what it said afterwards; neither
 * shows the work itself. This does — every call in order, how long it took, and which ones came
 * back an error, which is usually the first place a stuck session explains itself.
 *
 * A red row used to be the end of the trail: the panel counted failures and coloured them, and a
 * person looking at one had no way to find out what went wrong. Every row now opens, and what a
 * failed one opens onto is the tool's own words.
 */
import { memo, useMemo, useState, type CSSProperties } from 'react';
import type { RtState, RtTool } from '../store';
import { agentLook } from '../store';
import { clockSec, duration, editLines, shortPath } from './format';
import { toolHistogram } from './roster';

/** Newest first: a live stream is read from the top. */
const RECENT = 120;

/** How a call ended, as the filter chips name it. */
type Outcome = 'ok' | 'failed' | 'running';

const OUTCOMES: readonly { key: Outcome; label: string }[] = [
  { key: 'ok', label: 'ok' },
  { key: 'failed', label: 'failed' },
  { key: 'running', label: 'running' },
];

const outcomeOf = (t: RtTool): Outcome => (t.ok === undefined ? 'running' : t.ok ? 'ok' : 'failed');

/** `https://…`, `file://…` — a separator, but not a path, and its head is the informative part. */
const URLISH = /^[a-z][a-z0-9+.-]*:\/\//i;

/**
 * A target worth shortening to its last two segments and truncating from its head.
 *
 * `shortPath` is exactly right for `src/office/mapping.ts` and exactly wrong for `cd /tmp && ls`
 * — it would print `tmp && ls` and call it the command. It was applied to every target
 * indiscriminately, which mattered little while a target was almost always a file; now that one
 * can be a web query, a task title or a page-evaluate function, the distinction earns its keep.
 *
 * A bare "has a separator and no spaces" test is not enough in either direction: plenty of real
 * paths contain a space (`D:\AI Projects\…`), and half the shell commands contain a slash.
 * So an absolute path is recognized by how it starts, and a relative one by having no whitespace
 * at all.
 */
const isPathish = (s: string): boolean =>
  !URLISH.test(s) && (/^[A-Za-z]:[\\/]/.test(s) || /^\.{0,2}[\\/]/.test(s) || (/[\\/]/.test(s) && !/\s/.test(s)));

/**
 * Everything about one call that a person might type into the search box.
 *
 * The error text is in here on purpose: `ENOENT` or `command not found` is how somebody looks for
 * the failure they half-remember, and it is the only field that is the tool's own voice.
 */
const haystack = (t: RtTool, name: string): string =>
  `${t.tool} ${t.target ?? ''} ${name} ${t.error ?? ''}`.toLowerCase();

/**
 * A `.trow` is a grid, and a `<button>` is not block-level — without these two it would shrink to
 * its content and the `minmax(0, 1fr)` target column would collapse. Inline rather than in
 * `index.css` because this is the one element that needs it; nothing else styles a grid button.
 */
const ROW: CSSProperties = { width: '100%', textAlign: 'left' };

function Row({
  t,
  name,
  open,
  onToggle,
}: {
  t: RtTool;
  name: string;
  open: boolean;
  onToggle: () => void;
}) {
  const outcome = outcomeOf(t);
  const cls = outcome === 'failed' ? 'trow failed' : outcome === 'running' ? 'trow running' : 'trow';
  const pathish = t.target !== undefined && isPathish(t.target);
  // Beside the path, because that is the question it answers. Absent for every call that changed
  // no file, and absent — not `+0` — for an edit whose input could not be counted.
  const lines = editLines(t.added, t.removed);
  return (
    <div>
      <button
        type="button"
        className={cls}
        style={ROW}
        title={`${name} · ${t.label}${lines ? ` · ${lines} lines` : ''}`}
        aria-expanded={open}
        onClick={onToggle}
      >
        <span className={`phase ${t.ok === undefined ? 'working' : 'idle'}`} aria-hidden="true" />
        <span className="tool" style={{ color: t.ok === false ? undefined : agentLook(t.agentId).color }}>
          {t.tool}
        </span>
        {/* `bdi` keeps the RTL trick that truncates a path from its head from reordering the text.
            A target that is not a path is read from the left, so it opts back out of that trick. */}
        <bdi className="target" style={pathish ? undefined : { direction: 'ltr' }}>
          {t.target ? (pathish ? shortPath(t.target) : t.target) : ''}
        </bdi>
        {lines && <span className="edits">{lines}</span>}
        <span className="ms">{t.ms === undefined ? clockSec(t.ts) : duration(t.ms)}</span>
      </button>
      {open && (
        <div className="monologue-body">
          <div>
            {name} · {outcome}
            {lines ? ` · ${lines} lines` : ''}
            {t.ms === undefined ? '' : ` · ${duration(t.ms)}`} · {clockSec(t.ts)}
          </div>
          {/* The whole target, not the row's shortened one — the row had sixty pixels, this does not. */}
          {t.target && <div>{t.target}</div>}
          {t.error && <div>{t.error}</div>}
          {t.ok === false && !t.error && <div>the transcript recorded no text for this failure</div>}
        </div>
      )}
    </div>
  );
}

export const ToolsTab = memo(function ToolsTab({
  state,
  filterAgent,
}: {
  state: RtState;
  filterAgent: string | null;
}) {
  const [q, setQ] = useState('');
  const [outcomes, setOutcomes] = useState<ReadonlySet<Outcome>>(new Set<Outcome>(['ok', 'failed', 'running']));
  /**
   * One row open at a time.
   *
   * A tool call's detail is several lines of pre-wrapped error text, and a panel that let every
   * row hold one open would push the stream itself off the screen — which is the thing the reader
   * came here to scan. Keyed by the call's own id, so the open row stays open as new calls arrive
   * above it.
   */
  const [openId, setOpenId] = useState<string | null>(null);

  const nameOf = (t: RtTool): string => state.agents[t.agentId]?.label ?? t.agentId;

  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    // Filtered first, sliced second: searching a window of the last 120 would hide older matches
    // that are still in the store, and the search box would silently lie about what it had found.
    const hits = state.tools.filter((t) => {
      if (filterAgent && t.agentId !== filterAgent) return false;
      if (!outcomes.has(outcomeOf(t))) return false;
      if (needle && !haystack(t, state.agents[t.agentId]?.label ?? t.agentId).includes(needle)) return false;
      return true;
    });
    return hits.slice(Math.max(0, hits.length - RECENT)).reverse();
  }, [state.tools, state.agents, filterAgent, outcomes, q]);

  const hist = useMemo(() => toolHistogram(state), [state]);
  const peak = hist[0]?.n ?? 0;
  const running = state.tools.filter((t) => t.ok === undefined).length;
  const failed = state.tools.filter((t) => t.ok === false).length;
  /** True when nothing is being hidden, so "0 shown" can be told apart from "nothing here yet". */
  const unfiltered = q.trim() === '' && outcomes.size === OUTCOMES.length;

  const toggleOutcome = (key: Outcome): void =>
    setOutcomes((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  return (
    <>
      <div className="tab-tools">
        <input
          className="search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="search tools, targets, errors…"
          aria-label="search tool calls"
        />
        {OUTCOMES.map(({ key, label }) => (
          <button
            key={key}
            type="button"
            className={outcomes.has(key) ? 'filter-chip on' : 'filter-chip'}
            aria-pressed={outcomes.has(key)}
            onClick={() => toggleOutcome(key)}
          >
            {label}
          </button>
        ))}
      </div>

      <div className="scroller">
        <div className="section-hd">
          LIVE · {rows.length} SHOWN
          {running > 0 ? ` · ${running} RUNNING` : ''}
          {failed > 0 ? ` · ${failed} FAILED` : ''}
        </div>
        {rows.length === 0 && (
          <div className="empty-note">
            {state.tools.length === 0 ? 'no tool calls yet' : unfiltered ? 'no tool calls yet' : 'nothing matches'}
          </div>
        )}
        {rows.map((t) => (
          <Row
            key={t.id}
            t={t}
            name={nameOf(t)}
            open={openId === t.id}
            onToggle={() => setOpenId((prev) => (prev === t.id ? null : t.id))}
          />
        ))}

        {hist.length > 0 && (
          <>
            <div className="section-hd">BY TOOL · WHOLE SESSION</div>
            {hist.map(({ tool, n }) => (
              <div className="bar" key={tool}>
                <span className="name">{tool}</span>
                <span className="track">
                  <i style={{ width: `${peak > 0 ? Math.round((n / peak) * 100) : 0}%` }} />
                </span>
                <span className="val">{n}</span>
              </div>
            ))}
          </>
        )}
      </div>
    </>
  );
});
