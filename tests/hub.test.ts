import { once } from 'node:events';
import { appendFileSync, copyFileSync, mkdirSync, mkdtempSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { isEv, type Ev } from '../shared/events';
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

const assistantLine = (text: string, agentId?: string): string =>
  `${JSON.stringify({
    type: 'assistant',
    uuid: `u-${text.length}`,
    ...(agentId ? { agentId, isSidechain: true } : {}),
    sessionId: 'fix-sess',
    timestamp: '2026-08-02T10:01:00.000Z',
    message: { role: 'assistant', model: 'claude-fable-5', content: [{ type: 'text', text }] },
  })}\n`;

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

async function connect(port: number): Promise<TestClient> {
  const sock = new WebSocket(`ws://127.0.0.1:${port}/ws`);
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
      expect(other.events().every((e) => 'ref' in e && e.ref.sessionId === 'other-sess')).toBe(true);
      expect(idle.events()).toEqual([]); // never followed → never streamed
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
