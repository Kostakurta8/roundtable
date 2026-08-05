/**
 * The demo room.
 *
 * Roundtable normally watches `~/.claude`, which means a clean clone on a machine without Claude
 * Code — or with Claude Code installed but nothing running — opens on an empty floor. That is an
 * honest picture of an empty session and a terrible first impression, so this is the other thing to
 * point the hub at: a synthetic `~/.claude` root that this process writes, and keeps writing.
 *
 * It reuses `scripts/promo/stage.ts`, the movie set built for the trailer. Nothing here reads or
 * copies anything from your machine — every line is written by that file, so no prompt, path,
 * project name or session id from a real session can appear in the demo.
 *
 * What it is *not* is a simulation. The lines go to disk and are picked up by chokidar, parsed,
 * normalized, broadcast over the same WebSocket and folded by the same store as a real session's.
 * The pipeline you are watching is the shipped one; only the content is invented.
 *
 * Run it with `npm run demo`, which starts this and Vite together. The hub's own timing defaults
 * are untouched: an agent that stops being written to goes quiet for the shipped `AGENT_QUIET_MS`
 * before it gives up its chair, because a demo that lies about the timing is a demo of a different
 * program.
 */
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer } from '../server/hub';
import { MODEL, MODEL_ALT, Stage, say, task, thinking, toolUse } from './promo/stage';

const PORT = 7411;
/** Under the OS temp directory, so there is no path by which the demo could reach a real transcript. */
const ROOT = join(tmpdir(), 'roundtable-demo-root');

const A = 'demo-7f2a91';
const B = 'demo-9c4d20';

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** The first cast: one scout per thing worth looking at, which is what a fan-out actually looks like. */
const AGENTS = [
  { id: 'a7f2c1', desc: 'map the retry paths', type: 'Explore' },
  { id: 'b3e94d', desc: 'hunt races in the scheduler', type: 'general-purpose' },
  { id: 'c81a05', desc: 'read the backoff implementation', type: 'Explore' },
  { id: 'd5f620', desc: 'profile the cold start', type: 'general-purpose' },
  { id: 'e04b7c', desc: 'sweep the type errors', type: 'general-purpose' },
  { id: 'f19d38', desc: 'review the auth middleware', type: 'code-reviewer' },
] as const;

/**
 * The overflow. `MAX_SEATS` is 13, so eleven more puts four people on the off-site strip — which is
 * the only way to see that the strip is real without running a genuinely large session yourself.
 */
const CROWD = Array.from({ length: 11 }, (_, i) => ({
  id: `c${String(i + 20).padStart(2, '0')}a`,
  desc: ['verify a finding', 'refute a finding', 'check one call site'][i % 3] ?? 'verify a finding',
  type: 'general-purpose',
}));

/** Rotated through forever, so the room keeps moving without ever repeating the same second. */
const CHATTER: readonly (readonly [string, string])[] = [
  ['thinking', 'the backoff and the request timeout share one clock'],
  ['tool', 'src/scheduler/retry.ts'],
  ['thinking', 'this fixture is doing more than the test claims'],
  ['say', 'CONFIRMED: the token expiry check uses < where it needs <=.'],
  ['tool', 'src/auth/middleware.ts'],
  ['thinking', 'cold start is dominated by one synchronous read'],
  ['say', 'REFUTED: the scheduler suite is not flaky. Its fixture leaks a fake timer.'],
  ['tool', 'src/scheduler/queue.ts'],
];

async function main(): Promise<void> {
  const stage = new Stage(ROOT);
  stage.addSession({ sessionId: A, slug: 'C--work-pathfinder', cwd: 'C:\\work\\pathfinder', name: 'pathfinder-1' });
  stage.addSession({
    sessionId: B,
    slug: 'C--work-pathfinder-api',
    cwd: 'C:\\work\\pathfinder-api',
    name: 'pathfinder-api-2',
  });
  stage.register(A, process.pid);
  stage.register(B, process.pid);

  stage.human(A, 'audit the release branch before we ship — I want a verdict on every risk you find');
  stage.assistant(
    A,
    [
      thinking('the retry path is the one nobody has read since it was written'),
      say('Fanning out: scouts first, then a verifier on anything they claim.'),
      toolUse('tu-grep-1', 'Grep', { pattern: 'retryWithBackoff', path: 'src' }),
    ],
    { tokens: { in: 4200, out: 380, cacheRead: 18_000 } },
  );
  stage.toolResult(A, 'tu-grep-1', '11 matches across 4 files');

  stage.human(B, 'get the contract tests green on the api branch');
  stage.assistant(B, [say('Reading the failing contract first.'), toolUse('tb-1', 'Read', { file_path: 'api/contract.ts' })], {
    model: MODEL,
    tokens: { in: 2800, out: 190 },
  });

  const aliveA: string[] = [];
  const aliveB: string[] = [];

  let stop: (() => Promise<void>) | undefined;
  try {
    stop = await startServer(ROOT, PORT, { usePolling: true, interval: 200 });
  } catch (err) {
    // The one failure worth explaining rather than stack-tracing: the app is already running.
    console.error(
      `\n[demo] could not take port ${PORT}. Roundtable is probably already running in another terminal — ` +
        `stop it (by port, the servers outlive the npm wrapper) and try again.\n`,
    );
    throw err;
  }
  console.log(`[demo] hub on ${PORT}, watching the synthetic root ${ROOT}`);
  console.log('[demo] open http://localhost:5173 — this is a staged session, not one of yours');

  /**
   * A registration goes stale after 90s and this runs for as long as you leave it open, so the tabs
   * need re-stamping. `keepAlive` is the other half: an agent nobody writes to is an agent the hub
   * correctly believes has finished, so staying on the floor has to be said out loud, every few
   * seconds, for everyone who has not been dropped from the set.
   */
  const ticker = setInterval(() => {
    stage.heartbeat(process.pid);
    stage.keepAlive(A, aliveA);
    stage.keepAlive(B, aliveB);
  }, 3000);

  const shutdown = (): void => {
    clearInterval(ticker);
    void stop?.().finally(() => {
      rmSync(ROOT, { recursive: true, force: true });
      process.exit(0);
    });
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  // ---------------------------------------------------------------- the room fills up
  stage.assistant(
    A,
    AGENTS.slice(0, 3).map((a, i) => task(`tu-task-${i + 1}`, a.desc, a.type)),
    { tokens: { in: 5100, out: 260, cacheRead: 22_000 } },
  );
  AGENTS.slice(0, 3).forEach((a, i) => {
    stage.spawn(A, a.id, { toolUseId: `tu-task-${i + 1}`, description: a.desc, agentType: a.type, prompt: a.desc });
    aliveA.push(a.id);
  });
  await wait(6000);

  stage.agentSays(A, AGENTS[0].id, [thinking('the backoff and the request timeout share one clock')]);
  stage.agentSays(A, AGENTS[1].id, [toolUse('t-b-1', 'Grep', { pattern: 'setTimeout', path: 'src/scheduler' })]);
  stage.agentSays(A, AGENTS[2].id, [toolUse('t-c-1', 'Read', { file_path: 'src/scheduler/retry.ts' })]);
  await wait(9000);

  stage.assistant(
    A,
    AGENTS.slice(3).map((a, i) => task(`tu-task-${i + 4}`, a.desc, a.type)),
    { tokens: { in: 6400, out: 340, cacheRead: 31_000 } },
  );
  AGENTS.slice(3).forEach((a, i) => {
    stage.spawn(A, a.id, { toolUseId: `tu-task-${i + 4}`, description: a.desc, agentType: a.type, prompt: a.desc });
    aliveA.push(a.id);
  });
  await wait(9000);

  stage.agentSays(A, AGENTS[3].id, [thinking('cold start is dominated by one synchronous read')]);
  stage.agentSays(A, AGENTS[4].id, [toolUse('t-e-1', 'Bash', { command: 'npx tsc --noEmit' })]);
  stage.agentSays(A, AGENTS[5].id, [toolUse('t-f-1', 'Read', { file_path: 'src/auth/middleware.ts' })]);
  await wait(8000);

  // ---------------------------------------------------------------- somebody reports back
  stage.agentToolResult(A, AGENTS[1].id, 't-b-1', '11 matches');
  stage.agentSays(A, AGENTS[1].id, [say('Three suites touch the retry path and two of them share a fixture.')], {
    tokens: { in: 3100, out: 410 },
  });
  await wait(10_000);

  // ---------------------------------------------------------------- the two verdicts
  stage.agentToolResult(A, AGENTS[2].id, 't-c-1', 'read 240 lines');
  stage.agentSays(A, AGENTS[2].id, [say('REFUTED: the scheduler suite is not flaky. Its fixture leaks a fake timer.')], {
    tokens: { in: 5200, out: 520 },
  });
  await wait(9000);

  stage.agentToolResult(A, AGENTS[5].id, 't-f-1', 'read 96 lines');
  stage.agentSays(A, AGENTS[5].id, [say('CONFIRMED: the token expiry check uses < where it needs <=.')], {
    tokens: { in: 4400, out: 470 },
  });
  await wait(9000);

  // ---------------------------------------------------------------- more agents than chairs
  stage.assistant(
    A,
    CROWD.map((c, i) => task(`tu-crowd-${i}`, c.desc, c.type)),
    { tokens: { in: 7100, out: 640, cacheRead: 44_000 } },
  );
  CROWD.forEach((c, i) => {
    stage.spawn(A, c.id, { toolUseId: `tu-crowd-${i}`, description: c.desc, agentType: c.type, prompt: c.desc });
    aliveA.push(c.id);
  });
  await wait(9000);

  // ---------------------------------------------------------------- the second session
  stage.assistant(B, [task('tb-task-1', 'reproduce the contract failure', 'general-purpose')], {
    model: MODEL,
    tokens: { in: 3300, out: 210 },
  });
  stage.spawn(B, 'aa5501', {
    toolUseId: 'tb-task-1',
    description: 'reproduce the contract failure',
    agentType: 'general-purpose',
    prompt: 'reproduce the contract failure',
  });
  aliveB.push('aa5501');
  stage.agentSays(B, 'aa5501', [toolUse('tb-a-1', 'Bash', { command: 'npm run test:contract' })], { model: MODEL_ALT });
  await wait(4000);

  // The last line before the loop belongs to session A on purpose: with no pinned session the app
  // opens on whichever transcript was touched most recently, and landing on the two-person room
  // when there is an eighteen-person one next to it is a bad first frame. It also puts a real
  // cache-heavy response in the totals, which is where most of a session's tokens actually go.
  stage.assistant(A, [say('Collating what came back.')], {
    tokens: { in: 9700, out: 880, cacheRead: 96_000, cacheWrite: 12_000 },
  });

  console.log('[demo] the room is up. Leave it running; people will keep arriving and leaving.');

  // ---------------------------------------------------------------- and then it keeps going
  //
  // A still room reads as a broken one, so the demo never finishes. Every twelve seconds somebody
  // says something; every fourth turn the longest-serving scout stops being kept alive — which is
  // the only way an agent ever leaves — and a replacement is spawned a beat later. Nobody is
  // deleted and nothing is rewritten: leaving is the absence of a write, exactly as it is live.
  let turn = 0;
  let hired = 0;
  for (;;) {
    const beat = CHATTER[turn % CHATTER.length];
    const target = aliveA[turn % Math.max(aliveA.length, 1)];
    if (beat && target) {
      const [kind, text] = beat;
      if (kind === 'thinking') stage.agentSays(A, target, [thinking(text)]);
      else if (kind === 'say') stage.agentSays(A, target, [say(text)], { tokens: { in: 3400, out: 380 } });
      else stage.agentSays(A, target, [toolUse(`t-loop-${turn}`, 'Read', { file_path: text })]);
    }

    if (turn > 0 && turn % 4 === 0 && aliveA.length > 6) {
      const leaving = aliveA.shift();
      if (leaving) console.log(`[demo] ${leaving} has finished — it will give up its chair and go`);

      hired += 1;
      const id = `n${String(hired).padStart(2, '0')}b7`;
      const desc = 'check one more call site';
      stage.assistant(A, [task(`tu-hire-${hired}`, desc, 'general-purpose')], {
        tokens: { in: 5400, out: 240, cacheRead: 38_000 },
      });
      stage.spawn(A, id, { toolUseId: `tu-hire-${hired}`, description: desc, agentType: 'general-purpose', prompt: desc });
      aliveA.push(id);
    }

    turn += 1;
    await wait(12_000);
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
