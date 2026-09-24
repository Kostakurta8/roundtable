/**
 * The hosted demo's cut: a finished session, dealt out again as a hub would have streamed it had
 * it been written at a pace somebody arriving from a link will sit through.
 *
 * The session the demo tells is the README's (`scripts/promo/showcase.ts`), and that is written in
 * one go, stamped across nine minutes. Pointed at it, the hub does what it does for any session
 * that has already happened — one `reset`, the whole backlog, `ready` — and on the page that is a
 * room that is over before the first frame. A performance needs each line on the wire at the
 * moment it happened. So `scripts/recordDemo.ts` lets the real hub read the session (which is how
 * the derived frames, chiefly `agentDone`, come to exist at all), and this puts what it sent back
 * on a clock of its own.
 *
 * The clock is the clip's idea (`src/clip/render.ts`): every silence is clamped to a beat, then the
 * whole run is scaled to the length wanted. One difference matters. The clip draws the office on
 * the compressed clock, so its walks speed up with everything else; the page's office walks in
 * real time whatever the frames say. The scale is therefore the only speed-up there is, and the
 * clamp is sized in *viewer* time — a silence long enough to be cut becomes one `beatMs` on screen —
 * so what was a long wait still reads as a pause rather than vanishing.
 *
 * Only the recorder and the tests import this. The page plays its output; it never runs it.
 */
import type { Ev } from '../../shared/events';
import type { HelloMsg, ReadyMsg, ResetMsg, RosterMsg, ServerMsg, SessionSummary } from '../../shared/protocol';

/** One session as the hub replayed it: every event it sent from its `reset` on, in arrival order. */
export type TakeSession = { sessionId: string; evs: readonly Ev[] };

/** What the hub sent a fresh socket: the roster it opened with, and each session it attached. */
export type Take = { hello: HelloMsg; sessions: readonly TakeSession[] };

export type CutOptions = {
  /** The session whose moments set the clock. The others are carried on it, not allowed to bend it. */
  lead: string;
  /** How long the lead session's run plays, from its first moment to its last. */
  playMs: number;
  /** What a silence the clamp shortened lasts on screen. */
  beatMs: number;
  /** Kept after the last frame, for the last people out to reach the door. */
  tailMs: number;
  /** How often the hub looks for a changed roster — `DEFAULT_ROSTER_MS` in `server/hub.ts`. */
  rosterMs: number;
  /** What `hello.root` says instead of the directory the hub was really pointed at. */
  root: string;
};

export type CutFrame = [at: number, msg: ServerMsg | Ev];

export type Cut = {
  /** When the take ends: the last frame plus the tail. */
  span: number;
  /** How long the lead session really ran, on its transcripts' own clock. */
  realMs: number;
  /** How long that run plays — `playMs`, as the frames actually came out. */
  playMs: number;
  /** The longest silence that survived uncut, on the transcripts' clock. */
  capMs: number;
  frames: CutFrame[];
};

const MAIN = 'main';

const agentKey = (sessionId: string, agentId: string): string => `${sessionId}\u0000${agentId}`;

/**
 * When an event happened, on the transcripts' clock — or `null` for `sessionSeen`, which is stamped
 * with the moment the hub attached and happened at no point in the session at all.
 *
 * `agentSeen` from a sidecar is the other hub-clock stamp: it says when the hub *read* the file,
 * which for a session written in one go is after every line in it. Left there, every agent would
 * be introduced after it had gone home, so it is pinned to the first line its agent wrote, exactly
 * as the clip pins it. Keyed by session too: every session has a `main`.
 */
function whenOf(evs: readonly Ev[]): (ev: Ev) => number | null {
  const first = new Map<string, number>();
  for (const ev of evs) {
    if (ev.kind === 'agentSeen' || !('ref' in ev)) continue;
    const k = agentKey(ev.ref.sessionId, ev.ref.agentId);
    const was = first.get(k);
    if (was === undefined || ev.ts < was) first.set(k, ev.ts);
  }
  return (ev) => {
    if (ev.kind === 'sessionSeen') return null;
    if (ev.kind === 'agentSeen') return Math.min(ev.ts, first.get(agentKey(ev.ref.sessionId, ev.ref.agentId)) ?? ev.ts);
    return ev.ts;
  };
}

/** A transcript moment → where it plays, in ms from the start of the take. */
export type Clock = { at: (t: number) => number; capMs: number; realMs: number };

/**
 * The compressed clock, built from the moments of one session.
 *
 * The cap is solved for rather than chosen: the largest silence kept whole is the one that, once
 * the run is scaled to `playMs`, lasts exactly `beatMs`. A fixed cap would be a guess about how the
 * session is spaced, and the showcase is re-staged whenever its story changes.
 *
 * Between two of the session's moments the clock is linear, which is what lets a second session's
 * lines ride it: they land between the same two moments, in proportion, and cannot stretch a gap
 * the lead session already has — a side session speaking in the middle of a clamped silence would
 * otherwise split it into two silences and make the lead run longer.
 */
export function compressedClock(times: readonly number[], playMs: number, beatMs: number): Clock {
  const u = [...new Set(times.filter(Number.isFinite))].sort((a, b) => a - b);
  if (u.length < 2) {
    const u0 = u[0] ?? 0;
    return { at: (t) => t - u0, capMs: 0, realMs: 0 };
  }
  const gaps = u.slice(1).map((t, i) => t - u[i]);
  const total = (cap: number): number => gaps.reduce((n, g) => n + Math.min(cap, g), 0);
  const beat = (cap: number): number => (cap * playMs) / total(cap);
  const widest = Math.max(...gaps);
  let cap = widest;
  if (beat(widest) > beatMs) {
    // `beat` never falls as the cap rises — a larger cap only lengthens the run by what it keeps —
    // so the answer can be bisected. Floored at the smallest gap: below it every silence is
    // clamped alike and the cap stops meaning anything.
    let lo = Math.min(...gaps);
    let hi = widest;
    for (let i = 0; i < 48 && hi - lo > 1; i++) {
      const mid = (lo + hi) / 2;
      if (beat(mid) > beatMs) hi = mid;
      else lo = mid;
    }
    cap = lo;
  }
  const k = playMs / total(cap);
  const c = [0];
  for (let i = 0; i < gaps.length; i++) c.push(c[i] + Math.min(cap, gaps[i]));
  const last = u.length - 1;
  const at = (t: number): number => {
    // Outside the lead's run, a line is at most one clamped silence away from its nearest edge:
    // what came before is setting the scene, and has no business pushing the first moment back.
    if (t < u[0]) return -Math.min(cap, u[0] - t) * k;
    if (t >= u[last]) return (c[last] + Math.min(cap, t - u[last])) * k;
    let lo = 0;
    let hi = last;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (u[mid] <= t) lo = mid;
      else hi = mid;
    }
    return (c[lo] + ((t - u[lo]) / gaps[lo]) * (c[lo + 1] - c[lo])) * k;
  };
  return { at, capMs: cap, realMs: u[last] - u[0] };
}

/** An event restamped for the cut: its new moment, a fresh `seq`, and a queue time on the same clock. */
function restamp(ev: Ev, ts: number, seq: number, clock: (t: number) => number): Ev {
  if (ev.kind !== 'workflowPhase') return { ...ev, ts, seq };
  return {
    ...ev,
    ts,
    seq,
    phases: ev.phases.map((p) => ({
      ...p,
      agents: p.agents.map((a) => (a.queuedAt === undefined ? a : { ...a, queuedAt: Math.round(clock(a.queuedAt)) })),
    })),
  };
}

/**
 * The roster the hub would send with these transcript times: newest first.
 *
 * A tie goes to the lead. Two sessions written on the same millisecond of the cut are an artifact
 * of rounding it, and the hub's own order for them was decided by when the recorder happened to
 * copy the files — neither is anything a viewer should see the tabs rearranged over.
 */
function rosterRows(rows: readonly SessionSummary[], mtime: ReadonlyMap<string, number>, lead: string): SessionSummary[] {
  return rows
    .map((row, i) => ({ row: { ...row, mtime: mtime.get(row.sessionId) ?? row.mtime }, i: row.sessionId === lead ? -1 : i }))
    .sort((a, b) => b.row.mtime - a.row.mtime || a.i - b.i)
    .map(({ row }) => row);
}

/**
 * The take, as the frames a live hub would have sent over it.
 *
 * Everything at or before the lead's first moment is the backlog — what was already on disk when
 * the page connected — and arrives in the opening burst, each session framed the way `attach`
 * frames it: `reset`, `sessionSeen`, the lines, `ready`. The rest arrives one frame at a time, each
 * at its own moment. A `roster` follows on the hub's tick whenever a main transcript has moved,
 * because its `mtime` is what the picker's "4s ago" and the tabs' order are read from.
 *
 * Ordered by when each line was written, and restamped with fresh `seq`s in that order: the hub
 * replays a finished session file by file, so its arrival order puts every child's whole run after
 * its parent's — the orchestrator would thank people for work they had not started.
 */
export function cut(take: Take, o: CutOptions): Cut {
  const lead = take.sessions.find((s) => s.sessionId === o.lead);
  if (!lead) throw new Error(`timelapse: the take has no session ${o.lead}`);
  const when = whenOf(take.sessions.flatMap((s) => s.evs));
  const clock = compressedClock(
    lead.evs.map(when).filter((t): t is number => t !== null),
    o.playMs,
    o.beatMs,
  );

  type Placed = { ev: Ev; at: number; n: number };
  const placed: Placed[] = [];
  const seen = new Map<string, Ev>();
  let n = 0;
  for (const s of take.sessions) {
    for (const ev of s.evs) {
      const t = when(ev);
      if (t === null) {
        if (ev.kind === 'sessionSeen') seen.set(ev.sessionId, ev);
        continue;
      }
      placed.push({ ev, at: clock.at(t), n: n++ });
    }
  }
  // Rounded after sorting, and rounding never reorders: it keeps the file small, not the order.
  placed.sort((a, b) => a.at - b.at || a.n - b.n);
  for (const p of placed) p.at = Math.round(p.at);

  const sessionOf = (ev: Ev): string => ('ref' in ev ? ev.ref.sessionId : ev.sessionId);
  const wroteMain = (ev: Ev): boolean => 'ref' in ev && ev.ref.agentId === MAIN;

  // A session whose main transcript says nothing before the take is dated as old as the oldest
  // line on disk, never with the hub's own reading of the file: that is the recording machine's
  // clock, and it would put the session months ahead of everything else in the roster.
  const opening = placed.length > 0 ? Math.min(0, placed[0].at) : 0;
  const mtime = new Map<string, number>(take.hello.sessions.map((row) => [row.sessionId, opening]));
  const backlog = new Map<string, Placed[]>();
  const live: Placed[] = [];
  let leadEnd = 0;
  for (const p of placed) {
    const id = sessionOf(p.ev);
    if (id === o.lead) leadEnd = Math.max(leadEnd, p.at);
    if (p.at > 0) {
      live.push(p);
      continue;
    }
    const list = backlog.get(id) ?? [];
    list.push(p);
    backlog.set(id, list);
    if (wroteMain(p.ev)) mtime.set(id, Math.max(mtime.get(id) ?? opening, p.at));
  }

  const frames: CutFrame[] = [];
  let seq = 0;
  const hello: HelloMsg = { ...take.hello, root: o.root, sessions: rosterRows(take.hello.sessions, mtime, o.lead) };
  frames.push([0, hello]);
  const taken = new Set(take.sessions.map((s) => s.sessionId));
  // In roster order, which is the order the hub's live sweep attaches them in.
  for (const row of hello.sessions) {
    if (!taken.has(row.sessionId)) continue;
    const id = row.sessionId;
    const reset: ResetMsg = { kind: 'reset', sessionId: id, reason: 'replay' };
    frames.push([0, reset]);
    let replayed = 0;
    const attached = seen.get(id);
    if (attached) {
      frames.push([0, restamp(attached, 0, ++seq, clock.at)]);
      replayed += 1;
    }
    for (const p of backlog.get(id) ?? []) {
      frames.push([0, restamp(p.ev, p.at, ++seq, clock.at)]);
      replayed += 1;
    }
    const ready: ReadyMsg = { kind: 'ready', sessionId: id, replayed };
    frames.push([0, ready]);
  }

  const lastAt = live.length > 0 ? live[live.length - 1].at : 0;
  const span = lastAt + o.tailMs;
  let sent = new Map(mtime);
  let tick = o.rosterMs;
  const rosterDue = (upTo: number): void => {
    for (; tick <= upTo; tick += o.rosterMs) {
      if ([...mtime].every(([id, t]) => sent.get(id) === t)) continue;
      const roster: RosterMsg = { kind: 'roster', sessions: rosterRows(take.hello.sessions, mtime, o.lead) };
      frames.push([tick, roster]);
      sent = new Map(mtime);
    }
  };
  for (const p of live) {
    // A tick reports what had been written by the moment it fell, so every tick before this frame's
    // moment goes out ahead of it, and one landing on the same millisecond goes out after it.
    rosterDue(p.at - 1);
    frames.push([p.at, restamp(p.ev, p.at, ++seq, clock.at)]);
    if (wroteMain(p.ev)) mtime.set(sessionOf(p.ev), p.at);
  }
  rosterDue(span);

  return { span, realMs: clock.realMs, playMs: leadEnd, capMs: clock.capMs, frames };
}
