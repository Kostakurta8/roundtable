/**
 * `--gif`: one session, as a looping timelapse of the office, written to a file you can post.
 *
 * The office already rebuilds any second of a session exactly — `Replay` winds the same engine over
 * the same commands — and `scripts/pixpreview.ts` already paints the room without a browser. So
 * this adds no second renderer and no second reading of the transcripts. The events come from the
 * hub itself, started in-process on a loopback port nobody else is told about and followed by a
 * socket exactly as the page follows it; the frames come from the same `Scene` the page draws with,
 * into the same software canvas the visual-regression tests hash. A clip is what the page would
 * have shown, sped up.
 *
 * **Time is compressed, not sampled.** A real session is mostly waiting — a nine-minute build, a
 * long think — and a timelapse that kept those gaps would be a still photograph with a few seconds
 * of movement in it. Every silence between two events is clamped to a short beat first, and only
 * then is the whole thing sped up to fit the clip. The wall clock in the room still shows the real
 * time, so the compression is visible rather than hidden: the clock jumps where the session waited.
 *
 * **Nothing is written except the file you asked for.** The hub it starts is read-only in the same
 * way the app's is — that is the same code — and it binds loopback on a port chosen here and closed
 * before this returns.
 */
import { createServer } from 'node:net';
import { WebSocket } from 'ws';
import { isEv, type Ev } from '../shared/events';
import type { ServerMsg, SessionSummary } from '../shared/protocol';
import { Replay, type Entry } from '../src/office/replay';
import { mapEvent, type Cmd } from '../src/office/mapping';
import type { ActorState } from '../src/office/engine';
import { drawText, PAL, PIX, textWidth } from '../src/office/pixel/art';
import { Scene, type Ghost, type SceneAgent } from '../src/office/pixel/scene';
import { agentLook, initialState, reduce, turnCount, type RtState } from '../src/store';
import { asCtx, SoftCtx } from '../scripts/pixpreview';
import { encodeGif, packRgb, type RgbFrame } from './gif';
import { startServer } from './hub';

export type ClipOptions = {
  /** The longest the clip may run, in seconds, before the hold on the last frame. */
  seconds: number;
  /** Frames per second. The GIF format counts in hundredths, so this is rounded to one. */
  fps: number;
  /** Integer upscale of the 480x270 room. 2 is 960 wide, which every feed shows sharp. */
  scale: number;
  /**
   * Draw the room without any text that came from the transcripts: no task on the whiteboard, no
   * names over the desks, no speech. People still arrive, work, hand things over and leave, so the
   * shape of the run survives — and nothing that was typed into it does.
   */
  bare: boolean;
  /**
   * Play the whole session, however long, rather than its busiest stretch. A day-long session at
   * twenty seconds is a blur; this is for when the blur is the point.
   */
  full: boolean;
};

export const CLIP_DEFAULTS: ClipOptions = { seconds: 20, fps: 12.5, scale: 2, bare: false, full: false };

/** Hard limits, so a typo in a flag cannot ask for a clip nobody's machine can hold. */
export const CLIP_MAX_SECONDS = 60;
export const CLIP_MAX_SCALE = 4;

/**
 * The longest silence a clip keeps between two events, before any speed-up.
 *
 * Long enough for a walk across the room to finish and a bubble to be read; the rest of a wait is
 * the part a timelapse exists to cut. Tightened automatically for a session too busy for it — see
 * `timeline`.
 */
const GAP_CAPS_MS = [2500, 1500, 900, 500, 250, 120] as const;

/**
 * The tightest cut a clip takes before it stops shortening the session and picks a stretch of it
 * instead. Below about half a second between events a hand-over walk no longer finishes before the
 * next thing happens, and the room stops reading as people doing things.
 */
const WINDOW_BELOW_CAP_MS = 500;

/** Shown before the busiest stretch starts, so the clip opens on the room just before it fills. */
const WINDOW_LEAD_MS = 2000;

/**
 * How much faster than the compressed session a clip may play before the gaps are cut harder
 * instead. Past about this, a walk across the floor is two frames and people appear to teleport.
 */
const MAX_SPEED = 8;

/** Played after the last event at the same speed, so the last agents can finish walking out. */
const TAIL_MS = 6000;

/** How long the final frame holds before the loop starts over, in hundredths of a second. */
const HOLD_LAST_CS = 250;

/** The strip under the room that says what this is and where it came from. */
const BAR_H = 11;

export const REPO_LINE = 'github.com/Kostakurta8/roundtable';

// --------------------------------------------------------------- collecting a session

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

export type Collected = {
  session: SessionSummary;
  /** Every session the hub could see, newest first — for saying what else could have been picked. */
  sessions: SessionSummary[];
  evs: Ev[];
};

/**
 * After the backlog's `ready`, how long to keep listening for the events the hub derives on its
 * own schedule rather than off a line — chiefly an agent the transcript never says has stopped,
 * which the hub's rescan declares finished from the file's own mtime.
 */
const SETTLE_AFTER_READY_MS = 1500;

/** A hard ceiling on the whole read, so a hub that never says `ready` cannot hang the command. */
const COLLECT_TIMEOUT_MS = 120_000;

/** `pick` is a session id, or a prefix of one; absent means the most recently written session. */
export async function collectSession(root: string, pick?: string): Promise<Collected> {
  const port = await freePort();
  const stop = await startServer(root, port, {
    // The whole session, not the page's rolling window: a clip of the last four thousand events of
    // a long run would start in the middle of it with people already at their desks.
    backlogLimit: 5_000_000,
    onError: () => {},
  });
  try {
    return await new Promise<Collected>((resolve, reject) => {
      const sock = new WebSocket(`ws://127.0.0.1:${port}/ws`);
      const evs: Ev[] = [];
      let chosen: SessionSummary | null = null;
      let all: SessionSummary[] = [];
      let settle: NodeJS.Timeout | null = null;
      const fail = (err: Error): void => {
        clearTimeout(timer);
        if (settle) clearTimeout(settle);
        sock.terminate();
        reject(err);
      };
      const timer = setTimeout(() => fail(new Error('the observer did not finish reading the session in time')), COLLECT_TIMEOUT_MS);
      const finish = (): void => {
        clearTimeout(timer);
        sock.close();
        resolve({ session: chosen!, sessions: all, evs });
      };

      sock.on('error', (err) => fail(err));
      sock.on('message', (data) => {
        let msg: unknown;
        try {
          msg = JSON.parse(String(data));
        } catch {
          return;
        }
        if (isEv(msg)) {
          if (chosen && evSessionOf(msg) === chosen.sessionId) evs.push(msg);
          return;
        }
        const m = msg as ServerMsg;
        if (m.kind === 'hello') {
          all = [...m.sessions].sort((a, b) => b.mtime - a.mtime);
          const found = pick ? all.find((s) => s.sessionId === pick) ?? all.find((s) => s.sessionId.startsWith(pick)) : all[0];
          if (!found) {
            fail(new Error(pick ? `no session starting with "${pick}" under ${m.root}` : `no Claude Code sessions under ${m.root}`));
            return;
          }
          chosen = found;
          sock.send(JSON.stringify({ cmd: 'follow', sessionId: found.sessionId }));
          return;
        }
        if (m.kind === 'reset' && chosen && m.sessionId === chosen.sessionId) {
          evs.length = 0; // a replay is about to start from the top; anything before it is stale
          return;
        }
        if (m.kind === 'ready' && chosen && m.sessionId === chosen.sessionId) {
          if (settle) clearTimeout(settle);
          settle = setTimeout(finish, SETTLE_AFTER_READY_MS);
        }
      });
    });
  } finally {
    await stop();
  }
}

const evSessionOf = (ev: Ev): string => ('ref' in ev ? ev.ref.sessionId : ev.sessionId);

// --------------------------------------------------------------- the timeline

/** One event, where it falls on the clip's compressed clock and when it really happened. */
type Beat = { at: number; real: number; ev: Ev; cmds: Cmd[] };

type Timeline = {
  beats: Beat[];
  compressedMs: number;
  realMs: number;
  /** The stretch of the compressed clock the clip plays. The whole of it unless it was too busy. */
  from: number;
  to: number;
  /** True when `from`..`to` is a stretch rather than the whole session. */
  windowed: boolean;
};

/** Events on a compressed clock, with every silence clamped to `cap`. */
function compress(sorted: readonly Ev[], cmdsOf: readonly Cmd[][], cap: number): { beats: Beat[]; total: number } {
  const beats: Beat[] = [];
  let at = 0;
  let prev = sorted.length > 0 ? sorted[0].ts : 0;
  for (let i = 0; i < sorted.length; i++) {
    const ev = sorted[i];
    at += Math.min(cap, Math.max(0, ev.ts - prev));
    prev = Math.max(prev, ev.ts);
    beats.push({ at, real: ev.ts, ev, cmds: cmdsOf[i] });
  }
  return { beats, total: at };
}

/**
 * How much a single event is worth to a viewer, for finding the stretch worth watching. People
 * arriving and leaving are what the room is for; a token count moving is invisible.
 */
const weightOf = (ev: Ev): number =>
  ev.kind === 'agentSpawn' ? 12 : ev.kind === 'agentDone' ? 6 : ev.kind === 'fileEdit' ? 2 : ev.kind === 'usage' ? 0 : 1;

/** Where the `span`-long stretch of `beats` with the most going on in it starts, by `weightOf`. */
function busiest(beats: readonly Beat[], span: number): number {
  let best = -1;
  let from = 0;
  let lo = 0;
  let sum = 0;
  for (let hi = 0; hi < beats.length; hi++) {
    sum += weightOf(beats[hi].ev);
    while (beats[hi].at - beats[lo].at > span) {
      sum -= weightOf(beats[lo].ev);
      lo++;
    }
    if (sum > best) {
      best = sum;
      from = beats[lo].at;
    }
  }
  return from;
}

/**
 * The session's events on a compressed clock, and the stretch of it worth playing.
 *
 * Ordered by their own timestamps, stably, and restamped with a fresh `seq`: the hub delivers each
 * file's backlog as a batch, so arrival order puts every child's whole run after its parent's, and
 * a clip in arrival order would show the orchestrator finishing before anybody it hired had
 * started. For a live page arrival order is the only safe order; for a finished session read
 * whole, the clock every line was stamped with is the better one.
 *
 * The silences are cut progressively harder until the session fits the clip at `MAX_SPEED`. A
 * session that still does not fit once the cut reaches `WINDOW_BELOW_CAP_MS` is too long to
 * watch whole, and the clip becomes its busiest stretch instead — unless `full` asks for all of it.
 */
function timeline(evs: readonly Ev[], maxClipMs: number, full: boolean): Timeline {
  // Two kinds of event carry the hub's clock rather than a transcript's: `sessionSeen`, stamped
  // when the hub started streaming, and the `agentSeen` a sidecar produces, stamped when the hub
  // read it. Sorted by those stamps they land at the moment this command ran — after every line of
  // a session that finished last week — and every name in the room arrived after its owner had
  // gone home. Each is pinned instead to the first line its agent actually wrote.
  const firstOf = new Map<string, number>();
  for (const ev of evs) {
    if (ev.kind === 'agentSeen' || ev.kind === 'sessionSeen' || !('ref' in ev)) continue;
    const was = firstOf.get(ev.ref.agentId);
    if (was === undefined || ev.ts < was) firstOf.set(ev.ref.agentId, ev.ts);
  }
  const whenOf = (ev: Ev): number =>
    ev.kind === 'sessionSeen'
      ? Number.NEGATIVE_INFINITY
      : ev.kind === 'agentSeen'
        ? Math.min(ev.ts, firstOf.get(ev.ref.agentId) ?? ev.ts)
        : ev.ts;
  const sorted = evs
    .map((ev, i) => ({ ev, i, when: whenOf(ev) }))
    .filter(({ ev }) => Number.isFinite(ev.ts) && ev.ts > 0)
    .sort((a, b) => a.when - b.when || a.i - b.i)
    .map(({ ev, when }, i) => ({ ...ev, ts: Number.isFinite(when) ? when : ev.ts, seq: i + 1 }) as Ev);
  // `sessionSeen` sorts first but keeps its own stamp; it moves nothing in the room, and giving it
  // the first line's time instead is what keeps it from opening the clock at the wrong moment.
  if (sorted.length > 1 && sorted[0].kind === 'sessionSeen') sorted[0] = { ...sorted[0], ts: sorted[1].ts } as Ev;

  const roster = new Set<string>();
  const cmdsOf = sorted.map((ev) => {
    const cmds = mapEvent(ev, roster);
    for (const c of cmds) roster.add(c.agentId);
    return cmds;
  });

  const realMs = sorted.length > 1 ? sorted[sorted.length - 1].ts - sorted[0].ts : 0;
  const budget = MAX_SPEED * maxClipMs;
  let got = compress(sorted, cmdsOf, GAP_CAPS_MS[0]);
  for (const cap of GAP_CAPS_MS) {
    if (!full && cap < WINDOW_BELOW_CAP_MS) break;
    got = compress(sorted, cmdsOf, cap);
    if (got.total <= budget) break;
  }
  const { beats, total } = got;
  if (full || total <= budget) return { beats, compressedMs: total, realMs, from: 0, to: total, windowed: false };

  const from = Math.max(0, busiest(beats, budget - WINDOW_LEAD_MS) - WINDOW_LEAD_MS);
  return { beats, compressedMs: total, realMs, from, to: Math.min(total, from + budget), windowed: true };
}

/** The transcript time a point on the compressed clock stands for. */
function realAt(beats: readonly Beat[], at: number): number {
  if (beats.length === 0) return 0;
  let lo = 0;
  let hi = beats.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (beats[mid].at <= at) lo = mid;
    else hi = mid - 1;
  }
  return beats[lo].real + Math.max(0, at - beats[lo].at);
}

// --------------------------------------------------------------- the caption

const clockText = (ms: number): string => {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const two = (n: number): string => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${two(m)}:${two(sec)}` : `${m}:${two(sec)}`;
};

const tokText = (n: number): string =>
  n >= 1e9 ? `${(n / 1e9).toFixed(1)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}K` : String(n);

/** The strip under the room: what it is, how far into the session this frame is, where it came from. */
function drawBar(ctx: CanvasRenderingContext2D, y: number, parts: { elapsed: number; agents: number; tokens: number }): void {
  ctx.globalAlpha = 1;
  ctx.fillStyle = PAL.out;
  ctx.fillRect(0, y, PIX.w, BAR_H);
  ctx.fillStyle = PAL.ou2;
  ctx.fillRect(0, y, PIX.w, 1);
  const ty = y + 3;
  let x = 5;
  drawText(ctx, 'ROUNDTABLE', x, ty, PAL.acc);
  x += textWidth('ROUNDTABLE') + 8;
  const stats = [`T+${clockText(parts.elapsed)}`, `${parts.agents} ${parts.agents === 1 ? 'AGENT' : 'AGENTS'}`, `${tokText(parts.tokens)} TOK`];
  for (const s of stats) {
    drawText(ctx, s, x, ty, PAL.wht);
    x += textWidth(s) + 8;
  }
  drawText(ctx, REPO_LINE, PIX.w - 5 - textWidth(REPO_LINE), ty, PAL.gry);
}

// --------------------------------------------------------------- rendering

export type ClipResult = {
  gif: Buffer;
  frames: number;
  width: number;
  height: number;
  /** Agents that appeared in the session, the orchestrator included. */
  agents: number;
  tokens: number;
  /** From the first event to the last, as the transcripts stamped them. */
  realMs: number;
  /** How long the clip plays for, before its hold. */
  clipMs: number;
  speed: number;
  /** When the stretch shown starts and ends, as epoch ms off the transcripts. */
  shownFrom: number;
  shownTo: number;
  /** True when the clip is the session's busiest stretch rather than all of it. */
  windowed: boolean;
};

/** Text from a transcript, or nothing, depending on whether the clip is `bare`. */
const scrub = (a: ActorState): ActorState => ({
  ...a,
  say: a.say === undefined ? undefined : '...',
  think: a.think === undefined ? undefined : '...',
  status: '',
  target: undefined,
  edit: undefined,
  heard: undefined,
  link: a.link ? { child: a.link.child, label: '' } : undefined,
});

/** The clip before it is encoded: every frame, packed, at the room's own size. */
export type ClipFrames = Omit<ClipResult, 'gif' | 'width' | 'height' | 'frames'> & {
  frames: RgbFrame[];
  width: number;
  height: number;
  delayCs: number;
  scale: number;
};

export function renderClip(evs: readonly Ev[], opts: ClipOptions = CLIP_DEFAULTS): ClipResult {
  const c = clipFrames(evs, opts);
  const gif = encodeGif({
    width: c.width,
    height: c.height,
    frames: c.frames,
    delayCs: c.delayCs,
    holdLastCs: HOLD_LAST_CS,
    scale: c.scale,
  });
  return { ...c, gif, frames: c.frames.length, width: c.width * c.scale, height: c.height * c.scale };
}

export function clipFrames(evs: readonly Ev[], opts: ClipOptions = CLIP_DEFAULTS): ClipFrames {
  const fps = Math.min(50, Math.max(2, opts.fps));
  const delayCs = Math.max(2, Math.round(100 / fps));
  const frameMs = delayCs * 10;
  const scale = Math.min(CLIP_MAX_SCALE, Math.max(1, Math.round(opts.scale)));
  const maxClipMs = Math.min(CLIP_MAX_SECONDS, Math.max(3, opts.seconds)) * 1000;

  const { beats, compressedMs, realMs, from, to, windowed } = timeline(evs, maxClipMs, opts.full);
  const entries: Entry[] = [];
  for (const b of beats) for (const cmd of b.cmds) entries.push({ ts: b.at, cmd });

  // Played at 1x when it fits, faster when it does not — and never slower than real time. The tail
  // is only owed when the clip reaches the session's end: a stretch cut from the middle stops
  // where it stops, mid-stride, which is what a stretch is.
  const speed = Math.max(1, (to - from) / maxClipMs);
  const step = frameMs * speed;
  const end = to >= compressedMs ? compressedMs + TAIL_MS : to;
  const total = Math.ceil((end - from) / step) + 1;

  const replay = new Replay(entries);
  const scene = new Scene();
  const room = new SoftCtx(PIX.w, PIX.h + BAR_H);
  const ctx = asCtx(room);
  const frames: RgbFrame[] = [];

  let state: RtState = initialState;
  let folded = 0;
  const seen = new Set<string>();
  const t0 = beats.length > 0 ? beats[0].real : 0;
  // Numbered in order of first appearance, so a bare clip's names hold still from frame to frame.
  const anon = new Map<string, string>();
  const anonName = (id: string): string => {
    if (id === 'main') return 'main';
    let name = anon.get(id);
    if (!name) {
      name = `agent ${anon.size + 1}`;
      anon.set(id, name);
    }
    return name;
  };

  for (let f = 0; f < total; f++) {
    const at = Math.min(end, from + f * step);
    const actors = replay.seek(at);
    while (folded < beats.length && beats[folded].at <= at) {
      state = reduce(state, beats[folded].ev);
      for (const c of beats[folded].cmds) seen.add(c.agentId);
      folded++;
    }
    const lastReal = folded > 0 ? beats[folded - 1].real + Math.max(0, at - beats[folded - 1].at) : t0;

    const agents: Record<string, SceneAgent> = {};
    for (const a of actors) {
      const meta = state.agents[a.id];
      agents[a.id] = {
        label: opts.bare ? anonName(a.id) : meta?.label ?? a.id,
        look: agentLook(a.id),
        status: opts.bare ? '' : a.status,
        errored: (meta?.errors ?? 0) > 0,
        tokens: meta?.tokens ?? 0,
      };
    }
    const ghosts: Ghost[] = replay.offsite().map((id) => ({
      id,
      label: opts.bare ? anonName(id) : state.agents[id]?.label ?? id,
      look: agentLook(id),
      busy: (state.agents[id]?.activeTools ?? 0) > 0,
      done: state.agents[id]?.phase === 'done',
    }));

    scene.draw(ctx, {
      actors: opts.bare ? actors.map(scrub) : actors,
      agents,
      task: opts.bare ? '' : state.task ?? '',
      turns: turnCount(state),
      selected: null,
      ghosts,
      night: 0,
      spend: Math.min(1, Math.max(0, state.cost / 25)),
      dt: frameMs,
      clockMs: lastReal,
    });
    drawBar(ctx, PIX.h, { elapsed: lastReal - t0, agents: seen.size, tokens: state.totalTok });
    frames.push(packRgb(room.data));
  }

  return {
    frames,
    width: room.width,
    height: room.height,
    delayCs,
    scale,
    agents: seen.size,
    tokens: state.totalTok,
    realMs,
    clipMs: frames.length * frameMs,
    speed,
    shownFrom: realAt(beats, from),
    shownTo: realAt(beats, Math.min(to, compressedMs)),
    windowed,
  };
}
