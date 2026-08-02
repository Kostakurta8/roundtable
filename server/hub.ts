/**
 * Roundtable observer hub.
 *
 * Watches the Claude Code transcript files of the session a client asked to follow,
 * turns every new line into typed events and broadcasts them over a localhost-only
 * WebSocket. Everything under `root` is opened read-only — the hub never writes there.
 *
 * Protocol
 *   server → client  `{"kind":"hello","sessions":[{sessionId,slug,mtime},…]}` on connect,
 *                    then one JSON-encoded `Ev` per frame for the followed session.
 *   client → server  `{"cmd":"follow","sessionId":"<id from hello>"}`.
 *                    Anything else (bad JSON, unknown command, unknown session id) is ignored.
 */
import { statSync } from 'node:fs';
import { createServer } from 'node:http';
import { basename, dirname, join, resolve } from 'node:path';
import { watch as chokidarWatch, type FSWatcher } from 'chokidar';
import { WebSocket, WebSocketServer } from 'ws';
import type { Ev } from '../shared/events';
import { Normalizer } from './normalize';
import { parseLine } from './parse';
import { listSessions, subagentFiles } from './sessions';
import { Tailer } from './tail';

export type SessionSummary = { sessionId: string; slug: string; mtime: number };
export type HelloMsg = { kind: 'hello'; sessions: SessionSummary[] };
export type FollowCmd = { cmd: 'follow'; sessionId: string };

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
};

const WS_PATH = '/ws';
const JSONL_EXT = '.jsonl';
const AGENT_PREFIX = 'agent-';
const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_INTERVAL = 300;
const DEFAULT_BACKLOG = 2000;
/** Session dir → `subagents/` → `agent-*.jsonl`: direct children of each watched path only. */
const WATCH_DEPTH = 0;

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

/** Per-followed-session watch state. Survives the last follower leaving, minus its watcher. */
type Watch = {
  sessionId: string;
  slug: string;
  mainFile: string;
  subagentsDir: string;
  watcher: FSWatcher | null;
  subagentsWatched: boolean;
  /** file path → agentId, for every subagent transcript discovered so far. */
  agents: Map<string, string>;
  /** file path → its own Normalizer, so per-file state (agentSeen, model) is not shared. */
  normalizers: Map<string, Normalizer>;
  /** Recent events, replayed verbatim to anyone who follows later. */
  backlog: Ev[];
  followers: number;
};

export async function startServer(root: string, port: number, opts: HubOptions = {}): Promise<StopServer> {
  const host = opts.host ?? DEFAULT_HOST;
  const usePolling = opts.usePolling ?? process.platform === 'win32';
  const interval = opts.interval ?? DEFAULT_INTERVAL;
  const backlogLimit = opts.backlogLimit ?? DEFAULT_BACKLOG;

  const tailer = new Tailer(); // one tailer for every file: it keys byte offsets by path
  const watches = new Map<string, Watch>();
  const followed = new Map<WebSocket, string | null>();
  const pendingCloses = new Set<Promise<void>>();

  // ------------------------------------------------------------- transcripts

  const roster = (): SessionSummary[] =>
    listSessions(root)
      .map(({ sessionId, slug, mtime }) => ({ sessionId, slug, mtime }))
      .sort((a, b) => b.mtime - a.mtime); // most recently touched first

  /** Only ids the roster actually reports may reach the filesystem (no client-supplied path parts). */
  const findSession = (sessionId: string): { sessionId: string; slug: string; file: string } | undefined =>
    listSessions(root).find((s) => s.sessionId === sessionId);

  function subagentIdFor(w: Watch, file: string): string | null {
    if (!samePath(dirname(file), w.subagentsDir)) return null;
    const name = basename(file);
    if (!name.startsWith(AGENT_PREFIX) || !name.endsWith(JSONL_EXT)) return null; // e.g. *.meta.json
    const id = name.slice(AGENT_PREFIX.length, -JSONL_EXT.length);
    return id.length > 0 ? id : null;
  }

  /** Reads whatever is new in one file and broadcasts the events it produces. */
  function pump(w: Watch, file: string, agentId: string): void {
    let lines: string[];
    try {
      lines = tailer.readNew(file);
    } catch {
      return; // file vanished or is momentarily unreadable — the next event retries
    }
    if (lines.length === 0) return;

    let normalizer = w.normalizers.get(file);
    if (!normalizer) {
      normalizer = new Normalizer(w.sessionId, agentId);
      w.normalizers.set(file, normalizer);
    }

    const evs: Ev[] = [];
    for (const line of lines) {
      try {
        const raw = parseLine(line);
        if (raw) evs.push(...normalizer.feed(raw));
      } catch {
        // schema drift must never take the hub down: drop the line, keep the stream
      }
    }
    if (evs.length > 0) publish(w, evs);
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

  /** Registers subagent transcripts that appeared since the last look. */
  function discoverSubagents(w: Watch): void {
    for (const { agentId, file } of subagentFiles(root, w.slug, w.sessionId)) {
      const abs = canonicalAgentFile(w, resolve(file));
      if (!w.agents.has(abs)) w.agents.set(abs, agentId);
    }
    // The directory is created only once a session actually spawns agents, so it is
    // watched lazily instead of handing chokidar a path that does not exist yet.
    if (!w.subagentsWatched && w.watcher && isDir(w.subagentsDir)) {
      w.watcher.add(w.subagentsDir);
      w.subagentsWatched = true;
    }
  }

  /** Catch-up sweep: main transcript plus every known subagent transcript. */
  function pumpSession(w: Watch): void {
    pump(w, w.mainFile, 'main');
    discoverSubagents(w);
    for (const [file, agentId] of w.agents) pump(w, file, agentId);
  }

  function pumpPath(w: Watch, path: string): void {
    const abs = resolve(path);
    if (samePath(abs, w.mainFile)) {
      pump(w, w.mainFile, 'main'); // canonical key, whatever casing the watcher reported
      discoverSubagents(w); // a spawn is always announced in the main transcript first
      for (const [file, agentId] of w.agents) pump(w, file, agentId);
      return;
    }
    const file = canonicalAgentFile(w, abs);
    const agentId = w.agents.get(file) ?? subagentIdFor(w, file);
    if (!agentId) return; // unrelated file (e.g. a .meta.json sidecar)
    w.agents.set(file, agentId);
    pump(w, file, agentId);
  }

  // ---------------------------------------------------------------- watching

  function createWatcher(w: Watch): FSWatcher {
    const paths = [w.mainFile];
    w.subagentsWatched = isDir(w.subagentsDir);
    if (w.subagentsWatched) paths.push(w.subagentsDir);

    const watcher = chokidarWatch(paths, {
      usePolling,
      interval,
      depth: WATCH_DEPTH,
      ignoreInitial: true, // the catch-up sweep below does the initial read itself
      persistent: true,
      ignored: (path, stats) => stats?.isFile() === true && !path.endsWith(JSONL_EXT),
    });
    watcher.on('add', (path) => pumpPath(w, path));
    watcher.on('change', (path) => pumpPath(w, path));
    watcher.on('error', () => {}); // transient FS errors must not take the hub down
    // chokidar installs its per-file watchers asynchronously; a line written before that
    // finishes would otherwise wait for the next write, so sweep once more when it is ready.
    watcher.on('ready', () => pumpSession(w));
    return watcher;
  }

  function closeWatcher(w: Watch): void {
    const watcher = w.watcher;
    w.watcher = null;
    w.subagentsWatched = false;
    if (!watcher) return;
    const closing: Promise<void> = watcher
      .close()
      .catch(() => undefined)
      .finally(() => pendingCloses.delete(closing));
    pendingCloses.add(closing);
  }

  function ensureWatch(entry: { sessionId: string; slug: string; file: string }): Watch {
    let w = watches.get(entry.sessionId);
    if (!w) {
      w = {
        sessionId: entry.sessionId,
        slug: entry.slug,
        mainFile: resolve(entry.file),
        subagentsDir: resolve(join(root, 'projects', entry.slug, entry.sessionId, 'subagents')),
        watcher: null,
        subagentsWatched: false,
        agents: new Map(),
        normalizers: new Map(),
        backlog: [],
        followers: 0,
      };
      watches.set(entry.sessionId, w);
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

  function publish(w: Watch, evs: Ev[]): void {
    for (const ev of evs) {
      w.backlog.push(ev);
      const json = JSON.stringify(ev);
      for (const [sock, sessionId] of followed) {
        if (sessionId === w.sessionId) sendJson(sock, json);
      }
    }
    if (w.backlog.length > backlogLimit) w.backlog.splice(0, w.backlog.length - backlogLimit);
  }

  function unfollow(sock: WebSocket): void {
    const sessionId = followed.get(sock) ?? null;
    followed.set(sock, null);
    if (!sessionId) return;
    const w = watches.get(sessionId);
    if (!w) return;
    w.followers = Math.max(0, w.followers - 1);
    // Keep the watch state (offsets live in the shared tailer, backlog and normalizers here)
    // so a re-follow resumes instead of replaying from zero — only the watcher is released.
    if (w.followers === 0) closeWatcher(w);
  }

  function follow(sock: WebSocket, sessionId: string): void {
    if (followed.get(sock) === sessionId) return; // already streaming it; never double-replay
    const entry = findSession(sessionId);
    if (!entry) return; // unknown id: ignored, so no client string ever becomes a path segment
    unfollow(sock);

    const w = ensureWatch(entry);
    // The sweep above ran before this socket was registered, so the backlog replay below
    // is its only source of history — no event can reach it twice.
    followed.set(sock, sessionId);
    w.followers += 1;
    for (const ev of w.backlog) sendJson(sock, JSON.stringify(ev));
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
    if (msg.cmd === 'follow' && typeof msg.sessionId === 'string') follow(sock, msg.sessionId);
    // every other command is ignored on purpose
  }

  // ------------------------------------------------------------------ server

  const server = createServer((_req, res) => {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('roundtable observer: websocket only\n');
  });
  const wss = new WebSocketServer({ server, path: WS_PATH });

  wss.on('connection', (sock) => {
    followed.set(sock, null);
    sock.on('error', () => {}); // ws requires this listener or the process dies on socket errors
    sock.on('close', () => {
      unfollow(sock);
      followed.delete(sock);
    });
    sock.on('message', (data, isBinary) => {
      if (isBinary) return;
      try {
        handleMessage(sock, data.toString());
      } catch {
        // a malformed message must never break the connection or the process
      }
    });
    const hello: HelloMsg = { kind: 'hello', sessions: roster() };
    sendJson(sock, JSON.stringify(hello));
  });

  await new Promise<void>((resolvePromise, rejectPromise) => {
    const onError = (err: Error): void => {
      server.removeListener('listening', onListening);
      server.close(() => {}); // callback swallows ERR_SERVER_NOT_RUNNING
      rejectPromise(err);
    };
    const onListening = (): void => {
      server.removeListener('error', onError);
      server.on('error', () => {}); // a late socket error must not crash the observer
      resolvePromise();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, host); // loopback only: `host` is always passed
  });

  let stopped = false;
  return async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    for (const w of watches.values()) closeWatcher(w);
    await Promise.all([...pendingCloses]);
    watches.clear();
    followed.clear();
    for (const sock of wss.clients) sock.terminate();
    await new Promise<void>((res) => wss.close(() => res()));
    server.closeAllConnections();
    await new Promise<void>((res) => server.close(() => res()));
  };
}
