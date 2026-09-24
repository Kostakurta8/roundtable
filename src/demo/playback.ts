/**
 * The hosted demo's transport: a recording of the hub, played back as though the hub were sending it.
 *
 * GitHub Pages serves files and nothing else, so the page there has no hub to open a socket to.
 * `scripts/recordDemo.ts` ran the real one against the staged demo room and wrote down every frame
 * it sent, with when it arrived; this hands those frames to the stream on the same schedule. Nothing
 * downstream is told the difference — the frames go through the same `onMsg` a socket's do, into the
 * same store and the same office — which is the whole point: the demo is the app, not a video of it.
 *
 * Two things have to be rewritten on the way through, and only two.
 *
 * **Time.** The store and the panels judge "working", "quiet" and "4s ago" against `Date.now()`, so
 * a frame has to say it happened *now*, not on the afternoon it was recorded — played verbatim, every
 * agent in the room would read as having gone quiet months ago. The recording stores times relative
 * to its own start, and each pass puts them back on the viewer's clock.
 *
 * **`seq`, on every pass after the first.** The recording ends, the page holds on the last moment for
 * a few seconds, and then the whole thing starts over — as if both transcripts had been rewound under
 * the hub. That is a case the protocol already has a frame for: the hub sends `reset` for a rewound
 * transcript and re-reads it with *fresh* `seq`s, and the client drops the session and rebuilds it.
 * So a new pass opens with a `reset` per session and carries every `seq` past the last pass's, which
 * is exactly what a real rewind looks like on the wire. Replaying the same numbers would lean on the
 * store having been emptied first; fresh ones do not have to.
 */
import { isEv, type Ev } from '../../shared/events';
import type { ResetMsg } from '../../shared/protocol';

/** One frame: when it arrived, in ms from the start of the recording, and what the hub sent. */
export type Frame = readonly [at: number, msg: object];

export type Recording = {
  /** How long the take ran — at least as long as the last frame's `at`, usually a little longer. */
  span: number;
  /** In arrival order, which is the order the hub sent them — `at` never decreases. */
  frames: readonly Frame[];
};

/** How long the last moment stays on screen before the replay starts over. */
export const HOLD_MS = 5000;

/**
 * How much faster than it was recorded the hosted demo plays.
 *
 * The staged room keeps the hub's shipped timing, so the first agent walks out almost three minutes
 * in — long after somebody who arrived from a link has closed the tab. Playing it faster is the
 * honest fix: nothing is skipped or reordered, every gap shrinks by the same factor, and the banner
 * says the replay is sped up. Re-staging a busier room would have meant a second demo that `--demo`
 * does not show.
 */
export const DEMO_SPEED = 2.5;

/**
 * The recording as the page receives it, which is as JSON: checked here, once, and typed after.
 *
 * Only the envelope is checked. What is *inside* a frame is the hub's business and the stream's to
 * judge — `onMsg` already treats every frame as untrusted and ignores what it does not recognize,
 * because it has to survive a newer hub. Checking it twice would be a second parser that could
 * disagree with the first.
 */
export function parseRecording(raw: unknown): Recording {
  const r = raw && typeof raw === 'object' ? (raw as { v?: unknown; span?: unknown; frames?: unknown }) : {};
  if (r.v !== 1 || !Array.isArray(r.frames)) throw new Error('demo: not a version-1 recording');
  const frames: Frame[] = [];
  let at = 0;
  for (const f of r.frames as unknown[]) {
    if (!Array.isArray(f) || typeof f[0] !== 'number' || !Number.isFinite(f[0])) continue;
    const msg: unknown = f[1];
    if (!msg || typeof msg !== 'object') continue;
    // Arrival order is the truth, not the number beside it: a clock that stepped back while the
    // recording ran must not reorder a `reset` behind the backlog it was clearing the way for.
    at = Math.max(at, f[0]);
    frames.push([at, msg]);
  }
  // The recorder stops a little after its last frame, so the last agent out has time to walk; a
  // span that claims to end before the frames do is not believed.
  const span = typeof r.span === 'number' && Number.isFinite(r.span) ? Math.max(at, r.span) : at;
  return { span, frames };
}

/** The highest `seq` in the recording: how far each pass moves the next one's numbers along. */
export function seqSpan(rec: Recording): number {
  let top = 0;
  for (const [, msg] of rec.frames) if (isEv(msg) && msg.seq > top) top = msg.seq;
  return top;
}

/** Every session the recording streams, in the order it first mentions them. */
export function sessionsOf(rec: Recording): string[] {
  const seen = new Set<string>();
  for (const [, msg] of rec.frames) {
    const id = (msg as { sessionId?: unknown }).sessionId;
    if (isEv(msg)) seen.add('ref' in msg ? msg.ref.sessionId : msg.sessionId);
    else if (typeof id === 'string') seen.add(id);
  }
  return [...seen];
}

/**
 * One recorded frame, as it would have been sent at `base`, with the recording's clock run `speed`
 * times faster.
 *
 * Returns a copy; the recording is shared by every pass and must come out of each one untouched.
 */
export function shift(msg: object, base: number, seqOffset: number, speed = 1): object {
  const at = (t: number): number => base + t / speed;
  if (isEv(msg)) {
    const ev: Ev = { ...msg, ts: at(msg.ts), seq: msg.seq + seqOffset };
    if (ev.kind !== 'workflowPhase') return ev;
    return {
      ...ev,
      phases: ev.phases.map((p) => ({
        ...p,
        agents: p.agents.map((a) => (a.queuedAt === undefined ? a : { ...a, queuedAt: at(a.queuedAt) })),
      })),
    };
  }
  const m = msg as { kind?: unknown; sessions?: unknown };
  if ((m.kind === 'hello' || m.kind === 'roster') && Array.isArray(m.sessions)) {
    return {
      ...m,
      sessions: (m.sessions as unknown[]).map((s) => {
        const row = s && typeof s === 'object' ? (s as { mtime?: unknown }) : null;
        return row && typeof row.mtime === 'number' ? { ...row, mtime: at(row.mtime) } : s;
      }),
    };
  }
  return msg;
}

/**
 * Plays `rec` into `deliver` for ever: each frame at its own offset from the start of the pass —
 * divided by `speed` — then a hold of `holdMs` on the last moment, then the next pass. Returns the
 * way to stop. The hold is real time, not recording time: it is for the viewer, not the replay.
 *
 * Scheduled against `Date.now()` rather than by counting timer ticks, because a background tab's
 * timers are throttled to once a second or worse: the frames that fell due while nobody was looking
 * arrive together when somebody is, stamped with the times they were due — which is what a socket
 * does for a tab that was asleep, too.
 */
export function play(rec: Recording, deliver: (msg: object) => void, holdMs = HOLD_MS, speed = 1): () => void {
  const step = seqSpan(rec);
  const sessions = sessionsOf(rec);
  let pass = 0;
  let base = Date.now();
  let next = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;

  const tick = (): void => {
    timer = null;
    const elapsed = Date.now() - base;
    while (next < rec.frames.length && rec.frames[next][0] / speed <= elapsed) {
      const [, msg] = rec.frames[next];
      next += 1;
      deliver(shift(msg, base, pass * step, speed));
      if (stopped) return; // whatever `deliver` did, it included stopping us
    }
    timer =
      next < rec.frames.length
        ? setTimeout(tick, rec.frames[next][0] / speed - elapsed)
        : setTimeout(restart, Math.max(0, rec.span / speed + holdMs - elapsed));
  };

  const restart = (): void => {
    pass += 1;
    base = Date.now();
    next = 0;
    for (const sessionId of sessions) {
      const reset: ResetMsg = { kind: 'reset', sessionId, reason: 'rewound' };
      deliver(reset);
      if (stopped) return;
    }
    tick();
  };

  tick();

  return () => {
    stopped = true;
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };
}
