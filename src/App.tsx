/**
 * The observer shell: the room on the left, a dockable panel on the right, the session bar above
 * and the activity strip below.
 *
 * This is where the two halves of the client meet. `useRtStream` owns the socket and folds the
 * event stream into `RtState` for the panels; `useOffice` hands that same hook a sink so the
 * simulation sees every event as it lands. One socket, two consumers, no second connection.
 *
 * Selection is the shell's own state rather than either half's, because it crosses both: picking
 * a person in the room filters the feed, and picking a row in the roster highlights the person.
 */
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Chat } from './chat/Chat';
import { useKeys, useNow } from './hooks';
import { PixelOffice, useOffice } from './office/PixelOffice';
import { initialState, roster as rosterOf, workingAgents } from './store';
import { useTheme } from './theme';
import { AgentsTab } from './ui/AgentsTab';
import { clip, clockSec, shortId } from './ui/format';
import { Inspector } from './ui/Inspector';
import { Palette, type Command } from './ui/Palette';
import { Rail } from './ui/Rail';
import { rosterTree } from './ui/roster';
import { Timeline } from './ui/Timeline';
import { TopBar } from './ui/TopBar';
import { ToolsTab } from './ui/ToolsTab';
import { useRtStream, WS_URL, type RtSession } from './ws';

const TITLE_MAX = 110;
/** The whiteboard is 220px of monospace: three lines fit, and the CSS clamps what does not. */
const BOARD_MAX = 150;

type TabKey = 'chat' | 'agents' | 'tools';
const TABS: readonly { key: TabKey; label: string }[] = [
  { key: 'chat', label: 'CHAT' },
  { key: 'agents', label: 'AGENTS' },
  { key: 'tools', label: 'TOOLS' },
];

/**
 * The office re-renders every frame an actor moves. The panels' props do not change on those
 * frames, so skipping them keeps a walk across the room from re-diffing the whole feed.
 */
const FeedPanel = memo(Chat);

/**
 * What the dock says when there is nothing to follow.
 *
 * An observer with no sessions used to make three claims at once, all of them on screen together:
 * the top bar's pill said LIVE, the feed's header said "no session followed", and the feed's body
 * said "waiting for the session to say something". Two of those were about a session that did not
 * exist, and the third — the one that was true — was drowned by them.
 *
 * The pill is kept exactly as it was, because it is honest: it reports the *socket*, and the
 * socket is connected. What changes is that the feed is no longer rendered as a feed of nothing.
 * "Connected and watching something quiet" is a real state and `Chat` describes it correctly;
 * "connected with nothing to watch" is a different state, it belongs to the shell rather than to
 * any session's feed, and this is the one sentence it gets to say.
 */
function Nothing({ connected, sessions }: { connected: boolean; sessions: number }) {
  const [head, body] = !connected
    ? ['Not connected to the observer hub', `Retrying ${WS_URL}. Nothing can be observed until it answers.`]
    : sessions === 0
      ? [
          'Nothing to observe yet',
          'The observer is connected and watching this machine. No Claude Code session has run here — the first one to start shows up in this panel.',
        ]
      : [
          'Pick a session to observe',
          `${sessions} session${sessions === 1 ? '' : 's'} on this machine, and none of them is being followed. Choose one from the picker in the top bar.`,
        ];

  return (
    <div className="nothing" role="status">
      <b>{head}</b>
      <p>{body}</p>
    </div>
  );
}

/**
 * How much of the stage's left edge the roster rail covers — measured, never asserted.
 *
 * `--rail-w` is 244px until `index.css` drops it to 210 at ≤1180px, and the rail is `display: none`
 * altogether at ≤900px. A constant here was wrong at both of those widths, and wrong in the
 * direction that hurts: the room was fitted around a rail that was not on screen. An observer on
 * the element itself is right at every breakpoint, including the one where it has no box at all.
 *
 * The gutter to the right of the rail is not a second constant either — it mirrors the rail's own
 * offset from the stage's left edge, so the room is balanced against whatever the stylesheet gives
 * it rather than against a number that exists only in this file.
 */
function useRailInset(stage: React.RefObject<HTMLElement>, present: boolean): number {
  const [inset, setInset] = useState(0);

  useLayoutEffect(() => {
    const host = stage.current;
    const rail = present ? host?.querySelector('.rail') : null;
    if (!host || !rail) {
      setInset(0);
      return;
    }

    const measure = (): void => {
      const r = rail.getBoundingClientRect();
      const h = host.getBoundingClientRect();
      // A `display: none` element has no box, so every edge reads 0 — which is exactly the answer
      // the room needs: no rail, no inset.
      const next = r.width === 0 ? 0 : Math.max(0, Math.round(r.right - h.left + (r.left - h.left)));
      setInset((prev) => (prev === next ? prev : next));
    };

    measure();
    // jsdom has no ResizeObserver. A DOM test of the shell should get the first measurement rather
    // than a crash on a constructor that is not there.
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(rail);
    // The rail's own box covers the token change at ≤1180px; the stage covers the case a browser
    // may not report — an element being hidden is a box that stopped existing, not one that resized
    // — and both breakpoints resize the stage on the way past.
    ro.observe(host);
    return () => ro.disconnect();
  }, [stage, present]);

  return inset;
}

export default function App() {
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [tab, setTab] = useState<TabKey>('chat');
  const [dockOpen, setDockOpen] = useState(true);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [seekTs, setSeekTs] = useState<number | null>(null);
  /** The roundtable's filter: only what the agents said to each other. */
  const [crossTalk, setCrossTalk] = useState(false);

  const theme = useTheme();
  const now = useNow(5000);
  const office = useOffice();
  const { feed } = office;
  const { states, sessions, dropped, replaying, notices, connected, rescan } = useRtStream(sessionId, feed);

  /**
   * The session on screen. One selection drives everything: the picker sets it, a tab sets it, and
   * the hub is told about it so a session that stops running is still kept for as long as it is
   * the one being looked at.
   *
   * Switching it no longer resets anything. The hub streams every running session, the store keeps
   * one `RtState` per session and the office keeps one room per session, so this chooses which of
   * them is drawn — nothing is discarded, and switching back is free.
   */
  const state = states[sessionId ?? ''] ?? initialState;

  /**
   * The sessions that get a tab: the ones with agents working *right now*.
   *
   * Both halves of the test are necessary and neither is sufficient. The roster's `live` flag only
   * says the CLI registered the session and something touched it inside 90 seconds, which is true
   * of a window sitting at an idle prompt; `workingAgents` only sees what the transcripts say,
   * which stays true for a while after the process behind them dies. Together they mean: this
   * session is running, and somebody other than its orchestrator is doing something in it.
   */
  const working = useMemo(
    () => sessions.filter((s) => s.live && workingAgents(states[s.sessionId] ?? initialState, now).length > 0),
    [sessions, states, now],
  );

  /**
   * The tab strip, or nothing at all.
   *
   * Nothing at all is the common case and is the point: with one session working there is nothing
   * to choose between, and a strip of one tab is furniture that says nothing. The session being
   * looked at is always included even if it has gone quiet — a tab you can switch away from and
   * not back to is a trap.
   */
  const tabs = useMemo((): RtSession[] => {
    if (working.length < 2) return [];
    if (!sessionId || working.some((s) => s.sessionId === sessionId)) return working;
    const current = sessions.find((s) => s.sessionId === sessionId);
    return current ? [current, ...working] : working;
  }, [working, sessions, sessionId]);

  // Follow the most recently touched session as soon as the roster lands: the observer exists
  // to show what is happening now, and the hub sorts its roster newest first. A session the
  // user picked themselves is never overridden.
  useEffect(() => {
    if (sessionId === null && sessions.length > 0) setSessionId(sessions[0].sessionId);
  }, [sessionId, sessions]);

  // A selection is about one agent of one session; carrying it across a switch would highlight
  // an id that no longer exists in the room.
  useEffect(() => {
    setSelected(null);
    setSeekTs(null);
  }, [sessionId]);

  const rows = useMemo(() => rosterTree(state), [state]);
  const agentCount = rosterOf(state).length;
  const current = sessions.find((s) => s.sessionId === sessionId);

  const stageRef = useRef<HTMLElement>(null);
  // `Rail` renders nothing without rows, so this is also the question "is there a rail to measure".
  const railInset = useRailInset(stageRef, rows.length > 0);

  const task = state.task;
  /**
   * The line under the feed's header, or `null` when there is no feed to head.
   *
   * `'no session followed'` used to be the last resort here, and it was rendered *as a session's
   * header* — above a body that in the same breath said it was waiting for that session to speak.
   * Nothing is followed and something is being waited for cannot both be true. Now the absence is
   * decided once, in one place, and the panel that answers it is chosen from the same condition.
   */
  const title =
    sessionId === null
      ? null
      : task
        ? `TASK · ${clip(task, TITLE_MAX)}`
        : (current?.cwd ?? current?.slug ?? `session ${shortId(sessionId)}`);
  // The whiteboard is the fourth surface that had an opinion about this. An empty room whose board
  // says "waiting for a task…" is waiting for a session that was never asked to exist.
  const board = task
    ? `TASK: ${clip(task, BOARD_MAX)}`
    : sessionId === null
      ? 'nothing to observe yet'
      : 'waiting for a task…';

  const pickSession = useCallback((id: string) => setSessionId(id), []);
  const select = useCallback((id: string | null) => setSelected(id), []);
  /**
   * The way out of a seek. It lives in the top bar because the top bar is the one surface no
   * shortcut and no viewport can hide — a room frozen in the past with the control on a panel the
   * user just closed reads as a crash, and that is exactly what `B` used to do.
   */
  const resumeLive = useCallback(() => setSeekTs(null), []);

  /** The whiteboard is what the session *is*, so clicking it opens the session's own feed. */
  const openSession = useCallback(() => {
    setTab('chat');
    setDockOpen(true);
    setSelected(null);
    setCrossTalk(false);
  }, []);

  /** The roundtable is where agents answer each other, so clicking it shows only that. */
  const filterCrossTalk = useCallback(() => {
    setTab('chat');
    setDockOpen(true);
    setCrossTalk((on) => !on);
  }, []);

  const commands = useMemo((): Command[] => {
    const base: Command[] = [
      // First, and only while it means something: a user who has lost the room in the past is
      // looking for one thing, and the palette is reachable from anywhere with ⌘K.
      ...(seekTs !== null
        ? [{
            id: 'resume-live',
            label: `Resume live — the room is showing ${clockSec(seekTs)}`,
            hint: 'Esc',
            run: resumeLive,
          }]
        : []),
      { id: 'theme', label: `Theme: ${theme.choice} → next`, hint: 'T', run: theme.cycle },
      { id: 'theme-day', label: 'Theme: day', run: () => theme.set('day') },
      { id: 'theme-night', label: 'Theme: night', run: () => theme.set('night') },
      { id: 'theme-auto', label: 'Theme: follow the system', run: () => theme.set('auto') },
      { id: 'dock', label: dockOpen ? 'Hide the side panel' : 'Show the side panel', hint: 'B', run: () => setDockOpen((v) => !v) },
      ...TABS.map((t) => ({ id: `tab-${t.key}`, label: `Panel: ${t.label.toLowerCase()}`, hint: 'panel', run: () => { setTab(t.key); setDockOpen(true); } })),
      { id: 'clear', label: 'Clear the agent selection', hint: 'Esc', run: () => setSelected(null) },
    ];
    const agents: Command[] = rows.map(({ agent }) => ({
      id: `agent-${agent.id}`,
      label: `Focus ${agent.label ?? agent.id}`,
      hint: 'agent',
      run: () => setSelected(agent.id),
    }));
    const list: Command[] = sessions.slice(0, 25).map((s) => ({
      id: `session-${s.sessionId}`,
      label: `Observe ${s.name ?? s.sessionId.slice(0, 8)}${s.live ? ' (running)' : ''}`,
      hint: s.cwd ?? s.slug,
      run: () => setSessionId(s.sessionId),
    }));
    return [...base, ...agents, ...list];
  }, [theme, dockOpen, rows, sessions, seekTs, resumeLive]);

  useKeys({
    'mod+k': () => setPaletteOpen(true),
    t: theme.cycle,
    b: () => setDockOpen((v) => !v),
    '1': () => { setTab('chat'); setDockOpen(true); },
    '2': () => { setTab('agents'); setDockOpen(true); },
    '3': () => { setTab('tools'); setDockOpen(true); },
    // Newest thing first, so each press undoes the most recent one: the palette is on top of the
    // room, a seek is a state the whole room is held in, and a selection is the quietest of the
    // three. Escape that only ever cleared the selection left the seek with no keyboard exit.
    Escape: () => {
      if (paletteOpen) setPaletteOpen(false);
      else if (seekTs !== null) setSeekTs(null);
      else setSelected(null);
    },
  });

  return (
    <div className={`app${dockOpen ? '' : ' dock-hidden'}`}>
      <TopBar
        sessions={sessions}
        sessionId={sessionId}
        onPick={pickSession}
        connected={connected}
        replaying={sessionId !== null && replaying[sessionId] === true}
        totalTok={state.totalTok}
        cost={state.cost}
        costPartial={state.costPartial}
        agents={agentCount}
        theme={theme}
        dockOpen={dockOpen}
        onToggleDock={() => setDockOpen((v) => !v)}
        onOpenPalette={() => setPaletteOpen(true)}
        seekTs={seekTs}
        onResumeLive={resumeLive}
        onRescan={rescan}
      />

      <main className="stage" ref={stageRef}>
        {/* Over the room rather than in the shell's grid: the strip is not always there, and a
            grid row that collapses to zero height is how the dock ended up invisible at 800×600.
            It floats, it does not take the room's clicks, and when one session is working it does
            not exist at all. */}
        {tabs.length > 0 && (
          <nav className="session-tabs" role="tablist" aria-label="sessions with agents working">
            {tabs.map((s) => {
              const busy = workingAgents(states[s.sessionId] ?? initialState, now).length;
              const on = s.sessionId === sessionId;
              return (
                <button
                  key={s.sessionId}
                  type="button"
                  role="tab"
                  aria-selected={on}
                  className={on ? 'session-tab on' : 'session-tab'}
                  title={s.cwd ?? s.slug}
                  onClick={() => setSessionId(s.sessionId)}
                >
                  {/* The session being watched keeps its tab even after it goes quiet, so the tab
                      is not always a running one and must not always claim to be. */}
                  <span className={s.live ? 'dot live' : 'dot'} />
                  <b>{s.name ?? s.sessionId.slice(0, 8)}</b>
                  {/* The count is the reason the tab is here, so it is the thing on the tab. */}
                  <span className="n" title={`${busy} agent${busy === 1 ? '' : 's'} working`}>
                    {busy}
                  </span>
                </button>
              );
            })}
          </nav>
        )}
        <PixelOffice
          office={office}
          sessionId={sessionId}
          agents={state.agents}
          task={board}
          turns={state.msgs.length}
          selected={selected}
          onSelect={select}
          insetLeft={railInset}
          // The room re-lights itself rather than swapping a stylesheet: the same office after
          // hours, lit by its desk lamps instead of by its windows.
          night={theme.resolved === 'dark' ? 1 : 0}
          cost={state.cost}
          // Clicking the activity strip scrubs the *room*, not only the feed. The office is
          // deterministic by construction, so seeking rebuilds the moment rather than approximating
          // it — which is the difference between an observer and a live toy.
          replayAt={seekTs}
          // The two fixtures that are worth clicking. The whiteboard is what the session *is*, so
          // it opens the session's own feed; the roundtable is where agents talk to each other, so
          // it filters the feed down to exactly that.
          onOpenSession={openSession}
          onFilterCrossTalk={filterCrossTalk}
        />
        <Rail rows={rows} selected={selected} onSelect={select} />
        {selected && state.agents[selected] && (
          <Inspector state={state} agentId={selected} now={now} onClose={() => setSelected(null)} />
        )}
      </main>

      <aside className="dock panel" aria-label="session detail">
        <nav className="tabs" role="tablist">
          {TABS.map((t) => (
            <button
              key={t.key}
              type="button"
              role="tab"
              aria-selected={tab === t.key}
              className={tab === t.key ? 'tab on' : 'tab'}
              onClick={() => setTab(t.key)}
            >
              {t.label}
              <span className="n">
                {t.key === 'chat' ? state.msgs.length : t.key === 'agents' ? rows.length : state.tools.length}
              </span>
            </button>
          ))}
        </nav>

        <div className="dock-body" role="tabpanel">
          {/* A feed of nothing is not a feed. `title === null` is exactly "no session is
              followed", so the same test picks the panel and titles it — there is no arrangement
              of state in which one of them can be answered and the other left saying otherwise. */}
          {tab === 'chat' &&
            (title === null ? (
              <Nothing connected={connected} sessions={sessions.length} />
            ) : (
              <FeedPanel
                // Remounted per session. The search term, the lane chips and the render window are
                // the panel's own state, and carrying them across a switch meant a filter typed for
                // one session silently hid another: the new session's feed rendered completely
                // empty with a stale search term still sitting in the box.
                key={sessionId ?? ''}
                state={state}
                title={title}
                live={connected}
                truncatedDropped={(sessionId && dropped[sessionId]) || 0}
                notice={sessionId ? notices[sessionId] : undefined}
                focusAgent={selected}
                seekTs={seekTs}
                crossTalk={crossTalk}
                onCrossTalk={setCrossTalk}
              />
            ))}
          {tab === 'agents' && <AgentsTab rows={rows} selected={selected} now={now} onSelect={select} />}
          {/* Same reason as the feed: its search text and outcome filters are its own state. */}
          {tab === 'tools' && <ToolsTab key={sessionId ?? ''} state={state} filterAgent={selected} />}
        </div>

        <div className="dock-foot">
          <span>observer · read-only</span>
          {/* "⏵ resume live" used to live here, where `B` and a 620px-tall window could both hide
              it while the room stayed frozen in the past. The top bar owns it now: one home, on the
              one surface that is never hidden. */}
          {selected && (
            <button type="button" className="btn" onClick={() => setSelected(null)}>
              clear focus
            </button>
          )}
        </div>
      </aside>

      <Timeline
        buckets={state.buckets}
        firstTs={state.firstTs}
        lastTs={state.lastTs}
        msgs={state.msgs.length}
        // The strip is what put the room in the past, so it is the surface that marks where the
        // past is — `aria-current` on the column, and a live region that says so out loud.
        seekTs={seekTs}
        onSeek={(ts) => {
          setTab('chat');
          setDockOpen(true);
          setSeekTs(ts);
        }}
      />

      {paletteOpen && <Palette commands={commands} onClose={() => setPaletteOpen(false)} />}
    </div>
  );
}
