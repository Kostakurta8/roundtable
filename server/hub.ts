/**
 * Roundtable observer hub.
 *
 * Watches the Claude Code transcript files of the session a client asked to follow, turns every
 * new line into typed events and broadcasts them over a localhost-only WebSocket. Everything
 * under `root` is opened read-only — the hub never writes there, and that is a property worth
 * keeping: it is watching the user's private transcripts.
 *
 * Protocol
 *   server → client  `hello` (roster + observed root) on connect; `roster` whenever it changes;
 *                    `backlogTruncated` before a replay that lost events; `notice` when this
 *                    session's tail is incomplete; `reset` when a rewound transcript has
 *                    invalidated everything already sent; `ready` when a replay finishes; then
 *                    one JSON-encoded `Ev` per frame for the followed session.
 *                    Control frames carry no `seq`, so `isEv` never mistakes one for an event.
 *   client → server  `{"cmd":"follow","sessionId":"<id from hello>"}` / `{"cmd":"unfollow"}`.
 *                    Anything else (bad JSON, unknown command, unknown session id) is ignored.
 *
 * Binding to loopback is not on its own a boundary — a browser will happily open a socket to
 * 127.0.0.1 for any page that asks — so the handshake is also gated on `Origin`; see
 * `ALLOWED_ORIGINS`.
 */
import { statSync } from 'node:fs';
import { createServer, type IncomingMessage } from 'node:http';
import { basename, dirname, join, resolve } from 'node:path';
import { watch as chokidarWatch, type FSWatcher } from 'chokidar';
import { WebSocket, WebSocketServer } from 'ws';
import type { AgentMeta, Ev } from '../shared/events';
import type {
  BacklogTruncatedMsg,
  HelloMsg,
  ReadyMsg,
  ResetMsg,
  RosterMsg,
  SessionSummary,
  TailNoticeMsg,
} from '../shared/protocol';
import { Normalizer, nextSeq } from './normalize';
import { parseLine } from './parse';
import {
  agentDirs,
  listSessions,
  readAgentMeta,
  registeredSessions,
  subagentFiles,
  type AgentFile,
} from './sessions';
import { Tailer } from './tail';

// The frame shapes are declared in `shared/protocol.ts` so the client can have them without
// importing this file — which would drag node:fs, chokidar and ws into the browser bundle.
export type * from '../shared/protocol';

/** Shutdown handle. Assignable to `() => void`; returns a promise so callers can await teardown. */
export type StopServer = () => Promise<void>;

export type HubOptions = {
  /** Interface to bind. Defaults to loopback and must stay loopback in production. */
  host?: string;
  /**
   * Watch strategy. Polling is the default on Windows, where fs.watch is the least
   * reliable across drive types; tests pass `{ usePolling: true, interval: 200 }`.
   */
  usePolling?: boolean;
  /** Polling interval in ms (only used when polling). */
  interval?: number;
  /** How many recent events are kept per session to replay to a late follower. */
  backlogLimit?: number;
  /** How often the session roster is re-scanned and pushed to clients. 0 disables the push. */
  rosterMs?: number;
  /**
   * How many read passes one drain round makes before yielding to the event loop. Lowering it
   * makes a catch-up read finer-grained, never incomplete: the round that runs out of passes
   * schedules its own continuation. Defaults to `MAX_DRAIN_PASSES`.
   */
  drainPasses?: number;
  /**
   * Reports watcher and post-listen server failures. The hub stays console-silent, so
   * without this a dead watcher is indistinguishable from an idle session.
   */
  onError?: (err: unknown, ctx: string) => void;
};

const WS_PATH = '/ws';
const JSONL_EXT = '.jsonl';
const AGENT_PREFIX = 'agent-';
const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_INTERVAL = 300;
const DEFAULT_BACKLOG = 4000;
const DEFAULT_ROSTER_MS = 4000;
/** Session dir, then `subagents`, then each `workflows/wf_<id>` — direct children of each only. */
const WATCH_DEPTH = 0;
/**
 * How often a followed session looks for subagent directories that do not exist yet.
 * A subagent can be spawned and run to completion while the parent writes nothing, so the
 * attach cannot wait for main-transcript activity. Armed only while someone is following.
 */
const SUBAGENT_RESCAN_MS = 500;
/**
 * How recently a registered session must have been touched to count as live. The CLI updates its
 * registry entry on activity, but leaves the file behind when it exits, so presence alone proves
 * nothing — a stale entry from a crashed process would otherwise be reported as running forever.
 */
const LIVE_WINDOW_MS = 90_000;
/**
 * Passes a single `pump` will make before yielding. A first read of a long transcript can be tens
 * of megabytes and the tailer hands back one bounded batch per call, so the loop has to run — but
 * it must not run unbounded, or one enormous file would block the event loop until it finished.
 *
 * This is a yield point, not a limit: a round that exhausts it re-queues the same file behind
 * `setImmediate` and carries on next tick, so the tail always reaches the end of the file. The
 * bound is what keeps a 67 MB transcript from starving every other session while it does. Giving
 * up here instead — which is what this used to do — left 22 MB of a real transcript unread with
 * nothing on screen to say so, and a *historical* session never retried, because `armRescan`
 * only re-pumps subagent files.
 */
const MAX_DRAIN_PASSES = 64;
/**
 * How long a session's replay history is kept after its last follower leaves. Long enough that
 * switching away and back in the picker is free; short enough that an afternoon of browsing does
 * not leave every session's backlog resident.
 */
const IDLE_EVICT_MS = 120_000;
/**
 * The most sessions one socket will be streamed at once.
 *
 * The live sweep attaches whatever is running and never detaches it, so an observer left open all
 * day across a long series of sessions would otherwise accumulate one watch, one backlog and one
 * set of normalizers per session it ever saw start. Twelve is far more than the number of Claude
 * Code sessions anybody runs at one time — this machine's registry has never held more than three
 * — and the pinned session is attached by the picker, which the cap does not gate.
 */
const STREAM_CAP = 12;

/**
 * The page origins allowed to open the socket — the observer's own dev server, under either
 * loopback name Vite answers to.
 *
 * Browsers do not apply the same-origin policy to WebSockets: without this check *any* page the
 * user happens to have open could connect to the hub, take the `hello` roster, `follow` a
 * session and read their private transcripts, with no prompt and nothing on screen. The Origin
 * header is the one thing a browser will not let a page lie about, so it is what the gate reads.
 */
const ALLOWED_ORIGINS = new Set([
  'http://localhost:5173',
  'http://127.0.0.1:5173',
  'http://localhost:4173',
  'http://127.0.0.1:4173',
]);

/**
 * An absent Origin is allowed: only browsers send one, so its absence means no web page is
 * behind the request — a CLI, a test, or the app talking to itself. Those already have whatever
 * access to the transcript files the hub could give them, so refusing them buys nothing.
 */
const originAllowed = (origin: string | undefined): boolean =>
  origin === undefined || ALLOWED_ORIGINS.has(origin);

/** Windows paths compare case-insensitively; chokidar echoes whatever casing the FS reports. */
const samePath = (a: string, b: string): boolean =>
  process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false; // absent, or racing a delete
  }
}

/** What the hub knows about one subagent transcript it is tailing. */
type AgentEntry = {
  agentId: string;
  metaFile: string;
  workflowId?: string;
  /** True once the sidecar has been read successfully, so it is not re-read every rescan. */
  metaRead: boolean;
};

/** Per-followed-session watch state. Survives the last follower leaving, minus its watcher. */
type Watch = {
  sessionId: string;
  slug: string;
  mainFile: string;
  sessionDir: string;
  subagentsDir: string;
  watcher: FSWatcher | null;
  /** Directories currently handed to chokidar, so an added one is never added twice. */
  watchedDirs: Set<string>;
  /** Timer looking for subagent directories that do not exist yet; null when not armed. */
  rescan: NodeJS.Timeout | null;
  /** Set after a watcher error forced a rebuild, so a failing watcher can't loop. */
  recreated: boolean;
  /** Rebuilds after a watcher error use polling, the more forgiving backend. */
  forcePolling: boolean;
  /** file path → what we know about that agent's transcript. */
  agents: Map<string, AgentEntry>;
  /** file path → its own Normalizer, so per-file state (agentSeen, model) is not shared. */
  normalizers: Map<string, Normalizer>;
  /**
   * A parent's `Task` tool_use id → the child agent it spawned, once the child's sidecar names
   * it. This is the only link between the two halves of a spawn, and it is what turns the
   * parent's eventual `tool_result` into an honest "that agent finished".
   */
  spawnChild: Map<string, string>;
  /**
   * `Task` results that arrived before we knew which agent they belonged to.
   *
   * The catch-up sweep always drains the main transcript before it reads any sidecar, so on a
   * session that has already run, *every* `tool_result` for a spawn is seen while `spawnChild` is
   * still empty. Dropping them meant no subagent in a replayed session was ever marked finished.
   * Parking them costs one small entry per spawn and makes the join order-independent.
   */
  spawnPending: Map<string, { ok: boolean; ts: number }>;
  /**
   * `tool_use` ids the transcript announced as `Task` calls. Only these may be parked above —
   * every ordinary `Read` or `Bash` also produces a `tool_result`, and parking those would grow
   * a map entry per tool call for the life of the session.
   */
  spawnIds: Set<string>;
  /** Spawn tool ids whose `tool_result` has already been seen, so `agentDone` fires once. */
  spawnDone: Set<string>;
  /** Idle-eviction timer, armed when the last follower leaves. */
  evict: NodeJS.Timeout | null;
  /** Recent events, replayed verbatim to anyone who follows later. */
  backlog: Ev[];
  /** Events the cap pushed out of `backlog`; a late follower is told this count. */
  dropped: number;
  followers: number;
  /**
   * Set from the moment a rewind is seen until the session has been restarted from zero. While
   * it is set nothing publishes, so the `reset` frame cannot be overtaken by an event from the
   * re-read that follows it.
   */
  resetting: boolean;
  /** The scheduled restart, so a torn-down watch cannot be re-pumped after the fact. */
  restart: NodeJS.Immediate | null;
  /** file → agentId for files whose catch-up read has not reached the end yet. */
  behind: Map<string, string>;
  /** The scheduled continuation of an unfinished drain; one per watch, however many files. */
  drain: NodeJS.Immediate | null;
  /** Oversized lines this session's tail stepped over, unparsed. */
  skipped: number;
  /** What the last `notice` broadcast said, so an unchanged one is never sent. */
  noticeSkipped: number;
  noticeBehind: boolean;
};

export async function startServer(root: string, port: number, opts: HubOptions = {}): Promise<StopServer> {
  const host = opts.host ?? DEFAULT_HOST;
  const usePolling = opts.usePolling ?? process.platform === 'win32';
  const interval = opts.interval ?? DEFAULT_INTERVAL;
  const backlogLimit = opts.backlogLimit ?? DEFAULT_BACKLOG;
  const rosterMs = opts.rosterMs ?? DEFAULT_ROSTER_MS;
  const drainPasses = Math.max(1, opts.drainPasses ?? MAX_DRAIN_PASSES);

  const watches = new Map<string, Watch>();

  /**
   * One tailer for every file: it keys byte offsets by path.
   *
   * Both callbacks fire *synchronously from inside* `readNew`, which is inside `pump`'s drain
   * loop — so neither may read a file, publish an event or re-enter the pump. They record what
   * happened and, for a rewind, schedule the recovery for the next tick.
   */
  const tailer = new Tailer(
    (file) => {
      const w = watchOwning(file);
      if (w) beginReset(w, file);
    },
    (file) => {
      const w = watchOwning(file);
      if (!w) return;
      w.skipped += 1;
      syncNotice(w);
    },
  );
  /**
   * Per socket: the session the picker chose. May be a historical one, which is the whole reason
   * it is tracked apart from what is being streamed — a session nobody is running is never
   * attached automatically, and must not be dropped just because it is not live.
   */
  const pinned = new Map<WebSocket, string | null>();
  /**
   * Per socket: every session it is receiving events for — the pin, plus every session that has
   * been seen running since it connected.
   *
   * The observer used to follow exactly one session, and a switch dropped the socket and reset
   * everything. It cannot any more: the room now shows a tab per session with agents working, and
   * a tab whose contents were thrown away the moment you looked at another one would be a
   * screenshot, not an observer.
   */
  const streamed = new Map<WebSocket, Set<string>>();
  const pendingCloses = new Set<Promise<void>>();
  let rosterTimer: NodeJS.Timeout | null = null;
  let lastRosterJson = '';

  /** Hands a failure to the host application; a throwing callback must not take the hub down. */
  function report(err: unknown, ctx: string): void {
    if (!opts.onError) return;
    try {
      opts.onError(err, ctx);
    } catch {
      // the reporter itself failed — nothing sensible left to do here
    }
  }

  // ------------------------------------------------------------- transcripts

  function roster(): SessionSummary[] {
    const registry = registeredSessions(root);
    const now = Date.now();
    return listSessions(root)
      .map(({ sessionId, slug, mtime }): SessionSummary => {
        const reg = registry.get(sessionId);
        // Registered *and* recently touched. Either signal alone lies: the registry file outlives
        // the process that wrote it, and a transcript's mtime says nothing about whether the CLI
        // that produced it is still running.
        const touched = Math.max(mtime, reg?.updatedAt ?? 0);
        const live = reg !== undefined && now - touched < LIVE_WINDOW_MS;
        return {
          sessionId,
          slug,
          mtime,
          live,
          ...(reg?.cwd ? { cwd: reg.cwd } : {}),
          ...(reg?.name ? { name: reg.name } : {}),
          ...(reg?.status ? { status: reg.status } : {}),
        };
      })
      .sort((a, b) => b.mtime - a.mtime); // most recently touched first
  }

  /** Only ids the roster actually reports may reach the filesystem (no client-supplied path parts). */
  const findSession = (sessionId: string): { sessionId: string; slug: string; file: string } | undefined =>
    listSessions(root).find((s) => s.sessionId === sessionId);

  function subagentIdFor(w: Watch, file: string): string | null {
    // Any depth under `subagents/` counts: workflow agents live one directory further down.
    const dir = dirname(file);
    if (!samePath(dir, w.subagentsDir) && !dir.toLowerCase().startsWith(w.subagentsDir.toLowerCase())) {
      return null;
    }
    const name = basename(file);
    if (!name.startsWith(AGENT_PREFIX) || !name.endsWith(JSONL_EXT)) return null; // e.g. *.meta.json
    const id = name.slice(AGENT_PREFIX.length, -JSONL_EXT.length);
    return id.length > 0 ? id : null;
  }

  function normalizerFor(w: Watch, file: string, agentId: string, meta?: AgentMeta): Normalizer {
    let n = w.normalizers.get(file);
    if (!n) {
      n = new Normalizer(w.sessionId, agentId, meta);
      w.normalizers.set(file, n);
    }
    return n;
  }

  /**
   * Events the hub derives from other events rather than reading off a line.
   *
   * A spawn and its completion are recorded in two different files: the parent announces the
   * `Task` call and later records its `tool_result`, while the child writes a whole transcript of
   * its own under a name the parent never mentions. `spawnChild` is the join, and it is populated
   * from the child's sidecar (`parentToolUseId`), so the moment the parent's result lands the hub
   * can say which agent just finished.
   */
  function derive(w: Watch, evs: Ev[]): Ev[] {
    const extra: Ev[] = [];

    const finish = (toolUseId: string, child: string, ok: boolean, ts: number): void => {
      if (w.spawnDone.has(toolUseId)) return;
      w.spawnDone.add(toolUseId);
      w.spawnPending.delete(toolUseId);
      extra.push({
        kind: 'agentDone',
        ref: { sessionId: w.sessionId, agentId: child },
        ok,
        ts,
        seq: nextSeq(),
      });
    };

    for (const ev of evs) {
      if (ev.kind === 'agentSpawn') {
        if (ev.toolUseId) w.spawnIds.add(ev.toolUseId);
        continue;
      }
      if (ev.kind === 'agentSeen' && ev.parentToolUseId) {
        w.spawnChild.set(ev.parentToolUseId, ev.ref.agentId);
        // The sidecar is normally the *second* half to arrive, so the result is usually already
        // parked here — this is the branch that fires for every agent of a session that has
        // finished running before the observer was pointed at it.
        const parked = w.spawnPending.get(ev.parentToolUseId);
        if (parked) finish(ev.parentToolUseId, ev.ref.agentId, parked.ok, parked.ts);
        continue;
      }
      if (ev.kind !== 'toolResult') continue;
      const child = w.spawnChild.get(ev.toolUseId);
      if (child) finish(ev.toolUseId, child, ev.ok, ev.ts);
      else if (w.spawnIds.has(ev.toolUseId) && !w.spawnDone.has(ev.toolUseId)) {
        w.spawnPending.set(ev.toolUseId, { ok: ev.ok, ts: ev.ts });
      }
    }
    return extra;
  }

  // ------------------------------------------------- rewinds and lost bytes

  /** The watch a tailed file belongs to. Paths arrive back exactly as they were handed out. */
  function watchOwning(file: string): Watch | undefined {
    for (const w of watches.values()) {
      if (samePath(w.mainFile, file) || w.agents.has(file) || w.normalizers.has(file)) return w;
    }
    return undefined;
  }

  /**
   * Tells this session's followers how much of its tail is missing, when that changed.
   *
   * A quiet session stays quiet: the last-broadcast values start at "nothing lost", so a session
   * that never skips a line and never falls behind never sends this frame at all. A return *to*
   * quiet is news, though — a follower told `behind` has to be told the catch-up finished, or the
   * banner stays up forever.
   */
  function syncNotice(w: Watch): void {
    const behind = w.behind.size > 0;
    if (w.skipped === w.noticeSkipped && behind === w.noticeBehind) return;
    w.noticeSkipped = w.skipped;
    w.noticeBehind = behind;
    toStreamers(w.sessionId, JSON.stringify(noticeFrame(w)));
  }

  function noticeFrame(w: Watch): TailNoticeMsg {
    return { kind: 'notice', sessionId: w.sessionId, skipped: w.skipped, behind: w.behind.size > 0 };
  }

  /**
   * A rewound transcript invalidates the whole session, not just its own file.
   *
   * The re-read republishes every line with a fresh `seq`, and the client folds by `seq` — so
   * without a `reset` the history it already holds is added to rather than replaced, and the
   * session is counted twice. The rewind is per-file, but the client's store is per-session and
   * cannot selectively drop one agent's contributions, so the honest recovery is session-wide.
   *
   * This runs inside `readNew`, inside `pump`. It therefore only *records* the decision: the
   * frame goes out now (so no event can precede it), and the re-read is scheduled for the next
   * tick, when no drain loop is on the stack to be re-entered.
   */
  function beginReset(w: Watch, file: string): void {
    report(new Error(`transcript rewound: ${file}`), `reset:${w.sessionId}`);
    if (w.resetting) return; // already scheduled — one restart covers every file that rewound
    w.resetting = true;

    // Everything a follower can still be handed goes now, before the frame: a socket that
    // follows during the window must not be replayed a backlog the frame just invalidated.
    w.backlog.length = 0;
    w.dropped = 0;
    w.spawnChild.clear();
    w.spawnPending.clear();
    w.spawnIds.clear();
    w.spawnDone.clear();
    // The re-read encounters the same oversized lines and the same catch-up, and will count them
    // again. The counters go back to zero — but *not* silently, which was the mistake: the client's
    // reset handler drops the session's events, not the notice it is showing, so zeroing the
    // high-water marks here meant the next `syncNotice` compared 0 against 0, found nothing had
    // changed, and never sent the all-clear. A rewind that happened while the tail was behind left
    // "still catching up" on screen for ever, over a hub that had long since caught up.
    w.skipped = 0;
    w.behind.clear();
    w.noticeSkipped = 0;
    w.noticeBehind = false;

    const msg: ResetMsg = { kind: 'reset', sessionId: w.sessionId, reason: 'rewound' };
    toStreamers(w.sessionId, JSON.stringify(msg));
    toStreamers(w.sessionId, JSON.stringify(noticeFrame(w))); // the retraction, said out loud

    if (w.restart) clearImmediate(w.restart);
    w.restart = setImmediate(() => {
      w.restart = null;
      finishReset(w);
    });
  }

  /**
   * The other half of a reset, run one tick later with the drain loop off the stack.
   *
   * The offsets are forgotten *here* rather than in `beginReset` because the `readNew` that
   * reported the rewind was mid-call: it writes its own offset back before it returns, so a
   * `forget` issued from the callback would simply be overwritten.
   */
  function finishReset(w: Watch): void {
    if (!watches.has(w.sessionId)) return; // evicted or shut down while this was queued
    tailer.forget(w.mainFile);
    for (const file of w.agents.keys()) tailer.forget(file);
    w.normalizers.clear();
    // The sidecars must be read again too: a fresh Normalizer is built without meta, so leaving
    // this latched would leave every subagent nameless for the rest of the session.
    for (const entry of w.agents.values()) entry.metaRead = false;
    w.resetting = false;
    pumpSession(w);
  }

  /** Records that a file's catch-up read has more to do, and queues the round that does it. */
  function markBehind(w: Watch, file: string, agentId: string): void {
    w.behind.set(file, agentId);
    syncNotice(w);
    if (w.drain) return; // one continuation covers every file that is behind
    w.drain = setImmediate(() => {
      w.drain = null;
      resumeDrain(w);
    });
  }

  function markCaughtUp(w: Watch, file: string): void {
    if (w.behind.delete(file)) syncNotice(w);
  }

  /**
   * Continues every unfinished drain, one round per tick.
   *
   * Yielding between rounds is the whole point: the bound on `pump` exists so that one enormous
   * transcript cannot stall the sessions being watched alongside it, and a continuation that ran
   * in a tight loop would give that back. `pump` re-arms this if the file is still not drained.
   */
  function resumeDrain(w: Watch): void {
    if (!watches.has(w.sessionId) || w.resetting) return;
    const pending = [...w.behind];
    w.behind.clear();
    for (const [file, agentId] of pending) {
      try {
        pump(w, file, agentId);
      } catch (err) {
        report(err, `drain:${w.sessionId}`);
      }
    }
    syncNotice(w); // a round that finished the last file clears the flag
  }

  /** Reads whatever is new in one file and broadcasts the events it produces. */
  function pump(w: Watch, file: string, agentId: string): void {
    if (w.resetting) return; // the scheduled restart will read this file from zero
    const normalizer = normalizerFor(w, file, agentId);

    // The tailer hands back one bounded batch per call, so catching up on a large file takes
    // several. Bounded, because a single unbounded drain would stall every other session — but
    // the bound only ends this *round*; the tail below queues the next one.
    for (let pass = 0; pass < drainPasses; pass++) {
      const was = tailer.offsetOf(file);
      let lines: string[];
      try {
        lines = tailer.readNew(file);
      } catch {
        markCaughtUp(w, file);
        return; // file vanished or is momentarily unreadable — the next event retries
      }
      // `readNew` may have just reported a rewind, synchronously, from inside that call. What it
      // returned belongs to the new file and the restart will read it again from zero, so it
      // must not be published here — that is the frame-before-event ordering, held.
      if (w.resetting) return;
      if (lines.length === 0) {
        // Empty is not the same as finished. `readNew` also comes back empty when it stepped
        // over an oversized line, and everything after that line is still unread — a drain that
        // stopped here left the rest of the file waiting on the next write, which on a session
        // that had just gone quiet meant forever. The offset is the honest signal: it moves when
        // bytes were consumed and stands still at end of file or mid-line.
        if (tailer.offsetOf(file) === was) {
          markCaughtUp(w, file);
          return;
        }
        continue;
      }

      const evs: Ev[] = [];
      for (const line of lines) {
        try {
          const raw = parseLine(line);
          if (raw) evs.push(...normalizer.feed(raw));
        } catch (err) {
          // schema drift must never take the hub down: drop the line, keep the stream
          report(err, `normalize:${w.sessionId}`);
        }
      }
      // One flush per batch fed. The normalizer bills a streamed response across several lines
      // and only knows a response is finished when the id changes; the end of a batch is the one
      // boundary it cannot see, so waiting for the next batch would defer the last response of
      // every read. It returns [] when nothing is owing, so this is free on a quiet tick.
      evs.push(...normalizer.flush());
      if (evs.length > 0) publish(w, [...evs, ...derive(w, evs)]);
    }

    // Out of passes. Whether that means "incomplete" is a question about the file, not about the
    // loop: the last pass may have drained it exactly, and claiming an unfinished tail then would
    // put a warning on screen that is not true.
    let more = false;
    try {
      more = tailer.offsetOf(file) < statSync(file).size;
    } catch {
      more = false; // unreadable right now; the next filesystem event retries
    }
    if (more) markBehind(w, file, agentId);
    else markCaughtUp(w, file);
  }

  /**
   * One logical file must map to exactly one tailer offset and one Normalizer, so a path
   * that only differs in casing (Windows) is folded onto the key already in use.
   */
  function canonicalAgentFile(w: Watch, abs: string): string {
    if (w.agents.has(abs)) return abs;
    for (const known of w.agents.keys()) if (samePath(known, abs)) return known;
    return abs;
  }

  /**
   * Reads an agent's sidecar and folds it into that agent's normalizer.
   *
   * Worth doing eagerly and worth retrying: the sidecar is what turns `af72b58f0662a3abe` into
   * "Map the office layout", and it is written at spawn time, which can be before or after the
   * first transcript line depending on how the filesystem feels. `metaRead` latches on success
   * so the rescan loop is not re-reading every sidecar twice a second.
   */
  function loadMeta(w: Watch, file: string, entry: AgentEntry): Ev[] {
    if (entry.metaRead) return [];
    const meta = readAgentMeta(entry.metaFile, entry.workflowId);
    if (Object.keys(meta).length === 0) return [];
    entry.metaRead = true;
    return normalizerFor(w, file, entry.agentId).applyMeta(meta);
  }

  /** Adds any subagent directory that has appeared since the watcher was built. */
  function attachDirs(w: Watch): void {
    if (!w.watcher) return;
    for (const dir of agentDirs(root, w.slug, w.sessionId)) {
      const abs = resolve(dir);
      if (w.watchedDirs.has(abs.toLowerCase())) continue;
      w.watchedDirs.add(abs.toLowerCase());
      w.watcher.add(abs);
    }
  }

  /** Attaches new directories, registers newly appeared transcripts and reads what is new in each. */
  function syncSubagents(w: Watch): void {
    attachDirs(w);

    const seen: AgentFile[] = subagentFiles(root, w.slug, w.sessionId);
    for (const { agentId, file, metaFile, workflowId } of seen) {
      const abs = canonicalAgentFile(w, resolve(file));
      if (!w.agents.has(abs)) {
        w.agents.set(abs, { agentId, metaFile: resolve(metaFile), metaRead: false, workflowId });
      }
    }

    for (const [file, entry] of w.agents) {
      const metaEvs = loadMeta(w, file, entry);
      if (metaEvs.length > 0) publish(w, [...metaEvs, ...derive(w, metaEvs)]);
      pump(w, file, entry.agentId);
    }
  }

  /**
   * A subagent can be spawned, run and finish while the parent transcript stays silent, so a
   * followed session polls for new subagent directories on its own.
   */
  function armRescan(w: Watch): void {
    if (w.rescan || !w.watcher) return;
    const timer = setInterval(() => {
      try {
        syncSubagents(w);
      } catch (err) {
        report(err, `rescan:${w.sessionId}`);
      }
    }, SUBAGENT_RESCAN_MS);
    timer.unref(); // never a reason to hold the process open by itself
    w.rescan = timer;
  }

  function disarmRescan(w: Watch): void {
    if (!w.rescan) return;
    clearInterval(w.rescan);
    w.rescan = null;
  }

  /** Catch-up sweep: main transcript plus every known subagent transcript. */
  function pumpSession(w: Watch): void {
    pump(w, w.mainFile, 'main');
    syncSubagents(w);
  }

  function pumpPath(w: Watch, path: string): void {
    const abs = resolve(path);
    if (samePath(abs, w.mainFile)) {
      pump(w, w.mainFile, 'main'); // canonical key, whatever casing the watcher reported
      syncSubagents(w); // a spawn is announced in the main transcript before the agent writes
      return;
    }
    if (abs.endsWith('.meta.json')) {
      syncSubagents(w); // a sidecar landed: pick up the label it carries
      return;
    }
    const file = canonicalAgentFile(w, abs);
    const known = w.agents.get(file);
    const agentId = known?.agentId ?? subagentIdFor(w, file);
    if (!agentId) return; // unrelated file
    if (!known) {
      syncSubagents(w); // discovers it properly, with its sidecar and workflow id
      return;
    }
    pump(w, file, agentId);
  }

  // ---------------------------------------------------------------- watching

  function createWatcher(w: Watch): FSWatcher {
    const paths = [w.mainFile];
    w.watchedDirs = new Set();
    // The session directory itself, so the creation of `subagents/` is seen immediately.
    if (isDir(w.sessionDir)) {
      paths.push(w.sessionDir);
      w.watchedDirs.add(resolve(w.sessionDir).toLowerCase());
    }
    for (const dir of agentDirs(root, w.slug, w.sessionId)) {
      const abs = resolve(dir);
      if (w.watchedDirs.has(abs.toLowerCase())) continue;
      w.watchedDirs.add(abs.toLowerCase());
      paths.push(abs);
    }

    const watcher = chokidarWatch(paths, {
      usePolling: usePolling || w.forcePolling,
      interval,
      depth: WATCH_DEPTH,
      ignoreInitial: true, // the catch-up sweep below does the initial read itself
      persistent: true,
      ignored: (path, stats) =>
        stats?.isFile() === true && !path.endsWith(JSONL_EXT) && !path.endsWith('.meta.json'),
    });
    watcher.on('add', (path) => pumpPath(w, path));
    watcher.on('change', (path) => pumpPath(w, path));
    watcher.on('unlink', (path) => {
      // A transcript that is deleted must not leave its byte offset behind: if a new file appears
      // at the same path, a stale offset would make the tail skip its opening lines.
      const abs = canonicalAgentFile(w, resolve(path));
      tailer.forget(abs);
      w.agents.delete(abs);
      w.normalizers.delete(abs);
      markCaughtUp(w, abs); // a file that is gone is not a catch-up still owed to the user
    });
    watcher.on('addDir', () => syncSubagents(w)); // attaches new dirs and reads them at once
    watcher.on('error', (err) => onWatcherError(w, err));
    // chokidar installs its per-file watchers asynchronously; a line written before that
    // finishes would otherwise wait for the next write, so sweep once more when it is ready.
    watcher.on('ready', () => pumpSession(w));
    return watcher;
  }

  /**
   * A dead watcher would otherwise look exactly like an idle session: report it, then rebuild
   * once on polling (the most forgiving backend). The `recreated` latch stops a rebuild loop.
   */
  function onWatcherError(w: Watch, err: unknown): void {
    report(err, `watch:${w.sessionId}`);
    if (w.recreated || !w.watcher || w.followers === 0) return;
    w.recreated = true;
    w.forcePolling = true;
    closeWatcher(w);
    w.watcher = createWatcher(w);
    pumpSession(w); // anything written while the watcher was down
    armRescan(w);
  }

  function closeWatcher(w: Watch): void {
    const watcher = w.watcher;
    w.watcher = null;
    w.watchedDirs = new Set();
    disarmRescan(w); // the timer only makes sense while a watcher is live
    if (!watcher) return;
    const closing: Promise<void> = watcher
      .close()
      .catch(() => undefined)
      .finally(() => pendingCloses.delete(closing));
    pendingCloses.add(closing);
  }

  /**
   * Drops every trace of a watch, including the tailer offsets keyed by its files.
   *
   * Without this a long-running observer that the user browsed through fifty sessions with would
   * hold fifty backlogs, fifty sets of normalizers and an offset per file, none of it reachable
   * again — the state is only useful to a follower, and there is none.
   */
  function cancelEvict(w: Watch): void {
    if (!w.evict) return;
    clearTimeout(w.evict);
    w.evict = null;
  }

  function forgetWatch(w: Watch): void {
    cancelEvict(w);
    closeWatcher(w);
    // Both immediates capture `w`; left pending they would re-read the files of a watch that is
    // no longer in the map. Each callback re-checks that too, but not arming them is cheaper.
    if (w.restart) clearImmediate(w.restart);
    if (w.drain) clearImmediate(w.drain);
    w.restart = null;
    w.drain = null;
    w.behind.clear();
    tailer.forget(w.mainFile);
    for (const file of w.agents.keys()) tailer.forget(file);
    watches.delete(w.sessionId);
  }

  function ensureWatch(entry: { sessionId: string; slug: string; file: string }): Watch {
    let w = watches.get(entry.sessionId);
    if (!w) {
      const sessionDir = resolve(join(root, 'projects', entry.slug, entry.sessionId));
      w = {
        sessionId: entry.sessionId,
        slug: entry.slug,
        mainFile: resolve(entry.file),
        sessionDir,
        subagentsDir: resolve(join(sessionDir, 'subagents')),
        watcher: null,
        watchedDirs: new Set(),
        rescan: null,
        recreated: false,
        forcePolling: false,
        agents: new Map(),
        normalizers: new Map(),
        spawnChild: new Map(),
        spawnPending: new Map(),
        spawnIds: new Set(),
        spawnDone: new Set(),
        evict: null,
        backlog: [],
        dropped: 0,
        followers: 0,
        resetting: false,
        restart: null,
        behind: new Map(),
        drain: null,
        skipped: 0,
        noticeSkipped: 0,
        noticeBehind: false,
      };
      watches.set(entry.sessionId, w);
      // Ahead of anything read off disk, so it is the first event of this session on the wire and
      // the first in its backlog. A session that is running but has written nothing since the hub
      // attached would otherwise be invisible to a client that only ever hears about sessions
      // through their agents — which is exactly the case the tab strip has to cover.
      // Liveness comes from `roster()` rather than being recomputed here, because the two must
      // agree and recomputing it got it wrong: the registry file's `updatedAt` lags behind the
      // session that is writing it, so a session busy enough to be appending transcript lines
      // every second was reported as not running. `roster()` already takes the later of the
      // registry stamp and the transcript's own mtime, which is the honest reading.
      const summary = roster().find((s) => s.sessionId === entry.sessionId);
      publish(w, [
        {
          kind: 'sessionSeen',
          sessionId: entry.sessionId,
          cwd: summary?.cwd ?? entry.slug,
          live: summary?.live === true,
          ts: Date.now(),
          seq: nextSeq(),
        },
      ]);
    }
    // Watcher first, then the sweep: a write landing in between is caught by the sweep,
    // and one that lands after it is caught by the watcher. No gap either way.
    if (!w.watcher) w.watcher = createWatcher(w);
    pumpSession(w);
    return w;
  }

  // -------------------------------------------------------------- broadcasts

  function sendJson(sock: WebSocket, json: string): void {
    if (sock.readyState !== WebSocket.OPEN) return;
    try {
      sock.send(json);
    } catch {
      // socket died between the check and the write — its 'close' handler cleans up
    }
  }

  /** Sends one already-encoded frame to every socket streaming that session. */
  function toStreamers(sessionId: string, json: string): void {
    for (const [sock, ids] of streamed) {
      if (ids.has(sessionId)) sendJson(sock, json);
    }
  }

  function publish(w: Watch, evs: Ev[]): void {
    // A reset is pending: everything already sent has been declared invalid and the re-read has
    // not started, so an event reaching a follower now would arrive before the history it belongs
    // to. `pump` bails on the same flag; this is the backstop for the paths that do not go
    // through it, such as a sidecar landing mid-window.
    if (w.resetting) return;
    for (const ev of evs) {
      w.backlog.push(ev);
      toStreamers(w.sessionId, JSON.stringify(ev));
    }
    if (w.backlog.length > backlogLimit) {
      // Counted, never silent: the next follower is told how much history it cannot get.
      w.dropped += w.backlog.length - backlogLimit;
      w.backlog.splice(0, w.backlog.length - backlogLimit);
    }
  }

  function broadcastRoster(): void {
    if (streamed.size === 0) return;
    const msg: RosterMsg = { kind: 'roster', sessions: roster() };
    const json = JSON.stringify(msg);
    // Only when something actually changed: this runs on a timer, and a roster nobody has touched
    // is a frame every client would parse and re-render for nothing.
    if (json === lastRosterJson) return;
    lastRosterJson = json;
    for (const sock of streamed.keys()) sendJson(sock, json);
  }

  /** Stops streaming one session to one socket, and starts the idle timer if nobody is left. */
  function detach(sock: WebSocket, sessionId: string): void {
    const ids = streamed.get(sock);
    if (!ids?.delete(sessionId)) return;
    const w = watches.get(sessionId);
    if (!w) return;
    w.followers = Math.max(0, w.followers - 1);
    if (w.followers > 0) return;
    // Keep the watch state (offsets live in the shared tailer, backlog and normalizers here) so a
    // re-attach resumes instead of replaying from zero — only the watcher is released now. But
    // "keep it" cannot mean "forever": a user flicking through twenty sessions in the picker
    // would otherwise leave twenty full backlogs resident, none of them reachable again. The
    // grace window is long enough that flicking back is still free.
    closeWatcher(w);
    cancelEvict(w);
    const timer = setTimeout(() => {
      if (w.followers === 0) forgetWatch(w);
    }, IDLE_EVICT_MS);
    timer.unref();
    w.evict = timer;
  }

  /**
   * Starts streaming one session to one socket: its history first, then everything that follows.
   *
   * Idempotent, which is what lets the live sweep call it on every roster tick without checking
   * anything itself.
   */
  function attach(sock: WebSocket, sessionId: string): void {
    const ids = streamed.get(sock);
    if (!ids) return;
    if (ids.has(sessionId)) {
      // Already streaming it, so there is no replay to send — but the client asked, and silence is
      // not an answer it can act on. It raises its "loading" flag on every `follow` and lowers it
      // only on `ready`, so a tab click for a session the live sweep had already attached — which
      // is the *normal* path the moment two sessions are running — left the top bar reading LOADING
      // for the rest of the connection while events arrived perfectly normally behind it.
      const ready: ReadyMsg = { kind: 'ready', sessionId, replayed: 0 };
      sendJson(sock, JSON.stringify(ready));
      return;
    }
    const entry = findSession(sessionId);
    if (!entry) return; // unknown id: ignored, so no client string ever becomes a path segment

    const w = ensureWatch(entry);
    cancelEvict(w); // it is wanted again; the idle timer must not fire behind this follower
    // The sweep inside `ensureWatch` ran before this socket was registered, so the backlog replay
    // below is its only source of history — no event can reach it twice.
    ids.add(sessionId);
    w.followers += 1;
    armRescan(w); // watch for subagent directories that do not exist yet
    if (w.dropped > 0) {
      const truncated: BacklogTruncatedMsg = { kind: 'backlogTruncated', dropped: w.dropped };
      sendJson(sock, JSON.stringify(truncated)); // ahead of the replay, so the gap is known first
    }
    // Same reasoning, and only when there is something to say: a session whose tail is complete
    // sends nothing, so silence keeps meaning "you are seeing all of it".
    if (w.skipped > 0 || w.behind.size > 0) sendJson(sock, JSON.stringify(noticeFrame(w)));
    // What follows is this session's history from the beginning, so whatever the client holds for
    // it has to go first. Usually it holds nothing and this costs nothing. But a client that
    // switched away long enough for the watch to be evicted and then switched back gets a backlog
    // that was re-read from byte zero, carrying *fresh* `seq` values — higher than the ones it
    // already folded, so its idempotence guard cannot recognize a single one of them, and the
    // session would be counted twice: every message, every token, every dollar. The guard is
    // per-event; this is the one thing that can say "start again".
    const replayReset: ResetMsg = { kind: 'reset', sessionId, reason: 'replay' };
    sendJson(sock, JSON.stringify(replayReset));
    for (const ev of w.backlog) sendJson(sock, JSON.stringify(ev));
    const ready: ReadyMsg = { kind: 'ready', sessionId, replayed: w.backlog.length };
    sendJson(sock, JSON.stringify(ready));
  }

  /**
   * Attaches every session that is currently running, to every connected socket.
   *
   * This is what makes the tab strip possible. The client cannot ask for a session it has never
   * heard of, and a summary computed without reading the transcript could only ever report that a
   * session was *touched* recently — not that anything was working inside it. Tailing what is
   * running is the only source of that answer, so the hub tails it and the client decides what is
   * worth a tab.
   *
   * Only `live` sessions, and a session that stops running is released — except the pinned one,
   * which is the session actually on screen (clicking a tab pins it) and the whole reason the
   * picker exists. Holding on to the rest was the first design and it was wrong: the sweep only
   * ever added, so `STREAM_CAP` became a count of every session the observer had *ever* seen, and
   * after twelve of them a newly started session never appeared again — while twelve finished ones
   * each kept a watcher, a half-second rescan interval and a 4000-event backlog resident.
   */
  function syncLive(sock?: WebSocket): void {
    const all = roster();
    const live = all.filter((s) => s.live);
    const liveIds = new Set(live.map((s) => s.sessionId));
    const socks = sock ? [sock] : [...streamed.keys()];
    for (const s of socks) {
      const ids = streamed.get(s);
      if (!ids) continue;
      // Release first, or the cap becomes a count of every session ever seen rather than of the
      // ones running now. `syncLive` used to only ever add, so leaving the observer open across a
      // day of work filled all twelve slots with sessions that had ended — and the thirteenth
      // session never appeared in the tab strip again, ever. Each of those held a chokidar watcher,
      // a half-second rescan interval and a backlog of up to 4000 events, all unreachable.
      //
      // The pin is exempt: the picker exists precisely to watch a session that is not running.
      const keep = pinned.get(s) ?? null;
      for (const id of [...ids]) {
        if (!liveIds.has(id) && id !== keep) detach(s, id);
      }
      for (const entry of live) {
        if (ids.size >= STREAM_CAP && !ids.has(entry.sessionId)) continue;
        attach(s, entry.sessionId);
      }
    }
  }

  function handleMessage(sock: WebSocket, text: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return; // not JSON — ignore
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return;
    const msg = parsed as Record<string, unknown>; // JSON boundary, narrowed right here
    if (msg.cmd === 'follow' && typeof msg.sessionId === 'string') {
      // The picker's choice. It may be a historical session, which the live sweep will never
      // attach on its own, so it is remembered separately and released only when it changes.
      const was = pinned.get(sock) ?? null;
      if (was === msg.sessionId) return;
      // Checked before anything is given up. `attach` refuses an unknown id, so without this a
      // `follow` naming a transcript that has been deleted or rotated away would still detach the
      // session the viewer was watching and leave the pin naming nothing at all.
      if (!findSession(msg.sessionId)) return;
      pinned.set(sock, msg.sessionId);
      attach(sock, msg.sessionId);
      // The session it replaces keeps streaming if it is running; if it is not, nothing else is
      // holding it and it goes.
      if (was && !roster().some((s) => s.sessionId === was && s.live)) detach(sock, was);
    } else if (msg.cmd === 'unfollow') {
      const was = pinned.get(sock) ?? null;
      pinned.set(sock, null);
      if (was && !roster().some((s) => s.sessionId === was && s.live)) detach(sock, was);
    } else if (msg.cmd === 'rescan') {
      // The same sweep the roster timer runs, on demand. Nothing here is idempotence-sensitive:
      // `attach` returns immediately for a session already streaming, so a viewer holding the
      // button down costs a directory listing per press and nothing else.
      syncLive(sock);
      const fresh: RosterMsg = { kind: 'roster', sessions: roster() };
      // Sent to this socket only, and `lastRosterJson` is deliberately *not* touched: it is the
      // module-wide record of what every socket was last told, and setting it from a one-socket
      // send made one viewer pressing Rescan suppress the next broadcast to everybody else, who
      // would then sit on a stale picker until the roster happened to change again.
      sendJson(sock, JSON.stringify(fresh));
    }
    // every other command is ignored on purpose
  }

  // ------------------------------------------------------------------ server

  const server = createServer((_req, res) => {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('roundtable observer: websocket only\n');
  });
  const wss = new WebSocketServer({
    server,
    path: WS_PATH,
    // Read off the request rather than `info.origin`: ws passes `req.headers.origin` through
    // untouched, so it really is `string | undefined`, while `@types/ws` declares it `string`.
    // The parameter is annotated because `verifyClient` is a union of a sync and an async
    // signature, which gives nothing for TypeScript to infer this callback's shape from.
    // A rejected handshake gets a 401 and is destroyed — no connection, no roster, no events.
    verifyClient: ({ req }: { req: IncomingMessage }) => originAllowed(req.headers.origin),
  });
  // ws mirrors the HTTP server's 'error' onto this emitter, and an EventEmitter with no 'error'
  // listener throws. Without this guard a failed bind rejects *and* crashes the process. The
  // mirrored error is reported once, by the HTTP server's own handler below.
  wss.on('error', () => {});

  wss.on('connection', (sock) => {
    pinned.set(sock, null);
    streamed.set(sock, new Set());
    sock.on('error', () => {}); // ws requires this listener or the process dies on socket errors
    sock.on('close', () => {
      for (const id of [...(streamed.get(sock) ?? [])]) detach(sock, id);
      streamed.delete(sock);
      pinned.delete(sock);
    });
    sock.on('message', (data, isBinary) => {
      if (isBinary) return;
      try {
        handleMessage(sock, data.toString());
      } catch (err) {
        report(err, 'message'); // a malformed message must never break the connection
      }
    });
    const hello: HelloMsg = { kind: 'hello', sessions: roster(), root };
    sendJson(sock, JSON.stringify(hello));
    // Everything running on this machine, straight away: the tab strip is the first thing the
    // user sees, and it cannot wait a roster tick to find out a second session exists.
    try {
      syncLive(sock);
    } catch (err) {
      report(err, 'syncLive');
    }
  });

  await new Promise<void>((resolvePromise, rejectPromise) => {
    const onError = (err: Error): void => {
      server.removeListener('listening', onListening);
      server.close(() => {}); // callback swallows ERR_SERVER_NOT_RUNNING
      rejectPromise(err);
    };
    const onListening = (): void => {
      server.removeListener('error', onError);
      // A late socket error must not crash the observer, but it must not vanish either.
      server.on('error', (err) => report(err, 'server'));
      resolvePromise();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, host); // loopback only: `host` is always passed
  });

  if (rosterMs > 0) {
    rosterTimer = setInterval(() => {
      try {
        broadcastRoster();
        // A session that starts while the observer is open has to appear on its own. This is the
        // only thing that notices one: nothing on disk announces a new session to a process that
        // is not already watching its directory.
        syncLive();
      } catch (err) {
        report(err, 'roster');
      }
    }, rosterMs);
    rosterTimer.unref();
  }

  let stopped = false;
  return async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    if (rosterTimer) clearInterval(rosterTimer);
    for (const w of [...watches.values()]) forgetWatch(w);
    await Promise.all([...pendingCloses]);
    watches.clear();
    streamed.clear();
    pinned.clear();
    for (const sock of wss.clients) sock.terminate();
    await new Promise<void>((res) => wss.close(() => res()));
    server.closeAllConnections();
    await new Promise<void>((res) => server.close(() => res()));
  };
}
