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

/**
 * The most events kept across every session at once.
 *
 * The hub streams every *running* session to the page, not only the one on screen, so a per-session
 * cap alone let a tab left open for a week keep twenty thousand events for each of dozens of
 * sessions, and never give any of it back. Past this, the least recently active sessions lose
 * their oldest events first; the one being written to now is the last to be trimmed.
 */
export const EV_KEEP_ALL = 60_000;

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
export function evLog(next: () => EvSink, keepAll = EV_KEEP_ALL): EvLog {
  // In order of last activity, least recent first: a Map iterates in insertion order, and an
  // event re-inserts its session at the end.
  const kept = new Map<string, Kept>();
  let total = 0;
  return {
    sink: {
      ev: (ev) => {
        const id = evSession(ev);
        const k = kept.get(id) ?? { evs: [], lost: 0 };
        kept.delete(id);
        kept.set(id, k);
        k.evs.push(ev);
        total += 1;
        if (k.evs.length > EV_KEEP) {
          k.evs.shift();
          k.lost += 1;
          total -= 1;
        }
        for (const old of kept.values()) {
          if (total <= keepAll || old === k) break;
          // Emptied, not forgotten: `lost` is what lets the share dialog say a clip of this
          // session is partial rather than quietly render less of it.
          const drop = Math.min(old.evs.length, total - keepAll);
          old.evs.splice(0, drop);
          old.lost += drop;
          total -= drop;
        }
        next().ev(ev);
      },
      // A reset means the hub is about to replay that session from the top (or every session, on
      // a reconnect). Keeping the old copy would put every event in a clip twice.
      reset: (sessionId) => {
        if (sessionId === null) {
          kept.clear();
          total = 0;
        } else {
          total -= kept.get(sessionId)?.evs.length ?? 0;
          kept.delete(sessionId);
        }
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
