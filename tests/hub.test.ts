import { once } from 'node:events';
import { appendFileSync, copyFileSync, mkdirSync, mkdtempSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { evSession, isEv, type Ev } from '../shared/events';
import { MAX_BATCH_BYTES } from '../server/tail';
import type { ReadyMsg, ResetMsg, TailNoticeMsg } from '../shared/protocol';
import { startServer, type HubOptions, type StopServer } from '../server/hub';

/** Polling makes the watcher deterministic on Windows and keeps the tests fast. */
const WATCH_OPTS = { usePolling: true, interval: 200 } as const;
/** Ports are probed upward so a running dev server on 7411 can never collide with the suite. */
const FIRST_PORT = 7460;
const PORT_TRIES = 20;
/** Watcher latency budget: polling interval + a generous margin for a loaded CI box. */
const WAIT_MS = 3000;
const SETTLE_MS = 400;

const LIVE_TEXT = 'live append landed';
const SUB_TEXT = 'subagent append landed';
const NEW_AGENT_TEXT = 'brand new agent reporting';
const REWRITTEN_TEXT = 'a different conversation entirely';
const TAIL_TEXT = 'the very last line of a long transcript';

const assistantLine = (text: string, agentId?: string): string =>
  `${JSON.stringify({
    type: 'assistant',
    uuid: `u-${text.length}`,
    ...(agentId ? { agentId, isSidechain: true } : {}),
    sessionId: 'fix-sess',
    timestamp: '2026-08-02T10:01:00.000Z',
    message: { role: 'assistant', model: 'claude-fable-5', content: [{ type: 'text', text }] },
  })}\n`;

const userLine = (text: string): string =>
  `${JSON.stringify({
    type: 'user',
    uuid: `u-${text.length}`,
    sessionId: 'fix-sess',
    timestamp: '2026-08-02T11:00:00.000Z',
    message: { role: 'user', content: text },
  })}\n`;

/** One line longer than a whole read batch — the shape the tailer has to step over. */
const oversizedLine = (): string =>
  `${JSON.stringify({
    type: 'user',
    uuid: 'u-huge',
    sessionId: 'fix-sess',
    timestamp: '2026-08-02T11:05:00.000Z',
    message: { role: 'user', content: 'x'.repeat(MAX_BATCH_BYTES) },
  })}\n`;

/** A transcript comfortably larger than one read batch, ending on a line worth waiting for. */
function bulkTranscript(): string {
  const pad = 'y'.repeat(3000);
  const rows: string[] = [];
  for (let i = 0; rows.length * 3000 < MAX_BATCH_BYTES * 1.4; i++) rows.push(assistantLine(`${pad} #${i}`));
  rows.push(assistantLine(TAIL_TEXT));
  return rows.join('');
}

// ---------------------------------------------------------------- test harness

type Hello = { kind: 'hello'; sessions: { sessionId: string; slug: string; mtime: number }[] };
type Truncated = { kind: 'backlogTruncated'; dropped: number };

const isHello = (m: unknown): m is Hello =>
  !!m && typeof m === 'object' && (m as { kind?: unknown }).kind === 'hello';

const isTruncated = (m: unknown): m is Truncated =>
  !!m &&
  typeof m === 'object' &&
  (m as { kind?: unknown }).kind === 'backlogTruncated' &&
  typeof (m as { dropped?: unknown }).dropped === 'number';

const isReady = (m: unknown): m is ReadyMsg =>
  !!m && typeof m === 'object' && (m as { kind?: unknown }).kind === 'ready';

const isReset = (m: unknown): m is ResetMsg =>
  !!m && typeof m === 'object' && (m as { kind?: unknown }).kind === 'reset';

/** Matches a tail notice, optionally only the ones satisfying a further predicate. */
const noticeOf =
  (extra: (n: TailNoticeMsg) => boolean = () => true) =>
  (m: unknown): m is TailNoticeMsg => {
    if (!m || typeof m !== 'object' || (m as { kind?: unknown }).kind !== 'notice') return false;
    const n = m as TailNoticeMsg;
    return typeof n.skipped === 'number' && typeof n.behind === 'boolean' && extra(n);
  };

/** Type guard for one `Ev` kind, with an optional extra predicate on the narrowed event. */
const evOf =
  <K extends Ev['kind']>(kind: K, extra: (e: Extract<Ev, { kind: K }>) => boolean = () => true) =>
  (m: unknown): m is Extract<Ev, { kind: K }> => {
    if (!isEv(m) || m.kind !== kind) return false;
    return extra(m as Extract<Ev, { kind: K }>);
  };

class TestClient {
  readonly seen: unknown[] = [];

  constructor(readonly sock: WebSocket) {
    sock.on('error', () => {}); // a terminated socket must not throw an unhandled 'error'
    sock.on('message', (data) => {
      try {
        this.seen.push(JSON.parse(data.toString()));
      } catch {
        this.seen.push(data.toString());
      }
    });
  }

  send(msg: unknown): void {
    this.sock.send(JSON.stringify(msg));
  }

  async wait<T>(match: (m: unknown) => m is T, ms = WAIT_MS): Promise<T> {
    const deadline = Date.now() + ms;
    for (;;) {
      const hit = this.seen.find(match);
      if (hit !== undefined) return hit;
      if (Date.now() > deadline) throw new Error(`timed out after ${ms}ms; saw ${JSON.stringify(this.seen)}`);
      await delay(25);
    }
  }

  events(): Ev[] {
    return this.seen.filter((m): m is Ev => isEv(m));
  }
}

const delay = (ms: number): Promise<void> =>
  new Promise((res) => {
    setTimeout(res, ms);
  });

const stops: StopServer[] = [];
const sockets: WebSocket[] = [];
/** Every hub in the suite reports here, so any test can assert it ran without failures. */
const errors: { err: unknown; ctx: string }[] = [];

afterEach(async () => {
  for (const sock of sockets.splice(0)) {
    sock.removeAllListeners();
    sock.on('error', () => {});
    sock.terminate();
  }
  for (const stop of stops.splice(0)) await stop();
  errors.splice(0);
});

function makeRoot(opts: { subagents?: boolean; sessionDir?: boolean } = {}): {
  root: string;
  slugDir: string;
  mainFile: string;
  sessionDir: string;
  subagentsDir: string;
} {
  const withSubagents = opts.subagents !== false;
  const root = mkdtempSync(join(tmpdir(), 'rt-hub-'));
  const slugDir = join(root, 'projects', 'demo');
  const sessionDir = join(slugDir, 'fix-sess');
  const subagentsDir = join(sessionDir, 'subagents');
  if (withSubagents) mkdirSync(subagentsDir, { recursive: true });
  else mkdirSync(opts.sessionDir ? sessionDir : slugDir, { recursive: true });
  const mainFile = join(slugDir, 'fix-sess.jsonl');
  copyFileSync(join('fixtures', 'main-session.jsonl'), mainFile);
  if (withSubagents) {
    copyFileSync(join('fixtures', 'agent-abc123.jsonl'), join(subagentsDir, 'agent-abc123.jsonl'));
  }
  return { root, slugDir, mainFile, sessionDir, subagentsDir };
}

const seedAgent = (subagentsDir: string, name = 'agent-abc123.jsonl'): void => {
  copyFileSync(join('fixtures', 'agent-abc123.jsonl'), join(subagentsDir, name));
};

/**
 * Writes the CLI's own registry entry for a session, which is the only thing that makes the hub
 * call it *running*.
 *
 * `~/.claude/sessions/<pid>.json` is what the real CLI keeps, and the hub pairs its `updatedAt`
 * with the transcript's mtime before believing anything — so a test that wants a live session has
 * to produce one, not assert around it.
 */
const register = (root: string, sessionId: string, extra: Record<string, unknown> = {}): void => {
  const dir = join(root, 'sessions');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `${sessionId}.json`),
    JSON.stringify({
      sessionId,
      pid: 4242,
      cwd: `C:\\work\\${sessionId}`,
      name: `dev-${sessionId.slice(0, 2)}`,
      status: 'busy',
      updatedAt: Date.now(),
      ...extra,
    }),
  );
};

const isPortTaken = (err: unknown): boolean =>
  !!err && typeof err === 'object' && (err as { code?: unknown }).code === 'EADDRINUSE';

/** Starts a hub on the first free port and registers its shutdown with afterEach. */
async function start(root: string, extra: Partial<HubOptions> = {}): Promise<number> {
  const options: HubOptions = {
    ...WATCH_OPTS,
    onError: (err, ctx) => errors.push({ err, ctx }),
    ...extra,
  };
  for (let port = FIRST_PORT; port < FIRST_PORT + PORT_TRIES; port++) {
    try {
      stops.push(await startServer(root, port, options));
      return port;
    } catch (err) {
      if (!isPortTaken(err)) throw err; // only a busy port is worth retrying
    }
  }
  throw new Error('no free port for the hub test');
}

/**
 * A non-browser client: no `Origin` header at all, which is what every test below except the
 * origin ones uses — and what the hub has to keep accepting.
 */
async function connect(port: number, origin?: string): Promise<TestClient> {
  const sock = new WebSocket(`ws://127.0.0.1:${port}/ws`, origin === undefined ? {} : { origin });
  sockets.push(sock);
  const client = new TestClient(sock); // listeners attach before 'open' so nothing is missed
  await once(sock, 'open');
  return client;
}

// ---------------------------------------------------------------------- tests

describe('hub', () => {
  it(
    'greets with the session roster, replays history and streams live appends',
    async () => {
      const { root, mainFile } = makeRoot();
      const client = await connect(await start(root));

      const hello = await client.wait(isHello);
      expect(hello.sessions.map((s) => s.sessionId)).toContain('fix-sess');
      expect(hello.sessions[0]).toEqual(expect.objectContaining({ slug: 'demo' }));

      client.send({ cmd: 'follow', sessionId: 'fix-sess' });

      // historical catch-up: existing file content arrives as events
      const first = await client.wait(evOf('userMessage', (e) => e.text === 'find the flaky test'));
      expect(first.ref).toEqual({ sessionId: 'fix-sess', agentId: 'main' });

      // live increment
      appendFileSync(mainFile, assistantLine(LIVE_TEXT));
      const live = await client.wait(evOf('agentText', (e) => e.text === LIVE_TEXT));
      expect(live.ref.agentId).toBe('main');
    },
    20_000,
  );

  it(
    'never leaks events to sockets following another session or none at all',
    async () => {
      const { root, slugDir, mainFile } = makeRoot();
      copyFileSync(join('fixtures', 'main-session.jsonl'), join(slugDir, 'other-sess.jsonl'));
      const port = await start(root);
      const [followed, other, idle] = [await connect(port), await connect(port), await connect(port)];
      await Promise.all([followed.wait(isHello), other.wait(isHello), idle.wait(isHello)]);

      followed.send({ cmd: 'follow', sessionId: 'fix-sess' });
      other.send({ cmd: 'follow', sessionId: 'other-sess' });

      appendFileSync(mainFile, assistantLine(LIVE_TEXT));
      await followed.wait(evOf('agentText', (e) => e.text === LIVE_TEXT));
      await delay(SETTLE_MS);

      expect(other.events().length).toBeGreaterThan(0); // it got its own session's backlog
      // `evSession` rather than `e.ref.sessionId`: `sessionSeen` is about the session itself and
      // carries no agent, so a check that reached through `ref` would skip the one event whose
      // whole job is to name a session.
      expect(other.events().every((e) => evSession(e) === 'other-sess')).toBe(true);
      // Nothing in this temp root is in the CLI's registry, so nothing here is *running* — the
      // live sweep has nothing to attach, and a socket that asked for nothing still gets nothing.
      expect(idle.events()).toEqual([]);
    },
    20_000,
  );

  /**
   * Multi-session. The observer used to follow exactly one session and a switch dropped the
   * socket, so a machine running three sessions could be watched one at a time and only by
   * throwing away what you were looking at. The hub now tails everything that is *running* and
   * streams all of it; the client decides which of them is worth a tab.
   */
  it(
    'streams a running session to every socket without being asked for it',
    async () => {
      const { root, slugDir, mainFile } = makeRoot();
      const otherFile = join(slugDir, 'other-sess.jsonl');
      copyFileSync(join('fixtures', 'main-session.jsonl'), otherFile);
      // Only `other-sess` is registered with the CLI, so only it is running.
      register(root, 'other-sess');

      const port = await start(root);
      const client = await connect(port);
      await client.wait(isHello);

      // The picker chose the session that is *not* running — a historical one, which the live
      // sweep would never attach on its own.
      client.send({ cmd: 'follow', sessionId: 'fix-sess' });
      appendFileSync(mainFile, assistantLine(LIVE_TEXT));
      appendFileSync(otherFile, assistantLine(NEW_AGENT_TEXT));

      // Both arrive, on one socket, distinguishable only by the session on the event.
      const pinnedEv = await client.wait(evOf('agentText', (e) => e.text === LIVE_TEXT));
      const liveEv = await client.wait(evOf('agentText', (e) => e.text === NEW_AGENT_TEXT));
      expect(evSession(pinnedEv)).toBe('fix-sess');
      expect(evSession(liveEv)).toBe('other-sess');
    },
    20_000,
  );

  it(
    'names a running session that has not written anything since the hub attached',
    async () => {
      // The case a cheap roster summary cannot cover and an agent-only stream cannot either: the
      // session exists and is running, and has said nothing. Without `sessionSeen` the client has
      // no way to know it is there, so it could never grow a tab for it.
      const { root } = makeRoot();
      register(root, 'fix-sess');
      const client = await connect(await start(root));
      await client.wait(isHello);

      const seen = await client.wait(evOf('sessionSeen', (e) => e.sessionId === 'fix-sess'));
      expect(seen.cwd).toBe('C:\\work\\fix-sess');
      expect(seen.live).toBe(true);
    },
    20_000,
  );

  it(
    'picks up a session that starts after the observer is already open',
    async () => {
      const { root, slugDir } = makeRoot();
      const client = await connect(await start(root, { rosterMs: 300 }));
      await client.wait(isHello);
      client.send({ cmd: 'follow', sessionId: 'fix-sess' });
      await client.wait(evOf('agentText'));

      // A second session appears on disk and registers itself, exactly as a new CLI would.
      const lateFile = join(slugDir, 'late-sess.jsonl');
      copyFileSync(join('fixtures', 'main-session.jsonl'), lateFile);
      register(root, 'late-sess');

      // Nothing on disk announces a new session to a process that is not watching its directory;
      // the roster sweep is what has to notice.
      const seen = await client.wait(evOf('sessionSeen', (e) => e.sessionId === 'late-sess'), 8000);
      expect(seen.live).toBe(true);
      appendFileSync(lateFile, assistantLine(SUB_TEXT));
      const ev = await client.wait(evOf('agentText', (e) => e.text === SUB_TEXT));
      expect(evSession(ev)).toBe('late-sess');
    },
    25_000,
  );

  it(
    'keeps streaming a session the picker moved away from, as long as it is still running',
    async () => {
      // The acceptance the old single-follow client could not meet: switching tabs must not throw
      // away the session you switched away from.
      const { root, slugDir, mainFile } = makeRoot();
      const otherFile = join(slugDir, 'other-sess.jsonl');
      copyFileSync(join('fixtures', 'main-session.jsonl'), otherFile);
      register(root, 'fix-sess');
      register(root, 'other-sess');

      const client = await connect(await start(root));
      await client.wait(isHello);
      client.send({ cmd: 'follow', sessionId: 'fix-sess' });
      await client.wait(evOf('sessionSeen', (e) => e.sessionId === 'fix-sess'));

      client.send({ cmd: 'follow', sessionId: 'other-sess' }); // the user clicks the other tab
      await delay(SETTLE_MS);

      appendFileSync(mainFile, assistantLine(LIVE_TEXT)); // the one they switched *away* from
      const ev = await client.wait(evOf('agentText', (e) => e.text === LIVE_TEXT));
      expect(evSession(ev)).toBe('fix-sess');
    },
    20_000,
  );

  it(
    'tells the client to start again before every replay, so an evicted session is not counted twice',
    async () => {
      // The failure this prevents: switch away from a session, let the hub evict the watch, switch
      // back. The backlog is re-read from byte zero and every event carries a *fresh* seq — higher
      // than the ones the client already folded, so `ev.seq <= state.lastSeq` rejects none of them
      // and the whole session lands a second time on top of itself.
      const { root, slugDir } = makeRoot();
      copyFileSync(join('fixtures', 'main-session.jsonl'), join(slugDir, 'other-sess.jsonl'));
      const client = await connect(await start(root));
      await client.wait(isHello);

      client.send({ cmd: 'follow', sessionId: 'fix-sess' });
      const first = await client.wait(isReset);
      expect(first).toMatchObject({ sessionId: 'fix-sess', reason: 'replay' });
      await client.wait(evOf('agentText'));

      // Every replay gets one, including the very first for a session — the hub cannot know what
      // the client is holding, and "always" is the only rule that is right in both cases.
      client.send({ cmd: 'follow', sessionId: 'other-sess' });
      const second = await client.wait(
        (m): m is ResetMsg => isReset(m) && (m as ResetMsg).sessionId === 'other-sess',
      );
      expect(second.reason).toBe('replay');

      // The reset must arrive *before* the history it invalidates, or the client drops the replay
      // it was meant to keep.
      const frames = client.seen;
      const resetAt = frames.findIndex((m) => isReset(m) && (m as ResetMsg).sessionId === 'other-sess');
      const firstOtherEv = frames.findIndex((m) => isEv(m) && evSession(m) === 'other-sess');
      expect(resetAt).toBeGreaterThanOrEqual(0);
      expect(firstOtherEv).toBeGreaterThan(resetAt);
    },
    20_000,
  );

  it(
    'still answers a follow for a session it is already streaming',
    async () => {
      // The normal path once two sessions are running: the live sweep has already attached them
      // both, so a tab click asks for something the hub is already sending. Answering with silence
      // left the client's "loading" flag raised for the rest of the connection — the top bar read
      // LOADING for ever while events arrived perfectly normally behind it.
      const { root } = makeRoot();
      register(root, 'fix-sess');
      const client = await connect(await start(root));
      await client.wait(isHello);
      await client.wait(evOf('sessionSeen', (e) => e.sessionId === 'fix-sess')); // auto-attached
      const before = client.seen.filter(isReady).length;

      client.send({ cmd: 'follow', sessionId: 'fix-sess' });
      await client.wait((m): m is ReadyMsg => isReady(m) && client.seen.filter(isReady).length > before, 5000);
      const last = client.seen.filter(isReady).at(-1);
      expect(last).toMatchObject({ sessionId: 'fix-sess', replayed: 0 }); // nothing replayed, but an answer
    },
    20_000,
  );

  it(
    'releases a session that has stopped running, so the cap counts what is live',
    async () => {
      // `syncLive` only ever added, so the cap became a count of every session the observer had
      // *ever* seen: after STREAM_CAP of them a newly started session never appeared again, while
      // the finished ones each kept a watcher, a rescan interval and a full backlog resident.
      const { root, slugDir } = makeRoot();
      copyFileSync(join('fixtures', 'main-session.jsonl'), join(slugDir, 'other-sess.jsonl'));
      register(root, 'other-sess');
      const client = await connect(await start(root, { rosterMs: 300 }));
      await client.wait(isHello);
      await client.wait(evOf('sessionSeen', (e) => e.sessionId === 'other-sess'));

      // It stops running: the registry entry goes stale.
      register(root, 'other-sess', { updatedAt: Date.now() - 10 * 60_000 });
      // Make its transcript's mtime old too — liveness is the later of the two.
      const old = new Date(Date.now() - 10 * 60_000);
      utimesSync(join(slugDir, 'other-sess.jsonl'), old, old);

      const resetsFor = (): number =>
        client.seen.filter((m) => isReset(m) && (m as ResetMsg).sessionId === 'other-sess').length;
      const before = resetsFor(); // one, from the sweep that attached it while it was running

      client.send({ cmd: 'rescan' });
      await delay(SETTLE_MS);

      // Asking for it again now produces a *fresh* replay, and a replay is preceded by a `reset`.
      // That only happens on a genuine attach: a session still being streamed answers a `follow`
      // with a bare `ready` and no reset at all. So a second reset is the proof it was released.
      // (Appending to its transcript would not prove anything — it would refresh the file's mtime
      //  and the session would simply be live again.)
      client.send({ cmd: 'follow', sessionId: 'other-sess' });
      await client.wait((m): m is ResetMsg => isReset(m) && resetsFor() > before, 5000);
      expect(resetsFor()).toBe(before + 1);
    },
    25_000,
  );

  it(
    'answers a rescan immediately instead of making the viewer wait for the sweep',
    async () => {
      // The sweep would find it anyway; this is about the person who has just started a second
      // session in another window and is looking at a screen that has not caught up yet.
      const { root, slugDir } = makeRoot();
      // A long roster interval, so anything that arrives can only have come from the rescan.
      const client = await connect(await start(root, { rosterMs: 120_000 }));
      await client.wait(isHello);

      copyFileSync(join('fixtures', 'main-session.jsonl'), join(slugDir, 'late-sess.jsonl'));
      register(root, 'late-sess');

      client.send({ cmd: 'rescan' });
      const seen = await client.wait(evOf('sessionSeen', (e) => e.sessionId === 'late-sess'), 5000);
      expect(seen.live).toBe(true);
    },
    20_000,
  );

  it(
    'treats a repeated rescan as the no-op it is',
    async () => {
      const { root } = makeRoot();
      register(root, 'fix-sess');
      const client = await connect(await start(root, { rosterMs: 120_000 }));
      await client.wait(isHello);
      await client.wait(evOf('sessionSeen'));

      const before = client.events().length;
      for (let i = 0; i < 5; i++) client.send({ cmd: 'rescan' });
      await delay(SETTLE_MS);
      // Attaching a session already streaming returns immediately, so a held-down button costs a
      // directory listing per press and republishes nothing.
      expect(client.events().length).toBe(before);
    },
    20_000,
  );

  it(
    'ignores malformed, unknown and traversal-shaped client messages without dying',
    async () => {
      const { root, mainFile } = makeRoot();
      const client = await connect(await start(root));
      await client.wait(isHello);

      client.sock.send('not json at all');
      client.send([1, 2, 3]);
      client.send('a bare string');
      client.send({ cmd: 'follow' });
      client.send({ cmd: 'follow', sessionId: 42 });
      client.send({ cmd: 'follow', sessionId: '../../../../etc/passwd' });
      client.send({ cmd: 'follow', sessionId: join('..', '..', 'demo', 'fix-sess') });
      client.send({ cmd: 'follow', sessionId: 'no-such-session' });
      client.send({ cmd: 'bogus' });
      client.sock.send(Buffer.from([0x00, 0x01, 0x02]));
      await delay(SETTLE_MS);
      expect(client.events()).toEqual([]);

      // the socket still works after all of that
      client.send({ cmd: 'follow', sessionId: 'fix-sess' });
      appendFileSync(mainFile, assistantLine(LIVE_TEXT));
      await client.wait(evOf('agentText', (e) => e.text === LIVE_TEXT));
    },
    20_000,
  );

  it(
    'streams subagent transcripts under their own agentId, including files added later',
    async () => {
      const { root, subagentsDir } = makeRoot();
      const client = await connect(await start(root));
      await client.wait(isHello);
      client.send({ cmd: 'follow', sessionId: 'fix-sess' });

      const seeded = await client.wait(evOf('agentText', (e) => e.ref.agentId === 'abc123'));
      expect(seeded.text).toContain('3 suites');

      appendFileSync(join(subagentsDir, 'agent-abc123.jsonl'), assistantLine(SUB_TEXT, 'abc123'));
      await client.wait(evOf('agentText', (e) => e.ref.agentId === 'abc123' && e.text === SUB_TEXT), 6000);

      writeFileSync(join(subagentsDir, 'agent-def456.jsonl'), assistantLine(NEW_AGENT_TEXT, 'def456'));
      await client.wait(evOf('agentText', (e) => e.ref.agentId === 'def456'), 6000);
      expect(errors).toEqual([]); // watching a live directory reports no failures
    },
    25_000,
  );

  // A subagent can be spawned, work and finish while the parent transcript stays silent, so the
  // attach must not wait for main-file activity — that would turn a live run into one retroactive
  // burst at completion. Neither test below writes to the main file after the follow.
  it(
    'attaches a subagents directory created after the follow, with no main-file activity',
    async () => {
      const { root, mainFile, subagentsDir } = makeRoot({ subagents: false });
      const client = await connect(await start(root));
      await client.wait(isHello);
      client.send({ cmd: 'follow', sessionId: 'fix-sess' });
      await client.wait(evOf('userMessage'));
      const untouched = statSync(mainFile).mtimeMs;

      mkdirSync(subagentsDir, { recursive: true }); // session dir did not exist either
      seedAgent(subagentsDir);

      const ev = await client.wait(evOf('agentText', (e) => e.ref.agentId === 'abc123'));
      expect(ev.text).toContain('3 suites');
      expect(statSync(mainFile).mtimeMs).toBe(untouched); // nothing nudged the main transcript
      expect(errors).toEqual([]);
    },
    25_000,
  );

  it(
    'attaches when only the subagents directory appears under an existing session directory',
    async () => {
      const { root, subagentsDir } = makeRoot({ subagents: false, sessionDir: true });
      const client = await connect(await start(root));
      await client.wait(isHello);
      client.send({ cmd: 'follow', sessionId: 'fix-sess' });
      await client.wait(evOf('userMessage'));

      mkdirSync(subagentsDir, { recursive: true });
      seedAgent(subagentsDir);

      await client.wait(evOf('agentText', (e) => e.ref.agentId === 'abc123'));
      expect(errors).toEqual([]);
    },
    25_000,
  );

  it(
    'tells a follower on the wire when the backlog cap dropped history',
    async () => {
      const capped = await connect(await start(makeRoot().root, { backlogLimit: 2 }));
      await capped.wait(isHello);
      capped.send({ cmd: 'follow', sessionId: 'fix-sess' });

      const notice = await capped.wait(isTruncated);
      expect(notice.dropped).toBeGreaterThan(0);
      // the warning precedes the replay, so a client knows about the gap before it reads events
      expect(capped.seen.indexOf(notice)).toBeLessThan(capped.seen.findIndex((m) => isEv(m)));
      await delay(SETTLE_MS);
      expect(capped.events()).toHaveLength(2); // only the retained tail

      // control run over identical fixtures: dropped + retained must account for every event
      const full = await connect(await start(makeRoot().root, { backlogLimit: 1000 }));
      await full.wait(isHello);
      full.send({ cmd: 'follow', sessionId: 'fix-sess' });
      await full.wait(evOf('userMessage'));
      await delay(SETTLE_MS);
      expect(full.seen.some(isTruncated)).toBe(false); // nothing dropped, nothing announced
      expect(notice.dropped + capped.events().length).toBe(full.events().length);
    },
    25_000,
  );

  // Binding to loopback keeps other machines out; it does not keep other *pages* out. A browser
  // will open a WebSocket to 127.0.0.1 for whatever page asks — the same-origin policy does not
  // apply to them — and the hub answers every connection with the roster and will follow any
  // session it names. Without the Origin gate, one visited page reads the user's transcripts.
  it(
    'refuses a handshake from a page origin the app is not served from',
    async () => {
      const { root } = makeRoot();
      const port = await start(root);

      const evil = new WebSocket(`ws://127.0.0.1:${port}/ws`, { origin: 'http://evil.example' });
      sockets.push(evil);
      const frames: string[] = [];
      evil.on('message', (data) => frames.push(data.toString()));

      // Whichever comes first is the answer, so an accepted handshake fails here and now rather
      // than by timing out on an error that is never coming.
      const outcome = await new Promise<string>((res) => {
        evil.on('open', () => res('open'));
        evil.on('error', (err: Error) => res(`rejected: ${err.message}`));
      });
      expect(outcome, 'a foreign page opened the socket').not.toBe('open');
      expect(outcome).toContain('401'); // ws aborts the handshake with 401 Unauthorized
      expect(evil.readyState).not.toBe(WebSocket.OPEN);

      await delay(SETTLE_MS);
      expect(frames).toEqual([]); // no roster, so not one session id leaked either
    },
    20_000,
  );

  it(
    'still greets the app’s own origin and clients that send none',
    async () => {
      const { root } = makeRoot();
      const port = await start(root);

      // The app page, exactly as the browser announces it (`playwright.config.ts` baseURL).
      const app = await connect(port, 'http://localhost:5173');
      expect((await app.wait(isHello)).sessions.map((s) => s.sessionId)).toContain('fix-sess');

      // The loopback address is the same app under the other name Vite answers to.
      const loopback = await connect(port, 'http://127.0.0.1:5173');
      await loopback.wait(isHello);

      // No Origin at all: a CLI or a test, which can already read the files the hub is tailing.
      const headless = await connect(port);
      await headless.wait(isHello);

      // …and an allowed origin is a full client, not just a greeted one.
      app.send({ cmd: 'follow', sessionId: 'fix-sess' });
      await app.wait(evOf('userMessage'));
    },
    20_000,
  );

  // A transcript that is truncated or rewritten is read again from byte zero, and every line of
  // it is republished with a *fresh* seq — which is exactly what the client's idempotence guard
  // keys on, so it cannot reject a single one. Without the `reset` frame the session is counted
  // twice: every message, every token, every dollar.
  it(
    'sends exactly one reset before re-replaying a rewritten transcript, with fresh seqs',
    async () => {
      const { root, mainFile } = makeRoot({ subagents: false });
      const client = await connect(await start(root));
      await client.wait(isHello);
      client.send({ cmd: 'follow', sessionId: 'fix-sess' });
      await client.wait(evOf('userMessage', (e) => e.text === 'find the flaky test'));
      await delay(SETTLE_MS);

      const before = client.events();
      expect(before.length).toBeGreaterThan(0);
      const lastSeqBefore = Math.max(...before.map((e) => e.seq));

      // Strictly shorter than what has already been read, so the tailer sees the file shrink.
      writeFileSync(mainFile, userLine(REWRITTEN_TEXT));

      const again = await client.wait(evOf('userMessage', (e) => e.text === REWRITTEN_TEXT), 10_000);
      await delay(SETTLE_MS);

      // Only the rewind kind: every replay also sends a `reset`, and this test is about the one a
      // truncated transcript causes.
      const resets = client.seen.filter((m): m is ResetMsg => isReset(m) && (m as ResetMsg).reason === 'rewound');
      expect(resets).toHaveLength(1); // one restart, however many files the rewind touched
      expect(resets[0]).toEqual({ kind: 'reset', sessionId: 'fix-sess', reason: 'rewound' });

      // The frame precedes every event of the re-read: a client that acts on the stream in order
      // has dropped its state before the first replacement event lands.
      const at = client.seen.indexOf(resets[0]);
      expect(at).toBeLessThan(client.seen.indexOf(again));
      const after = client.seen.slice(at + 1).filter((m): m is Ev => isEv(m));
      expect(after.length).toBeGreaterThan(0);
      // Fresh seqs are the reason the frame is needed at all — assert they really are fresh, and
      // that not one of them slipped out ahead of it.
      expect(after.every((e) => e.seq > lastSeqBefore)).toBe(true);
      const ahead = client.seen.slice(0, at).filter((m): m is Ev => isEv(m));
      expect(ahead.every((e) => e.seq <= lastSeqBefore)).toBe(true);

      // …and the rewind is reported to the host application rather than swallowed.
      expect(errors.some((e) => e.ctx === 'reset:fix-sess')).toBe(true);
    },
    25_000,
  );

  // 126 lines of 200 real transcripts are ≥ 1 MiB, and on one file every skipped line was a
  // `tool_result` — four chips that spin forever, with nothing on the wire to say why.
  it(
    'reports an oversized line as a tail notice instead of losing it silently',
    async () => {
      const { root, mainFile } = makeRoot({ subagents: false });
      const client = await connect(await start(root));
      await client.wait(isHello);
      client.send({ cmd: 'follow', sessionId: 'fix-sess' });
      await client.wait(evOf('userMessage'));

      appendFileSync(mainFile, oversizedLine());
      appendFileSync(mainFile, assistantLine(LIVE_TEXT));

      const notice = await client.wait(noticeOf((n) => n.skipped > 0), 15_000);
      expect(notice.sessionId).toBe('fix-sess');
      expect(notice.skipped).toBeGreaterThanOrEqual(1);

      // The tail resynchronizes on the next newline, so the line after the giant one still lands.
      await client.wait(evOf('agentText', (e) => e.text === LIVE_TEXT), 15_000);
    },
    30_000,
  );

  // The drain bound stops one enormous file from starving every other session; it must not also
  // stop it from ever being finished. A 67.4 MB transcript once read 45.2 MB and gave up, and a
  // historical session never retried — `armRescan` only re-pumps subagent files.
  it(
    'keeps draining across ticks and says the tail is behind until it has caught up',
    async () => {
      const { root, mainFile } = makeRoot({ subagents: false });
      writeFileSync(mainFile, bulkTranscript()); // more than one read batch
      const client = await connect(await start(root, { drainPasses: 1 }));
      await client.wait(isHello);
      client.send({ cmd: 'follow', sessionId: 'fix-sess' });

      // One pass per round cannot finish this file, and the follower is told so on follow.
      const behind = await client.wait(noticeOf((n) => n.behind), 15_000);
      expect(behind.sessionId).toBe('fix-sess');
      expect(behind.skipped).toBe(0); // behind is not the same claim as lost

      // The continuation runs on later ticks: the last line of the file arrives regardless.
      const tail = await client.wait(evOf('agentText', (e) => e.text === TAIL_TEXT), 25_000);
      expect(tail.ref.agentId).toBe('main');

      // …and the warning clears, so the UI does not keep claiming an incomplete tail.
      const caughtUp = await client.wait(noticeOf((n) => !n.behind), 15_000);
      expect(client.seen.indexOf(behind)).toBeLessThan(client.seen.indexOf(caughtUp));
      expect(caughtUp.skipped).toBe(0);
    },
    45_000,
  );

  it(
    'says nothing about the tail when nothing was skipped and nothing is behind',
    async () => {
      const { root, mainFile } = makeRoot();
      const client = await connect(await start(root));
      await client.wait(isHello);
      client.send({ cmd: 'follow', sessionId: 'fix-sess' });
      await client.wait(evOf('userMessage'));
      appendFileSync(mainFile, assistantLine(LIVE_TEXT));
      await client.wait(evOf('agentText', (e) => e.text === LIVE_TEXT));
      await delay(SETTLE_MS);

      expect(client.seen.filter(noticeOf())).toEqual([]); // a quiet session stays quiet
      // Nothing was rewound. The one `reset` this session does see is the routine `replay` that
      // precedes every backlog, which says nothing about the transcript's health.
      expect(client.seen.filter((m) => isReset(m) && (m as ResetMsg).reason === 'rewound')).toEqual([]);
    },
    25_000,
  );

  it(
    'shuts everything down so the port can be bound again',
    async () => {
      const { root } = makeRoot();
      const port = await start(root);
      const client = await connect(port);
      await client.wait(isHello);
      client.send({ cmd: 'follow', sessionId: 'fix-sess' });
      await client.wait(evOf('userMessage'));

      const stop = stops.pop();
      expect(stop).toBeDefined();
      await stop?.();
      await stop?.(); // idempotent

      stops.push(await startServer(root, port, WATCH_OPTS)); // rebinding proves nothing is left listening
    },
    20_000,
  );
});
