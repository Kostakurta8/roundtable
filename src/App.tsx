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
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { Chat } from './chat/Chat';
import { useKeys, useNow } from './hooks';
import { PixelOffice, useOffice } from './office/PixelOffice';
import { initialState, roster as rosterOf, turnCount, workingAgents } from './store';
import { useTheme } from './theme';
import { AgentsTab } from './ui/AgentsTab';
import { clashingNames, clip, clockSec, hasChosenName, sessionAbout, sessionName, shortId } from './ui/format';
import { Help } from './ui/Help';
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
/**
 * How much of a session's opening prompt a tab may carry. A tab is a glance, not a paragraph: past
 * this the CSS ellipsis is doing all the work anyway, and the accessible name is the surface that
 * has to be complete — it gets the same string, so the two cannot drift.
 */
const TAB_ABOUT_MAX = 90;

/**
 * The clamp on a tab's second line.
 *
 * Inline because `index.css` is not this session's to edit and `.session-tab .slug` has no rule of
 * its own — without a ceiling a session whose opening prompt is a sentence would push every other
 * tab out of the strip. `.session-tabs` already scrolls, so nothing is lost; this is what keeps the
 * scrolling from being needed on two tabs.
 */
const TAB_ABOUT: CSSProperties = {
  maxWidth: 168,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  color: 'var(--ink-3)',
};

/**
 * Whether the distinguishing line says anything the name has not already said.
 *
 * With no label to show, `sessionAbout` falls back to the working directory's leaf — which is the
 * very thing the CLI built the name out of, so a tab would read `dev-c8 · project` and be wider for
 * no information at all. Dropping it there is not hiding anything: it is declining to say the same
 * word twice.
 */
const addsSomething = (name: string, about: string): boolean =>
  !name.toLowerCase().startsWith(about.toLowerCase());

/**
 * Where the picker's last explicit choice is remembered, so a reload shows the session that was
 * on screen rather than whichever one happened to be touched most recently. Only a *choice* is
 * written — the boot-time default is a default, and persisting it would promote a guess into a
 * preference the user never expressed.
 */
const PIN_KEY = 'rt.pinned';

const storePin = (id: string): void => {
  try {
    localStorage.setItem(PIN_KEY, id);
  } catch {
    // storage denied (private mode, exhausted quota) — the pin is a convenience, not a right
  }
};

const readPin = (): string | null => {
  try {
    return localStorage.getItem(PIN_KEY);
  } catch {
    return null;
  }
};

const clearPin = (): void => {
  try {
    localStorage.removeItem(PIN_KEY);
  } catch {
    // same shrug as storePin — storage that cannot be written cannot be holding stale keys
  }
};

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
  const [helpOpen, setHelpOpen] = useState(false);
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
   * The sessions that get a tab: the ones that are running.
   *
   * This started as "sessions with agents working", which is what was originally asked for and is
   * a sharper claim — but on a machine with two Claude windows open and neither fanning out, it
   * meant the top bar said `2 RUNNING` above a room with no way to reach the second one. Predicting
   * whether a tab will be there mattered more than the tab being precisely earned, and `live` is
   * already the thing the dot in the picker means. The working count still rides on the tab, so
   * "running" and "busy" stay visibly different.
   */
  const working = useMemo(() => sessions.filter((s) => s.live), [sessions]);

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

  /** The names more than one visible tab would show; those tabs need something that cannot clash. */
  const clashing = useMemo(() => clashingNames(tabs), [tabs]);

  // Follow the remembered pin if that session still exists, else the most recently touched one:
  // the observer exists to show what is happening now, but a reload that silently switched the
  // room to a *different* session — because a sibling happened to write last — read as the app
  // losing its place. A session the user picked themselves is never overridden.
  useEffect(() => {
    if (sessionId !== null || sessions.length === 0) return;
    const pinned = readPin();
    const restored = pinned !== null && sessions.some((s) => s.sessionId === pinned);
    // A pin naming a transcript that no longer exists is not a preference, it is litter — left in
    // place it would be re-checked against the roster on every boot for ever.
    if (pinned !== null && !restored) clearPin();
    setSessionId(restored ? pinned : sessions[0].sessionId);
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
  /**
   * How many turns this session has had.
   *
   * Not `state.msgs.length`: the feed is capped at a thousand, so that number stops rising exactly
   * when a session becomes long enough for the question to be worth asking, and it stops without
   * saying so. Everything below that shows a *turn count* reads this; the two places that mean
   * "rows I am about to render" — the feed's own window, the tools strip — deliberately do not.
   */
  const turns = turnCount(state);

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
    ? // No `TASK:` label. The board is a whiteboard in an office and visibly already is the task;
      // spending six of the thirty-odd characters it can hold on saying so cost more than it
      // explained. `scene.ts` still strips the old prefix defensively, so a stale client and this
      // one produce the same board rather than one reading `TASK: TASK: …`.
      clip(task, BOARD_MAX)
    : sessionId === null
      ? 'nothing to observe yet'
      : 'waiting for a task…';

  const pickSession = useCallback((id: string) => {
    setSessionId(id);
    storePin(id); // an explicit choice, from the picker, a tab or the palette — remembered
  }, []);
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
      { id: 'help', label: 'Help: what am I looking at', hint: '?', run: () => setHelpOpen(true) },
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
    // The third place a session has to be told from its neighbours — and the one that is searched
    // by typing, so carrying the opening prompt here means a session can be found by what it is
    // doing rather than only by a name it shares with five others.
    const list: Command[] = sessions.slice(0, 25).map((s) => {
      const name = sessionName(s);
      const about = sessionAbout(s);
      const says = addsSomething(name, about) ? ` — ${clip(about, TAB_ABOUT_MAX)}` : '';
      return {
        id: `session-${s.sessionId}`,
        label: `Observe ${name}${says}${s.live ? ' (running)' : ''}`,
        hint: s.cwd ?? s.slug,
        run: () => pickSession(s.sessionId),
      };
    });
    return [...base, ...agents, ...list];
  }, [theme, dockOpen, rows, sessions, seekTs, resumeLive, pickSession]);

  useKeys({
    // The two overlays are exclusive on purpose: they share a z-index, so opening one over the
    // other stacked an invisible dialog under a visible one — ⌘K over the help put focus in a
    // palette nobody could see, and keystrokes ran commands off the screen.
    'mod+k': () => { setPaletteOpen(true); setHelpOpen(false); },
    t: theme.cycle,
    b: () => setDockOpen((v) => !v),
    '?': () => { setHelpOpen(true); setPaletteOpen(false); },
    '1': () => { setTab('chat'); setDockOpen(true); },
    '2': () => { setTab('agents'); setDockOpen(true); },
    '3': () => { setTab('tools'); setDockOpen(true); },
    // Newest thing first, so each press undoes the most recent one: the overlays are on top of the
    // room, a seek is a state the whole room is held in, and a selection is the quietest of them
    // all. Escape that only ever cleared the selection left the seek with no keyboard exit.
    // (An open top-bar menu is closed before any of these by `useDismiss`, in the capture phase.)
    Escape: () => {
      if (paletteOpen) setPaletteOpen(false);
      else if (helpOpen) setHelpOpen(false);
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
        onOpenHelp={() => setHelpOpen(true)}
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
              const name = sessionName(s);
              /**
               * What tells this tab apart from the five beside it.
               *
               * The name cannot: the CLI builds it from the working directory's leaf plus a
               * counter, so six sessions started in the same place read `dev-c8`, `dev-52`,
               * `dev-ff` — six words that differ by two hex characters. What differs is what
               * each was asked to do, and when nothing was asked yet the directory is the honest
               * remainder rather than a sentence invented here.
               */
              const about = sessionAbout(s);
              // …and when the name *can*, this line is redundant and costs a tab twice its width.
              // A titled session already says what it is about in the name, so the strip stays a
              // strip rather than five 320px tabs the user has to scroll through.
              // A clashing name gets the id, not the opening prompt. The prompt is what the two
              // colliding tabs have *in common* — a background job is spawned with its parent's
              // task, so it inherits both the title and the first turn — and a disambiguator that
              // is itself identical on both tabs is worse than none, because it looks like one.
              // The id is the only thing here that cannot collide.
              const says = clashing.has(name)
                ? shortId(s.sessionId)
                : !hasChosenName(s) && addsSomething(name, about)
                  ? clip(about, TAB_ABOUT_MAX)
                  : undefined;
              const where = says === undefined ? (s.cwd ?? s.slug) : undefined;
              return (
                <button
                  key={s.sessionId}
                  type="button"
                  role="tab"
                  aria-selected={on}
                  className={on ? 'session-tab on' : 'session-tab'}
                  title={[name, says, s.cwd ?? s.slug].filter(Boolean).join(' · ')}
                  /*
                   * Spelt out rather than left to the visible text. Six tabs whose accessible
                   * names are six near-identical slugs is the same bug as six identical tabs on
                   * screen — and the text that distinguishes them is the one thing CSS is
                   * clipping. The dot and the badge are silent to a screen reader too, so what
                   * they mean is said here in words.
                   */
                  aria-label={[
                    name,
                    says,
                    where,
                    s.live ? 'running' : 'not running',
                    busy > 0 ? `${busy} agent${busy === 1 ? '' : 's'} working` : undefined,
                  ]
                    .filter(Boolean)
                    .join(' — ')}
                  onClick={() => pickSession(s.sessionId)}
                >
                  {/* The session being watched keeps its tab even after it goes quiet, so the tab
                      is not always a running one and must not always claim to be. */}
                  <span className={s.live ? 'dot live' : 'dot'} />
                  <b>{name}</b>
                  {says && (
                    <span className="slug" style={TAB_ABOUT}>
                      {says}
                    </span>
                  )}
                  {/* Only when there is something to count. A tab is now raised by a session merely
                      running, so a badge reading `0` would be on most of them most of the time —
                      and a number that is nearly always zero stops being read at all. */}
                  {busy > 0 && (
                    <span className="n" title={`${busy} agent${busy === 1 ? '' : 's'} working`}>
                      {busy}
                    </span>
                  )}
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
          turns={turns}
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
              {/* CHAT counts the session's turns, cap included — it is the same claim the strip
                  below makes and the two must not disagree. AGENTS and TOOLS count rows: the
                  roster is every agent there is, and the tool strip is a live window by design. */}
              <span className="n">
                {t.key === 'chat' ? turns : t.key === 'agents' ? rows.length : state.tools.length}
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
        turns={turns}
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
      {helpOpen && <Help onClose={() => setHelpOpen(false)} />}
    </div>
  );
}
