import { once } from 'node:events';
import { appendFileSync, copyFileSync, mkdirSync, mkdtempSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { evSession, isEv, type Ev } from '../shared/events';
import { pageOrigins } from '../shared/net';
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
  freshen(mainFile);
  if (withSubagents) {
    const agentFile = join(subagentsDir, 'agent-abc123.jsonl');
    copyFileSync(join('fixtures', 'agent-abc123.jsonl'), agentFile);
    freshen(agentFile);
  }
  return { root, slugDir, mainFile, sessionDir, subagentsDir };
}

/**
 * Marks a copied fixture as having just been written.
 *
 * `copyFileSync` preserves the source's timestamps on Windows, so a transcript copied out of
 * `fixtures/` arrives claiming it was last written whenever that file was committed — days ago.
 * The hub reads a subagent's mtime to decide whether it has gone quiet and finished, so every test
 * root was starting with its agents already eligible to be reported done, and which run saw it
 * first came down to which one the 500ms sweep happened to reach.
 */
const freshen = (file: string): void => {
  const now = new Date();
  utimesSync(file, now, now);
};

const seedAgent = (subagentsDir: string, name = 'agent-abc123.jsonl'): void => {
  const file = join(subagentsDir, name);
  copyFileSync(join('fixtures', 'agent-abc123.jsonl'), file);
  freshen(file);
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
      // This process, which is unarguably running. Liveness is decided by asking the kernel about
      // the pid, so a made-up number would be a coin flip on whether the test's session counts as
      // running — and on this machine 4242 happened to land on something alive.
      pid: process.pid,
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
      // The same 8s this file gives the sweep above, and for the same reason. `sessionSeen` says
      // the roster has *noticed* the session, not that a tail is attached to it and reading — the
      // append below is the first thing that has to travel the whole way from disk to the wire on a
      // session that was cold a moment ago. The default 3s is a unit-test budget and this is not a
      // unit test: it spans a 300ms roster sweep, a watcher pickup and a read, on whichever of the
      // six matrix legs happens to be busiest. This one timed out on macos/node 24 alone, which is
      // what a budget that is merely tight looks like. Nothing here asserts a duration — the
      // assertion is which session the line came from.
      const ev = await client.wait(evOf('agentText', (e) => e.text === SUB_TEXT), 8000);
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
    'labels each session with its opening human turn, and leaves it off when there is none',
    async () => {
      // Six tabs reading `dev-52`, `dev-70`, `dev-ef` are six tabs a person cannot choose
      // between: the CLI names a session after its cwd leaf plus a counter, so sessions started in
      // the same directory are indistinguishable by name. What they were asked to do is not.
      const { root, slugDir } = makeRoot({ subagents: false });
      const mute = join(slugDir, 'mute-sess.jsonl');
      writeFileSync(mute, userLine('<local-command-caveat>Caveat: …</local-command-caveat>'));
      freshen(mute);

      const client = await connect(await start(root));
      const hello = await client.wait(isHello);

      const sessions = hello.sessions as { sessionId: string; label?: string }[];
      expect(sessions.find((s) => s.sessionId === 'fix-sess')?.label).toBe('find the flaky test');
      // Talked at by the CLI and nothing else: absent, rather than labelled with boilerplate.
      expect(sessions.find((s) => s.sessionId === 'mute-sess')).toBeDefined();
      expect(sessions.find((s) => s.sessionId === 'mute-sess')?.label).toBeUndefined();
    },
    20_000,
  );

  it(
    'carries the sidecar’s parentAgentId out to the client',
    async () => {
      // The client rebuilds the spawn tree from the parent's `Task` call, which only resolves
      // while that line is still in its store. A depth-2 agent whose grandparent's spawn has been
      // trimmed past the message cap therefore re-roots at `main` — the wrong tree drawn, and the
      // wrong half of the room dimmed when somebody clicks an agent. The sidecar says it outright.
      const { root, subagentsDir } = makeRoot();
      writeFileSync(
        join(subagentsDir, 'agent-abc123.meta.json'),
        JSON.stringify({ agentType: 'general-purpose', description: 'dig', parentAgentId: 'grandkid', spawnDepth: 2 }),
      );
      const client = await connect(await start(root));
      await client.wait(isHello);
      client.send({ cmd: 'follow', sessionId: 'fix-sess' });

      const seen = await client.wait(evOf('agentSeen', (e) => e.ref.agentId === 'abc123' && !!e.parentAgentId));
      expect(seen.parentAgentId).toBe('grandkid');
      expect(seen.spawnDepth).toBe(2);
    },
    20_000,
  );

  /**
   * `agentDone` — never covered before, which is how it stayed wrong.
   *
   * The shipped fixtures cannot exercise it: `agent-abc123.meta.json` is a stub with no
   * `toolUseId`, so the parent's `Task` call and the child's sidecar are never joined and the
   * event is never derived. These build the join themselves.
   */
  describe('finishing', () => {
    /** A root whose main transcript spawns one subagent and later records its result. */
    function spawnRoot(opts: { background?: boolean } = {}): { root: string; childFile: string } {
      const root = mkdtempSync(join(tmpdir(), 'rt-done-'));
      const slugDir = join(root, 'projects', 'demo');
      const subagentsDir = join(slugDir, 'fix-sess', 'subagents');
      mkdirSync(subagentsDir, { recursive: true });

      const input: Record<string, unknown> = { prompt: 'go and look', subagent_type: 'Explore' };
      if (opts.background !== undefined) input.run_in_background = opts.background;
      writeFileSync(
        join(slugDir, 'fix-sess.jsonl'),
        `${JSON.stringify({
          type: 'assistant',
          timestamp: '2026-08-03T10:00:00.000Z',
          message: { role: 'assistant', model: 'claude-opus-5', content: [{ type: 'tool_use', id: 'tuS', name: 'Task', input }] },
        })}\n${JSON.stringify({
          type: 'user',
          timestamp: '2026-08-03T10:00:01.000Z',
          message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tuS' }] },
        })}\n`,
      );

      const childFile = join(subagentsDir, 'agent-kid.jsonl');
      writeFileSync(
        childFile,
        `${JSON.stringify({
          type: 'assistant',
          isSidechain: true,
          agentId: 'kid',
          timestamp: '2026-08-03T10:00:02.000Z',
          message: { role: 'assistant', model: 'claude-opus-5', content: [{ type: 'text', text: 'on it' }] },
        })}\n`,
      );
      // The sidecar is what ties the child back to the `Task` call that made it.
      writeFileSync(join(subagentsDir, 'agent-kid.meta.json'), JSON.stringify({ agentId: 'kid', toolUseId: 'tuS' }));
      return { root, childFile };
    }

    const donesFor = (client: TestClient): Ev[] => client.events().filter((e) => e.kind === 'agentDone');

    it('does not call a background agent finished while its transcript is still warm', async () => {
      // The parent's `tool_result` comes back the instant a background agent is *launched*. Acting
      // on it put a working agent in the break corner with its desk given away — 246 real spawns
      // reported the child done while it was still writing, by as much as 995 seconds.
      const { root } = spawnRoot({ background: true });
      const client = await connect(await start(root, { quietMs: 30_000 }));
      await client.wait(isHello);
      client.send({ cmd: 'follow', sessionId: 'fix-sess' });
      await client.wait(evOf('agentText', (e) => e.text === 'on it'));
      await delay(SETTLE_MS * 3);
      expect(donesFor(client)).toEqual([]);
    }, 20_000);

    it('calls it finished once its transcript goes quiet', async () => {
      const { root } = spawnRoot({ background: true });
      const client = await connect(await start(root, { quietMs: 300 }));
      await client.wait(isHello);
      client.send({ cmd: 'follow', sessionId: 'fix-sess' });
      const done = await client.wait(evOf('agentDone'), 8000);
      expect(done.ref.agentId).toBe('kid');
      expect(done.ok).toBe(true);
    }, 20_000);

    it('finishes a workflow agent, which has no parent result to wait for', async () => {
      // The case that filled a real room with fourteen agents while one was running. `Workflow` is
      // not in `SPAWN_TOOLS`, so its children get no `agentSpawn` — and one `Workflow` result could
      // not be matched to the dozen agents it spawned even if it did. Requiring the parent's
      // verdict meant these could never be reported finished at all.
      const root = mkdtempSync(join(tmpdir(), 'rt-wf-'));
      const wfDir = join(root, 'projects', 'demo', 'fix-sess', 'subagents', 'workflows', 'wf_abc');
      mkdirSync(wfDir, { recursive: true });
      copyFileSync(join('fixtures', 'main-session.jsonl'), join(root, 'projects', 'demo', 'fix-sess.jsonl'));
      writeFileSync(join(wfDir, 'agent-wf1.jsonl'), assistantLine('workflow agent reporting', 'wf1'));
      writeFileSync(join(wfDir, 'agent-wf1.meta.json'), JSON.stringify({ agentType: 'workflow-subagent' }));

      const client = await connect(await start(root, { quietMs: 300 }));
      await client.wait(isHello);
      client.send({ cmd: 'follow', sessionId: 'fix-sess' });
      const done = await client.wait(evOf('agentDone', (e) => e.ref.agentId === 'wf1'), 8000);
      expect(done.ok).toBe(true); // nothing observed says it failed, so it did not
    }, 20_000);

    it('does not call an agent finished while it is waiting on a tool', async () => {
      // A transcript is exactly as quiet during a five-minute build as it is after the agent has
      // stopped for good. Without the open-call test, every long tool call would send its agent
      // home and bring it back the moment the result landed.
      const root = mkdtempSync(join(tmpdir(), 'rt-open-'));
      const subDir = join(root, 'projects', 'demo', 'fix-sess', 'subagents');
      mkdirSync(subDir, { recursive: true });
      copyFileSync(join('fixtures', 'main-session.jsonl'), join(root, 'projects', 'demo', 'fix-sess.jsonl'));
      writeFileSync(
        join(subDir, 'agent-slow.jsonl'),
        `${JSON.stringify({
          type: 'assistant',
          isSidechain: true,
          agentId: 'slow',
          timestamp: '2026-08-03T10:00:00.000Z',
          message: {
            role: 'assistant',
            model: 'claude-opus-5',
            content: [{ type: 'tool_use', id: 'tuLong', name: 'Bash', input: { command: 'npm run build' } }],
          },
        })}\n`,
      );

      const client = await connect(await start(root, { quietMs: 300 }));
      await client.wait(isHello);
      client.send({ cmd: 'follow', sessionId: 'fix-sess' });
      await client.wait(evOf('toolStart', (e) => e.ref.agentId === 'slow'));
      await delay(SETTLE_MS * 4); // many sweeps, all of which must decline
      expect(client.events().some((e) => e.kind === 'agentDone' && e.ref.agentId === 'slow')).toBe(false);
    }, 20_000);

    it('gives up on an open tool call eventually, rather than never', async () => {
      // An agent killed mid-tool never writes the result, and a `tool_result` on a line over 1 MiB
      // is dropped unparsed. Either one pinned an agent at a desk for the rest of the session —
      // the exact thing this sweep exists to stop, arriving by a different route. Seen for real:
      // an agent idle for sixteen hours with one call still open, still on the floor.
      const root = mkdtempSync(join(tmpdir(), 'rt-stuck-'));
      const subDir = join(root, 'projects', 'demo', 'fix-sess', 'subagents');
      mkdirSync(subDir, { recursive: true });
      copyFileSync(join('fixtures', 'main-session.jsonl'), join(root, 'projects', 'demo', 'fix-sess.jsonl'));
      const stuck = join(subDir, 'agent-stuck.jsonl');
      writeFileSync(
        stuck,
        `${JSON.stringify({
          type: 'assistant',
          isSidechain: true,
          agentId: 'stuck',
          timestamp: '2026-08-03T10:00:00.000Z',
          message: {
            role: 'assistant',
            model: 'claude-opus-5',
            content: [{ type: 'tool_use', id: 'tuNever', name: 'Bash', input: { command: 'sleep 9999' } }],
          },
        })}\n`,
      );

      const client = await connect(await start(root, { quietMs: 200, openGraceMs: 600 }));
      await client.wait(isHello);
      client.send({ cmd: 'follow', sessionId: 'fix-sess' });
      await client.wait(evOf('toolStart', (e) => e.ref.agentId === 'stuck'));
      // Held while the grace lasts…
      await delay(300);
      expect(client.events().some((e) => e.kind === 'agentDone' && e.ref.agentId === 'stuck')).toBe(false);
      // …and released once it does not.
      const done = await client.wait(evOf('agentDone', (e) => e.ref.agentId === 'stuck'), 8000);
      expect(done.ok).toBe(true);
    }, 20_000);

    it('trusts the result immediately for a foreground spawn, which really does block', async () => {
      // No quiet window is waited out here at all: `quietMs` is set high enough that the only way
      // this can pass is the foreground fast path.
      const { root } = spawnRoot({ background: false });
      const client = await connect(await start(root, { quietMs: 60_000 }));
      await client.wait(isHello);
      client.send({ cmd: 'follow', sessionId: 'fix-sess' });
      const done = await client.wait(evOf('agentDone'), 8000);
      expect(done.ref.agentId).toBe('kid');
    }, 20_000);

    it('calls it finished again if it turns out not to have been', async () => {
      // The event used to fire exactly once per spawn, so an agent reported done too early was
      // never corrected: it came back to a desk on its next line and stayed there for the rest of
      // the session, looking alive. This is the correction, and it is the whole reason the room
      // does not fill up with agents that finished hours ago.
      const { root, childFile } = spawnRoot({ background: true });
      const client = await connect(await start(root, { quietMs: 300 }));
      await client.wait(isHello);
      client.send({ cmd: 'follow', sessionId: 'fix-sess' });
      await client.wait(evOf('agentDone'), 8000);
      expect(donesFor(client)).toHaveLength(1);

      // It was not finished after all.
      appendFileSync(childFile, assistantLine(NEW_AGENT_TEXT, 'kid'));
      await client.wait(evOf('agentText', (e) => e.text === NEW_AGENT_TEXT), 8000);
      await client.wait(
        (m): m is Ev => isEv(m) && m.kind === 'agentDone' && donesFor(client).length >= 2,
        8000,
      );
      expect(donesFor(client)).toHaveLength(2);
    }, 25_000);
  });

  it(
    'keeps a session that is open but idle, rather than dropping it after ninety seconds',
    async () => {
      // The bug this exists for: a Claude window sitting at a prompt writes nothing, so a rule of
      // "registered and touched within 90 seconds" called a session the user had open in front of
      // them finished — and its tab vanished. Measured on this machine: a live session with a
      // 970-second-old timestamp and a very much alive pid.
      const { root } = makeRoot();
      register(root, 'fix-sess', { updatedAt: Date.now() - 30 * 60_000 });
      const client = await connect(await start(root));
      const hello = await client.wait(isHello);
      expect(hello.sessions.find((s) => s.sessionId === 'fix-sess')).toMatchObject({ live: true });
      // And being live, it is streamed without being asked for.
      await client.wait(evOf('sessionSeen', (e) => e.sessionId === 'fix-sess'));
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

      // It stops running. No pid at all, so liveness falls back to the timestamp rule — which is
      // the only way to express "gone" without picking a number and hoping nothing else has it.
      register(root, 'other-sess', { pid: undefined, updatedAt: Date.now() - 10 * 60_000 });
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
      // `quietMs` well past the test's own lifetime in both runs. The fixture's subagent is
      // finished the moment it is read — its transcript never grows again — so the quiet sweep
      // would emit an `agentDone` on its own schedule, landing inside one run and not the other
      // and making the conservation check below a race rather than an assertion.
      const NO_SWEEP = { quietMs: 10 * 60_000 };
      const capped = await connect(await start(makeRoot().root, { backlogLimit: 2, ...NO_SWEEP }));
      await capped.wait(isHello);
      capped.send({ cmd: 'follow', sessionId: 'fix-sess' });

      const notice = await capped.wait(isTruncated);
      expect(notice.dropped).toBeGreaterThan(0);
      // the warning precedes the replay, so a client knows about the gap before it reads events
      expect(capped.seen.indexOf(notice)).toBeLessThan(capped.seen.findIndex((m) => isEv(m)));
      await delay(SETTLE_MS);
      expect(capped.events()).toHaveLength(2); // only the retained tail

      // control run over identical fixtures: dropped + retained must account for every event
      const full = await connect(await start(makeRoot().root, { backlogLimit: 1000, ...NO_SWEEP }));
      await full.wait(isHello);
      full.send({ cmd: 'follow', sessionId: 'fix-sess' });
      await full.wait(evOf('userMessage'));
      await delay(SETTLE_MS);
      expect(full.seen.some(isTruncated)).toBe(false); // nothing dropped, nothing announced
      const kinds = (c: TestClient): string =>
        c.events().map((e) => `${e.kind}${'ref' in e ? `/${e.ref.agentId}` : ''}`).join(' ');
      expect(
        notice.dropped + capped.events().length,
        `capped(dropped ${notice.dropped}): ${kinds(capped)}\nfull: ${kinds(full)}`,
      ).toBe(full.events().length);
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

  it(
    'accepts every origin the app actually serves from, derived not transcribed',
    async () => {
      // The gate and the servers it guards used to be four literals in two files with nothing
      // tying them together, so moving Vite off 5173 produced a hub no page could reach — and
      // that failure is indistinguishable from a crashed server: page loads, hub up, OFFLINE
      // for ever. This asserts the tie rather than the numbers, so it still means something the
      // day the ports change.
      const { root } = makeRoot({ subagents: false });
      const port = await start(root);
      for (const origin of pageOrigins()) {
        const client = await connect(port, origin);
        expect((await client.wait(isHello)).sessions.map((s) => s.sessionId), origin).toContain('fix-sess');
      }
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

  /**
   * Workflow phases.
   *
   * A `Workflow` call spawns agents that carry no `agentSpawn` — `Workflow` is not in
   * `SPAWN_TOOLS` — so nothing else in the stream groups them. The run's own record is the only
   * thing that does, and it appears in the session's `workflows` directory when the run ends.
   * See `docs/notes/workflow-journal-findings.md` for what is and is not in it.
   */
  describe('workflow phases', () => {
    /** Drops a run record into the session's own workflows directory, as the CLI does at run end. */
    const writeRun = (sessionDir: string, runId: string, body: Record<string, unknown>): string => {
      const dir = join(sessionDir, 'workflows');
      mkdirSync(dir, { recursive: true });
      const file = join(dir, `${runId}.json`);
      writeFileSync(file, JSON.stringify(body));
      return file;
    };

    const twoPhaseRun = (runId: string, status = 'killed'): Record<string, unknown> => ({
      runId,
      workflowName: 'nightly',
      status,
      startTime: 1_000,
      durationMs: 2_000,
      // Declared in the opposite order to the one they ran in, which is what the real files do.
      workflowProgress: [
        { type: 'workflow_phase', index: 1, title: 'Second' },
        { type: 'workflow_phase', index: 2, title: 'First' },
        {
          type: 'workflow_agent',
          index: 1,
          label: 'first:one',
          phaseIndex: 2,
          phaseTitle: 'First',
          agentId: 'a1111111111111111',
          state: 'done',
          queuedAt: 1_010,
          attempt: 1,
        },
        {
          type: 'workflow_agent',
          index: 2,
          label: 'second:one',
          phaseIndex: 1,
          phaseTitle: 'Second',
          agentId: 'a2222222222222222',
          state: 'progress',
          queuedAt: 2_500,
          attempt: 1,
        },
      ],
    });

    it(
      'publishes a run as one phase event, in the order the phases ran, and only once',
      async () => {
        const { root, sessionDir } = makeRoot();
        const client = await connect(await start(root));
        await client.wait(isHello);
        client.send({ cmd: 'follow', sessionId: 'fix-sess' });
        await client.wait(evOf('userMessage'));

        writeRun(sessionDir, 'wf_abcdef12-345', twoPhaseRun('wf_abcdef12-345'));

        const ev = await client.wait(evOf('workflowPhase'));
        expect(ev).toMatchObject({
          sessionId: 'fix-sess',
          workflowId: 'wf_abcdef12-345',
          workflowName: 'nightly',
          status: 'killed',
          ts: 3_000, // the run's own end, not when the hub happened to read the file
        });
        // Execution order, not the declared index order — the trap the real corpus is full of.
        expect(ev.phases.map((p) => p.title)).toEqual(['First', 'Second']);
        expect(ev.phases.map((p) => p.index)).toEqual([2, 1]);
        // Which agents belong to which phase: the question the event exists to answer.
        expect(ev.phases[0].agents.map((a) => a.agentId)).toEqual(['a1111111111111111']);
        expect(ev.phases[1].agents.map((a) => a.agentId)).toEqual(['a2222222222222222']);
        // It was cut off in `Second`, which still held an agent that never finished.
        expect(ev.activePhase).toBe(1);

        // The sweep runs twice a second over every followed session. An unchanged run file must
        // not be re-read, and must certainly not be re-published — the client folds by `seq`, so a
        // repeat would be a second workflow rather than the same one seen twice.
        await delay(SETTLE_MS * 3);
        expect(client.events().filter((e) => e.kind === 'workflowPhase')).toHaveLength(1);
        expect(errors).toEqual([]);
      },
      25_000,
    );

    it(
      'publishes again only when the file itself changes, and survives one that cannot be read',
      async () => {
        const { root, sessionDir } = makeRoot();
        const client = await connect(await start(root));
        await client.wait(isHello);
        client.send({ cmd: 'follow', sessionId: 'fix-sess' });
        await client.wait(evOf('userMessage'));

        // Torn mid-write, which is exactly how a sweep can catch a file the CLI is still writing.
        // It must neither throw nor be retried forever.
        writeFileSync(join(mkdirRuns(sessionDir), 'wf_torn-000.json'), '{"runId":"wf_torn-000","workflowProg');

        const file = writeRun(sessionDir, 'wf_abcdef12-345', twoPhaseRun('wf_abcdef12-345'));
        const first = await client.wait(evOf('workflowPhase'));
        expect(first.status).toBe('killed');

        // A genuine rewrite: new bytes, new mtime. `utimesSync` because a rewrite inside the same
        // filesystem timestamp granularity would otherwise be indistinguishable from no change.
        writeFileSync(file, JSON.stringify(twoPhaseRun('wf_abcdef12-345', 'completed')));
        const later = new Date(Date.now() + 5_000);
        utimesSync(file, later, later);

        const again = await client.wait(evOf('workflowPhase', (e) => e.status === 'completed'));
        expect(again.workflowId).toBe('wf_abcdef12-345');
        expect(client.events().filter((e) => e.kind === 'workflowPhase')).toHaveLength(2);
        expect(errors).toEqual([]);
      },
      25_000,
    );

    it(
      'says nothing for a session that has never run a workflow',
      async () => {
        const { root, mainFile } = makeRoot();
        const client = await connect(await start(root));
        await client.wait(isHello);
        client.send({ cmd: 'follow', sessionId: 'fix-sess' });
        appendFileSync(mainFile, assistantLine(LIVE_TEXT));
        await client.wait(evOf('agentText', (e) => e.text === LIVE_TEXT));
        await delay(SETTLE_MS * 2);

        expect(client.events().filter((e) => e.kind === 'workflowPhase')).toEqual([]);
      },
      25_000,
    );
  });
});

/** The session's own workflows directory, created on demand. */
function mkdirRuns(sessionDir: string): string {
  const dir = join(sessionDir, 'workflows');
  mkdirSync(dir, { recursive: true });
  return dir;
}
