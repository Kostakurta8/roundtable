/**
 * The client half of the observer stream: one loopback WebSocket, folded into `RtState`.
 *
 * The hub sends a `hello` roster on connect, then — once this client asks to follow a session —
 * a backlog replay followed by live events, one JSON frame each. Control frames carry no `seq`,
 * which is exactly what `isEv` keys on, so events and control messages never get confused.
 */
import { useEffect, useReducer, useRef, useState } from 'react';
import { isEv, type Ev } from '../shared/events';
import type { FollowCmd, SessionSummary } from '../server/hub';
import { initialState, reduce, type RtState } from './store';

/** Loopback, always. The observer reads one machine's transcripts: its own. */
export const WS_URL = 'ws://127.0.0.1:7411/ws';

/** A row of the hub's session roster. Same shape the hub publishes, by construction. */
export type RtSession = SessionSummary;

export type RtStream = {
  state: RtState;
  sessions: RtSession[];
  /** Events the hub could no longer replay for the followed session; 0 when nothing was lost. */
  truncatedDropped: number;
  connected: boolean;
};

/**
 * A second consumer of the same socket, for state that is not a pure fold of the events.
 *
 * The office simulation is exactly that: it queues walks and holds bubbles on a clock, so it
 * has to *see* each event rather than be recomputed from the resulting state. `reset` fires
 * wherever the reducer's own `reset` does — a reconnect or a session switch replays the whole
 * backlog, and a sink that missed the notice would act on that history twice.
 */
export type EvSink = {
  ev: (ev: Ev) => void;
  reset: () => void;
};

/** Reconnect backoff: quick enough to feel instant on a server restart, slow enough to be polite. */
const RETRY_MIN_MS = 1000;
const RETRY_MAX_MS = 8000;
/** A backlog replay arrives as hundreds of frames; folding them per frame would be a render each. */
const FLUSH_MS = 16;
const NO_TIMER = 0;

type Action = { kind: 'reset' } | { kind: 'events'; evs: Ev[] };

const streamReducer = (state: RtState, action: Action): RtState =>
  action.kind === 'reset' ? initialState : action.evs.reduce(reduce, state);

/**
 * Follows one session and returns everything the UI needs to draw it.
 *
 * Changing `sessionId` (including the first time one is chosen) drops the socket and opens a
 * fresh one: the replay that follows is the whole history of the new session, so the previous
 * session's state has to go with it — and a socket that is thrown away cannot deliver a late
 * frame from the stream it used to carry.
 *
 * `sink`, when given, sees every event this hook folds, in the same order and the same batch.
 * It is read through a ref so that passing a fresh closure on every render cannot cycle the
 * socket — only `sessionId` may do that.
 */
export function useRtStream(sessionId: string | null, sink?: EvSink): RtStream {
  const [state, dispatch] = useReducer(streamReducer, initialState);
  const [sessions, setSessions] = useState<RtSession[]>([]);
  const [truncatedDropped, setTruncatedDropped] = useState(0);
  const [connected, setConnected] = useState(false);
  const sinkRef = useRef(sink);
  sinkRef.current = sink;

  useEffect(() => {
    let stopped = false;
    let sock: WebSocket | null = null;
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
      const msg = parsed as { kind?: unknown; sessions?: unknown; dropped?: unknown };
      if (msg.kind === 'hello' && Array.isArray(msg.sessions)) {
        setSessions(msg.sessions as RtSession[]);
      } else if (msg.kind === 'backlogTruncated' && typeof msg.dropped === 'number') {
        setTruncatedDropped(msg.dropped);
      }
      // Any other kind is ignored on purpose: this client must survive a newer hub.
    };

    const open = (): void => {
      if (stopped) return;
      dropBuffer(); // nothing from the previous socket may reach the state this one rebuilds
      const s = new WebSocket(WS_URL);
      sock = s;

      s.onopen = () => {
        attempt = 0;
        setConnected(true);
        if (!sessionId) return; // connected for the roster only; nothing to follow yet
        // The hub replays the full backlog to every new follower, so the fold restarts from
        // empty here — otherwise a reconnect would count the whole history a second time.
        dispatch({ kind: 'reset' });
        sinkRef.current?.reset();
        setTruncatedDropped(0);
        const follow: FollowCmd = { cmd: 'follow', sessionId }; // typed, so a protocol typo fails the build
        s.send(JSON.stringify(follow));
      };

      s.onmessage = (e: MessageEvent<unknown>) => {
        if (typeof e.data === 'string') onFrame(e.data);
      };

      // 'error' is always followed by 'close', which is where the retry is scheduled.
      s.onerror = () => {};

      s.onclose = () => {
        setConnected(false);
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
      const s = sock;
      sock = null;
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
  }, [sessionId]);

  return { state, sessions, truncatedDropped, connected };
}
