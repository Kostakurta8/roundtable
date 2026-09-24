/**
 * Each session's raw events, kept for the share dialog.
 *
 * Everything else on the page keeps a *fold* of the stream: the store keeps an `RtState`, the office
 * keeps the commands it was given. Neither can be turned back into events, and a clip needs the
 * events themselves — `renderClip` re-sorts them by the transcripts' own clock, re-folds them for
 * the names and totals at every frame, and cuts the silences between them. So this sits in front of
 * the office's sink, keeps what passes through, and hands every event on unchanged.
 *
 * A tee rather than a change to `useRtStream`: the socket hook already has exactly one door for a
 * second consumer, and the shell only has to hand it this one instead of the office's.
 */
import { useRef } from 'react';
import { evSession, type Ev } from '../../shared/events';
import type { EvSink } from '../ws';

/**
 * The most events one session keeps; past it the oldest go, and are counted.
 *
 * The same ceiling the office's replay log keeps in commands (`REPLAY_CAP`), for the same reason:
 * roughly a long working session, a few megabytes, and a bound that holds however long the tab is
 * left open on a session that never stops. The hub only replays a session's last four thousand
 * events to a page anyway, so this is only ever reached by a tab that watched a long run live.
 */
export const EV_KEEP = 20_000;

export type EvLog = {
  /** Hand this to `useRtStream` in place of the sink it wraps. */
  sink: EvSink;
  /** A copy of what is kept for one session, oldest first: a render must not see it grow mid-way. */
  events: (sessionId: string) => Ev[];
  /** How many of one session's events the cap has let go of since its last reset. */
  lost: (sessionId: string) => number;
};

type Kept = { evs: Ev[]; lost: number };

/** The log itself, with no React in it. `next` is read per event, so the wrapped sink may change. */
export function evLog(next: () => EvSink): EvLog {
  const kept = new Map<string, Kept>();
  return {
    sink: {
      ev: (ev) => {
        const id = evSession(ev);
        let k = kept.get(id);
        if (!k) {
          k = { evs: [], lost: 0 };
          kept.set(id, k);
        }
        k.evs.push(ev);
        if (k.evs.length > EV_KEEP) {
          k.evs.shift();
          k.lost += 1;
        }
        next().ev(ev);
      },
      // A reset means the hub is about to replay that session from the top (or every session, on
      // a reconnect). Keeping the old copy would put every event in a clip twice.
      reset: (sessionId) => {
        if (sessionId === null) kept.clear();
        else kept.delete(sessionId);
        next().reset(sessionId);
      },
    },
    events: (sessionId) => kept.get(sessionId)?.evs.slice() ?? [],
    lost: (sessionId) => kept.get(sessionId)?.lost ?? 0,
  };
}

/** One log for the life of the shell, in front of whatever sink it is handed. */
export function useEvLog(inner: EvSink): EvLog {
  const innerRef = useRef(inner);
  innerRef.current = inner;
  const log = useRef<EvLog | null>(null);
  log.current ??= evLog(() => innerRef.current);
  return log.current;
}
