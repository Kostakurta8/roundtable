/**
 * The top bar: who we are, which session is on screen, and what it has cost so far.
 *
 * Everything here is a summary of state the panels below show in full — the bar's job is to be
 * readable at a glance from across the desk, so it carries counts and never prose.
 *
 * It is also the app's only surface that no shortcut, panel toggle or viewport can hide, which is
 * why the way out of a timeline seek lives here rather than in the dock's foot.
 *
 * Anything wrapped in `.lbl` is a word the bar can drop when it runs out of room; the glyph, the
 * number or the `title` beside it carries the meaning on its own. See the `.topbar` media queries
 * in `index.css` — every child here is `flex: none`, so the bar cannot wrap and must shed instead.
 */
import { useCallback, useState, type CSSProperties } from 'react';
import type { SessionSummary } from '../../shared/protocol';
import { useDismiss, useNow } from '../hooks';
import type { ThemeApi } from '../theme';
import { ago, clip, clockSec, money, sessionAbout, sessionName, tokens } from './format';

const THEME_LABEL: Record<ThemeApi['choice'], { glyph: string; word: string }> = {
  auto: { glyph: '◐', word: 'auto' },
  day: { glyph: '☀', word: 'day' },
  night: { glyph: '☾', word: 'night' },
};

export type TopBarProps = {
  sessions: SessionSummary[];
  sessionId: string | null;
  onPick: (id: string) => void;
  connected: boolean;
  replaying: boolean;
  totalTok: number;
  cost: number;
  costPartial: boolean;
  agents: number;
  theme: ThemeApi;
  dockOpen: boolean;
  onToggleDock: () => void;
  onOpenPalette: () => void;
  onOpenHelp: () => void;
  /** The instant the room is replaying, or `null` when it is showing now. */
  seekTs: number | null;
  onResumeLive: () => void;
  /** Ask the hub to look for newly started sessions right now, instead of on its own schedule. */
  onRescan: () => void;
};

/**
 * The line that makes a row choosable, when the session has one.
 *
 * Only when it says something the name has not: with no opening prompt yet `sessionAbout` falls
 * back to the working directory's leaf, and this row already prints the whole directory underneath
 * — a line reading `project` above `C:\work\project` is a row that got taller and no clearer.
 */
const ABOUT: CSSProperties = { color: 'var(--ink-2)' };

/** One row of the picker. Live sessions read differently from the historical ones below them. */
function SessionRow({
  s,
  now,
  current,
  onPick,
}: {
  s: SessionSummary;
  now: number;
  current: boolean;
  onPick: (id: string) => void;
}) {
  const name = sessionName(s);
  const about = sessionAbout(s);
  const says = s.label?.trim() ? about : undefined;
  return (
    <li>
      <button type="button" className={current ? 'on' : undefined} onClick={() => onPick(s.sessionId)}>
        <span className={s.live ? 'dot live' : 'dot'} title={s.live ? 'running' : 'not running'} />
        <b>{name}</b>
        <time dateTime={new Date(s.mtime).toISOString()}>{ago(s.mtime, now)}</time>
        {/* What this session was asked to do — the only thing that tells six sessions started in
            one directory apart, and the reason this row is more than a timestamp. It is part of
            the button's text, so it is part of the button's accessible name too. */}
        {says && (
          <span className="cwd" style={ABOUT} title={says}>
            {says}
          </span>
        )}
        <span className="cwd">
          {s.cwd ?? s.slug}
          {s.status ? ` · ${s.status}` : ''}
        </span>
      </button>
    </li>
  );
}

export function TopBar(props: TopBarProps) {
  const { sessions, sessionId, onPick, connected, replaying, theme } = props;
  const [picking, setPicking] = useState(false);
  const close = useCallback(() => setPicking(false), []);
  const menu = useDismiss(picking, close);
  const now = useNow(5000);

  const current = sessions.find((s) => s.sessionId === sessionId);
  const liveCount = sessions.filter((s) => s.live).length;

  /**
   * A brief spin, so pressing it is visibly a thing that happened.
   *
   * The answer usually arrives in a millisecond — the hub reads one directory — and a control that
   * completes faster than the eye can follow reads as a control that is broken. The delay is in
   * the *acknowledgement*, never in the work: the rescan is sent immediately.
   */
  const [rescanning, setRescanning] = useState(false);
  const rescan = useCallback(() => {
    props.onRescan();
    setRescanning(true);
    setTimeout(() => setRescanning(false), 450);
  }, [props]);

  const pick = (id: string): void => {
    onPick(id);
    setPicking(false);
  };

  return (
    <header className="topbar panel">
      <span className="wordmark" title="Roundtable">
        <svg width="13" height="13" viewBox="0 0 14 14" aria-hidden="true">
          <circle cx="7" cy="7" r="5.6" fill="none" stroke="var(--accent-2)" strokeWidth="1.6" />
          <circle cx="7" cy="7" r="2" fill="var(--accent-2)" />
        </svg>
        <span className="lbl">ROUNDTABLE</span>
      </span>

      <span className="sep" />

      <div className="session-menu" ref={menu}>
        <button
          type="button"
          className="session-pick"
          aria-expanded={picking}
          aria-haspopup="listbox"
          onClick={() => setPicking((p) => !p)}
          // The bar has room for the name and the directory; what the session was *asked* to do is
          // the fact that identifies it, so the hover carries it rather than nothing carrying it.
          title={
            current
              ? [sessionName(current), sessionAbout(current), current.cwd ?? current.slug]
                  .filter(Boolean)
                  .join(' · ')
              : 'choose a session to observe'
          }
        >
          {current ? (
            <>
              <span className={current.live ? 'dot live' : 'dot'} />
              <b>{sessionName(current)}</b>
              <span className="slug">{clip(current.cwd ?? current.slug, 28)}</span>
            </>
          ) : (
            <span className="slug">{sessions.length > 0 ? 'pick a session' : 'no sessions'}</span>
          )}
          ▾
        </button>

        {picking && (
          <ul className="session-list" role="listbox">
            {sessions.map((s) => (
              <SessionRow key={s.sessionId} s={s} now={now} current={s.sessionId === sessionId} onPick={pick} />
            ))}
            {sessions.length === 0 && <li className="empty">no sessions on this machine yet</li>}
          </ul>
        )}
      </div>

      {/* What the room is showing, in one place. A seek is the fourth state of that question, not
          a control tucked into a panel: "LIVE" while the office is frozen in the past is a lie,
          and a frozen office with no way back is indistinguishable from a crash. */}
      {props.seekTs !== null ? (
        <>
          <button
            type="button"
            className="pill pill-seek"
            onClick={props.onResumeLive}
            title="the room is showing a past moment — click, or press Esc, to catch up to live"
            // Spelt out, because the narrow bar drops `.lbl` and the accessible name would go with
            // it: the name must not depend on how wide the window happens to be.
            aria-label={`resume live — the room is showing ${clockSec(props.seekTs)}`}
          >
            <span className="lbl">SHOWING</span>
            <b>{clockSec(props.seekTs)}</b>
            <span>· ⏵ RESUME LIVE</span>
          </button>
          {/* The socket's own state still matters while seeking, but only when it is bad news. */}
          {!connected && <span className="pill">OFFLINE</span>}
        </>
      ) : (
        <span className={connected ? 'pill pill-live' : 'pill'}>
          {connected && <span className="live-dot" />}
          {connected ? (replaying ? 'LOADING' : 'LIVE') : 'OFFLINE'}
        </span>
      )}

      <span className="spacer" />

      <span className="stat" title="every token this session has billed, cache included">
        <span className="k">TOK</span>
        <b>{tokens(props.totalTok)}</b>
      </span>
      <span
        className="stat"
        title={
          props.costPartial
            ? 'estimated from published list prices — at least one model has no rate card, so this is a floor'
            : 'estimated from published list prices'
        }
      >
        <span className="k">EST</span>
        <b>
          {props.costPartial ? '≥' : ''}
          {money(props.cost)}
        </b>
      </span>
      <span className="stat" title="agents seen in this session">
        <span className="k">AGENTS</span>
        <b>{props.agents}</b>
      </span>
      {liveCount > 1 && (
        <span className="pill pill-warn" title={`${liveCount} sessions are running on this machine`}>
          {liveCount} RUNNING
        </span>
      )}

      <span className="sep" />

      {/* The hub finds new sessions by itself every few seconds; this only asks it to look now.
          It says so in the tooltip rather than pretending to be a repair, and it reports back —
          a button that does something invisible is indistinguishable from one that does nothing. */}
      <button
        type="button"
        className={rescanning ? 'btn icon on' : 'btn icon'}
        onClick={rescan}
        title="look for newly started sessions now (they are picked up automatically anyway)"
        aria-label="look for newly started sessions now"
      >
        {rescanning ? '⟳' : '⟲'}
      </button>
      <button type="button" className="btn icon" onClick={props.onOpenPalette} title="commands (Ctrl+K)">
        ⌘K
      </button>
      {/* The metaphor's decoder ring. It sits with the other meta controls rather than in the room
          because it is about the whole app — and the person who needs it most is the one who does
          not yet know the room can be asked anything. */}
      <button
        type="button"
        className="btn icon"
        onClick={props.onOpenHelp}
        title="what am I looking at? (?)"
        aria-label="what am I looking at"
      >
        ?
      </button>
      <button
        type="button"
        className="btn icon"
        onClick={theme.cycle}
        title={`theme: ${THEME_LABEL[theme.choice].word} (T)`}
        aria-label={`theme: ${THEME_LABEL[theme.choice].word}`}
      >
        {THEME_LABEL[theme.choice].glyph}
        <span className="lbl">{THEME_LABEL[theme.choice].word}</span>
      </button>
      <button
        type="button"
        className={props.dockOpen ? 'btn icon on' : 'btn icon'}
        onClick={props.onToggleDock}
        title="side panel (B)"
        aria-pressed={props.dockOpen}
      >
        ▤
      </button>
    </header>
  );
}
