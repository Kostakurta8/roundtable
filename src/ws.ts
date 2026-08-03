/**
 * The client half of the observer stream: one loopback WebSocket, folded into one `RtState` per
 * session.
 *
 * The hub sends a `hello` roster on connect, then starts streaming every session that is running
 * on this machine plus whichever one the picker pinned — a backlog replay followed by live events
 * for each, one JSON frame each. Control frames carry no `seq`, which is exactly what `isEv` keys
 * on, so events and control messages never get confused.
 *
 * This used to follow exactly one session, and changing it dropped the socket and reset
 * everything. That was a deliberate freeze in the design spec ("One session rendered at a time"),
 * and it is what the tab strip lifts: several sessions can have agents working at once, and a tab
 * whose contents were thrown away the moment you looked at another one would be a screenshot
 * rather than an observer. The socket is now opened once and lives as long as the app; `follow`
 * only tells the hub which session the picker chose, and nothing about switching resets anything.
 */
import { useEffect, useReducer, useRef, useState } from 'react';
import { evSession, isEv, type Ev } from '../shared/events';
// From `shared/`, never from `server/hub`: the hub pulls in node:fs, chokidar and ws, and an
// `import type` is only one careless edit away from becoming a value import that bundles them.
import type { FollowCmd, SessionSummary } from '../shared/protocol';
import { initialState, reduce, type RtState } from './store';

/** Loopback, always. The observer reads one machine's transcripts: its own. */
export const WS_URL = 'ws://127.0.0.1:7411/ws';

/** A row of the hub's session roster. Same shape the hub publishes, by construction. */
export type RtSession = SessionSummary;

/** What the hub has said about the completeness of one session's tail. */
export type RtNotice = { skipped: number; behind: boolean };

export type RtStream = {
  /**
   * One folded state per session the hub is streaming, keyed by session id.
   *
   * Never merged into a single state, however tempting: the roster, the totals and the task of two
   * sessions are different facts about different things, and adding them together would produce a
   * number that is true of nothing.
   */
  states: Readonly<Record<string, RtState>>;
  sessions: RtSession[];
  /** Per session: events the hub could no longer replay; absent when nothing was lost. */
  dropped: Readonly<Record<string, number>>;
  /** Per session: true between the hub attaching it and its `ready`, i.e. while the backlog lands. */
  replaying: Readonly<Record<string, boolean>>;
  /** Per session: what the hub said about an incomplete tail. Absent when the tail is whole. */
  notices: Readonly<Record<string, RtNotice>>;
  connected: boolean;
  /** The directory the hub is observing, so the UI can name it rather than assume it. */
  root: string;
};

/**
 * A second consumer of the same socket, for state that is not a pure fold of the events.
 *
 * The office simulation is exactly that: it queues walks and holds bubbles on a clock, so it has
 * to *see* each event rather than be recomputed from the resulting state. Each event names its own
 * session, so this sink routes them itself — there is one room per session behind it.
 */
export type EvSink = {
  ev: (ev: Ev) => void;
  /**
   * Throw away simulation state. A session id resets that one room, for a transcript the hub has
   * declared invalid and is about to replay; `null` resets every room, for a reconnect that
   * replays all of them.
   */
  reset: (sessionId: string | null) => void;
};

/** Reconnect backoff: quick enough to feel instant on a server restart, slow enough to be polite. */
const RETRY_MIN_MS = 1000;
const RETRY_MAX_MS = 8000;
/** A backlog replay arrives as hundreds of frames; folding them per frame would be a render each. */
const FLUSH_MS = 16;
const NO_TIMER = 0;

type Action =
  | { kind: 'resetAll' }
  | { kind: 'resetSession'; sessionId: string }
  | { kind: 'events'; evs: Ev[] };

type States = Record<string, RtState>;

/** Drops one key without touching the original. */
function without<T>(rec: Readonly<Record<string, T>>, key: string): Record<string, T> {
  if (!(key in rec)) return rec as Record<string, T>;
  const out = { ...rec };
  delete out[key];
  return out;
}

function streamReducer(states: States, action: Action): States {
  if (action.kind === 'resetAll') return {};
  if (action.kind === 'resetSession') return without(states, action.sessionId);

  // One shallow copy for the whole batch, and only if something actually changed — a replayed
  // event the fold rejects on `seq` must not produce a new object and a render with it.
  let next = states;
  for (const ev of action.evs) {
    const id = evSession(ev);
    const prev = next[id] ?? initialState;
    const folded = reduce(prev, ev);
    if (folded === prev) continue;
    if (next === states) next = { ...states };
    next[id] = folded;
  }
  return next;
}

const EMPTY_STATES: States = {};

/**
 * Opens the observer stream and returns everything the UI needs to draw every session at once.
 *
 * `pinned` is the picker's choice, which may be a session that is not running — the hub attaches
 * running sessions by itself, but it will never guess that somebody wants to look at a finished
 * one. Changing it sends one small frame; it does not touch the socket, and it does not discard a
 * single event of any session already on screen.
 *
 * `sink`, when given, sees every event this hook folds, in the same order and the same batch. It
 * is read through a ref so that passing a fresh closure on every render cannot cycle the socket.
 */
export function useRtStream(pinned: string | null, sink?: EvSink): RtStream {
  const [states, dispatch] = useReducer(streamReducer, EMPTY_STATES);
  const [sessions, setSessions] = useState<RtSession[]>([]);
  const [dropped, setDropped] = useState<Record<string, number>>({});
  const [replaying, setReplaying] = useState<Record<string, boolean>>({});
  const [notices, setNotices] = useState<Record<string, RtNotice>>({});
  const [connected, setConnected] = useState(false);
  const [root, setRoot] = useState('');

  const sinkRef = useRef(sink);
  sinkRef.current = sink;
  /** The live socket, so a change of pin can speak to it without the effect owning the pin. */
  const sockRef = useRef<WebSocket | null>(null);
  /** The pin as the *socket* knows it, so a reconnect can restate it. */
  const pinRef = useRef(pinned);
  pinRef.current = pinned;

  useEffect(() => {
    let stopped = false;
    let retry: ReturnType<typeof setTimeout> | typeof NO_TIMER = NO_TIMER;
    let flushTimer: ReturnType<typeof setTimeout> | typeof NO_TIMER = NO_TIMER;
    let buffered: Ev[] = [];
    let attempt = 0;

    const flush = (): void => {
      flushTimer = NO_TIMER;
      if (buffered.length === 0) return;
      const evs = buffered;
      buffered = [];
      dispatch({ kind: 'events', evs });
      const observer = sinkRef.current;
      if (observer) for (const ev of evs) observer.ev(ev);
    };

    /** Coalesces a burst of frames into one fold, so a 2000-event replay is not 2000 renders. */
    const queue = (ev: Ev): void => {
      buffered.push(ev);
      if (flushTimer === NO_TIMER) flushTimer = setTimeout(flush, FLUSH_MS);
    };

    /** Set by `backlogTruncated`, claimed by the `ready` that names the session it belonged to. */
    let pendingDropped = 0;

    const dropBuffer = (): void => {
      if (flushTimer !== NO_TIMER) clearTimeout(flushTimer);
      flushTimer = NO_TIMER;
      buffered = [];
    };

    const onFrame = (data: string): void => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(data);
      } catch {
        return; // not JSON — the hub never sends that, so there is nothing to salvage
      }
      if (isEv(parsed)) {
        queue(parsed);
        return;
      }
      if (!parsed || typeof parsed !== 'object') return;
      const msg = parsed as {
        kind?: unknown;
        sessions?: unknown;
        dropped?: unknown;
        root?: unknown;
        sessionId?: unknown;
        skipped?: unknown;
        behind?: unknown;
      };
      const sessionId = typeof msg.sessionId === 'string' ? msg.sessionId : undefined;

      if ((msg.kind === 'hello' || msg.kind === 'roster') && Array.isArray(msg.sessions)) {
        setSessions(msg.sessions as RtSession[]);
        if (typeof msg.root === 'string') setRoot(msg.root);
        return;
      }
      if (msg.kind === 'backlogTruncated' && typeof msg.dropped === 'number') {
        // The hub sends this immediately before a replay, so it belongs to whichever session is
        // about to arrive. It carries no id of its own, and the `ready` that closes the replay
        // does — which is where it is filed.
        pendingDropped = msg.dropped;
        return;
      }
      if (msg.kind === 'ready' && sessionId) {
        // The replay is in `buffered` right now, not in the state — flushing here rather than
        // waiting out the timer means the panel stops saying "loading" on the same frame it
        // gains the history, instead of one tick later.
        flush();
        const gap = pendingDropped;
        pendingDropped = 0;
        setReplaying((prev) => ({ ...prev, [sessionId]: false }));
        if (gap > 0) setDropped((prev) => ({ ...prev, [sessionId]: gap }));
        return;
      }
      if (msg.kind === 'reset' && sessionId) {
        // That transcript was truncated or replaced and is about to be re-read from byte zero.
        // Every line of it will arrive again with a fresh `seq`, which the fold's idempotence
        // guard cannot recognize — so the only safe thing is to drop what we have.
        flush(); // anything buffered belongs to the state being discarded
        dropBuffer();
        dispatch({ kind: 'resetSession', sessionId });
        sinkRef.current?.reset(sessionId);
        setReplaying((prev) => ({ ...prev, [sessionId]: true }));
        setDropped((prev) => without(prev, sessionId));
        return;
      }
      if (msg.kind === 'notice' && sessionId) {
        const skipped = typeof msg.skipped === 'number' ? msg.skipped : 0;
        const behind = msg.behind === true;
        setNotices((prev) => {
          if (skipped === 0 && !behind) {
            if (!(sessionId in prev)) return prev;
            const out = { ...prev };
            delete out[sessionId];
            return out;
          }
          const was = prev[sessionId];
          if (was && was.skipped === skipped && was.behind === behind) return prev;
          return { ...prev, [sessionId]: { skipped, behind } };
        });
        return;
      }
      // Any other kind is ignored on purpose: this client must survive a newer hub.
    };

    const open = (): void => {
      if (stopped) return;
      dropBuffer(); // nothing from the previous socket may reach the state this one rebuilds
      const s = new WebSocket(WS_URL);
      sockRef.current = s;

      s.onopen = () => {
        attempt = 0;
        setConnected(true);
        // The hub replays every session's whole backlog to a new connection, so the fold restarts
        // from empty here — otherwise a reconnect would count all of that history a second time.
        dispatch({ kind: 'resetAll' });
        sinkRef.current?.reset(null);
        setDropped({});
        setNotices({});
        setReplaying({});
        pendingDropped = 0;
        const id = pinRef.current;
        if (!id) return; // connected for the roster and whatever is running; nothing pinned yet
        setReplaying({ [id]: true });
        const follow: FollowCmd = { cmd: 'follow', sessionId: id }; // typed, so a typo fails the build
        s.send(JSON.stringify(follow));
      };

      s.onmessage = (e: MessageEvent<unknown>) => {
        if (typeof e.data === 'string') onFrame(e.data);
      };

      // 'error' is always followed by 'close', which is where the retry is scheduled.
      s.onerror = () => {};

      s.onclose = () => {
        setConnected(false);
        setReplaying({}); // a replay that will never finish must not leave the UI waiting on it
        if (stopped) return;
        const wait = Math.min(RETRY_MAX_MS, RETRY_MIN_MS * 2 ** attempt);
        attempt += 1;
        retry = setTimeout(open, wait);
      };
    };

    open();

    return () => {
      stopped = true;
      if (retry !== NO_TIMER) clearTimeout(retry);
      dropBuffer();
      const s = sockRef.current;
      sockRef.current = null;
      if (!s) return;
      s.onmessage = null;
      s.onerror = null;
      s.onclose = null; // detached first: a closing socket must not schedule a reconnect
      if (s.readyState === WebSocket.CONNECTING) {
        // Closing a socket mid-handshake logs a console warning; closing it the instant it
        // opens is just as immediate and silent.
        s.onopen = () => s.close();
      } else {
        s.onopen = null;
        s.close();
      }
    };
    // Deliberately empty: the socket outlives every pin. Cycling it on a session change is the
    // behaviour this hook exists to stop.
  }, []);

  // Telling the hub which session the picker chose is a frame, not a reconnection. Nothing here
  // discards state: the session being switched away from keeps streaming for as long as it is
  // running, which is what makes switching back free.
  useEffect(() => {
    const s = sockRef.current;
    if (!pinned || !s || s.readyState !== WebSocket.OPEN) return;
    setReplaying((prev) => (prev[pinned] ? prev : { ...prev, [pinned]: true }));
    const follow: FollowCmd = { cmd: 'follow', sessionId: pinned };
    s.send(JSON.stringify(follow));
  }, [pinned]);

  return { states, sessions, dropped, replaying, notices, connected, root };
}
