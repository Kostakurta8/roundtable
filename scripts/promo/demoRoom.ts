/**
 * The demo room, as a thing that can be staged from anywhere.
 *
 * Roundtable normally watches `~/.claude`, which means a machine that has never run Claude Code —
 * or has, but is running nothing now — opens on an empty floor. That is an honest picture of an
 * empty session and a terrible first impression, so this is the other thing to point the hub at:
 * a synthetic `~/.claude` root that this module writes, and keeps writing.
 *
 * It reuses `./stage`, the movie set built for the trailer. Nothing here reads or copies anything
 * from the machine it runs on — every line is written by that file, so no prompt, path, project
 * name or session id from a real session can appear in the demo. Every write lands under the root
 * it is handed, and the callers hand it a directory under the OS temp directory.
 *
 * What it is *not* is a simulation. The lines go to disk and are picked up by the watcher, parsed,
 * normalized, broadcast over the same WebSocket and folded by the same store as a real session's.
 * The pipeline you are watching is the shipped one; only the content is invented.
 *
 * Two callers: `scripts/demo.ts` (`npm run demo`, from a clone, beside Vite) and `server/cli.ts`
 * (`claude-roundtable --demo`, the installed binary serving its own page). The hub's own timing
 * defaults are untouched in both: an agent that stops being written to goes quiet for the shipped
 * `AGENT_QUIET_MS` before it gives up its chair, because a demo that lies about the timing is a
 * demo of a different program.
 */
import { MODEL, MODEL_ALT, Stage, say, task, thinking, toolUse } from './stage';

/** The two staged sessions, so a test can ask the roster for them by name. */
export const DEMO_SESSIONS = ['demo-7f2a91', 'demo-9c4d20'] as const;
const [A, B] = DEMO_SESSIONS;

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

export type DemoRoom = {
  /** Where the transcripts are being written. */
  root: string;
  /** Stops writing. Nothing is deleted here — the caller owns the directory it handed in. */
  stop: () => void;
};

/**
 * Writes the opening of the session synchronously, so a hub started right after this call finds
 * two sessions on its first sweep, then plays the rest out over the next couple of minutes and
 * keeps the room moving for as long as it is left running.
 *
 * `root` is wiped and recreated by `Stage`, so callers pass a directory that is theirs to wipe.
 */
export function stageDemoRoom(root: string, log: (line: string) => void = () => {}): DemoRoom {
  const stage = new Stage(root);
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
  let stopped = false;
  const timers = new Set<ReturnType<typeof setTimeout>>();

  /** A sleep that ends early, and for good, once `stop` has been called. */
  const wait = (ms: number): Promise<void> =>
    new Promise((resolve) => {
      if (stopped) return resolve();
      const t = setTimeout(() => {
        timers.delete(t);
        resolve();
      }, ms);
      timers.add(t);
    });

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

  const play = async (): Promise<void> => {
    // ---------------------------------------------------------------- the room fills up
    await wait(1500);
    if (stopped) return;
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
    if (stopped) return;

    stage.agentSays(A, AGENTS[0].id, [thinking('the backoff and the request timeout share one clock')]);
    stage.agentSays(A, AGENTS[1].id, [toolUse('t-b-1', 'Grep', { pattern: 'setTimeout', path: 'src/scheduler' })]);
    stage.agentSays(A, AGENTS[2].id, [toolUse('t-c-1', 'Read', { file_path: 'src/scheduler/retry.ts' })]);
    await wait(9000);
    if (stopped) return;

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
    if (stopped) return;

    stage.agentSays(A, AGENTS[3].id, [thinking('cold start is dominated by one synchronous read')]);
    stage.agentSays(A, AGENTS[4].id, [toolUse('t-e-1', 'Bash', { command: 'npx tsc --noEmit' })]);
    stage.agentSays(A, AGENTS[5].id, [toolUse('t-f-1', 'Read', { file_path: 'src/auth/middleware.ts' })]);
    await wait(8000);
    if (stopped) return;

    // ---------------------------------------------------------------- somebody reports back
    stage.agentToolResult(A, AGENTS[1].id, 't-b-1', '11 matches');
    stage.agentSays(A, AGENTS[1].id, [say('Three suites touch the retry path and two of them share a fixture.')], {
      tokens: { in: 3100, out: 410 },
    });
    await wait(10_000);
    if (stopped) return;

    // ---------------------------------------------------------------- the two verdicts
    stage.agentToolResult(A, AGENTS[2].id, 't-c-1', 'read 240 lines');
    stage.agentSays(A, AGENTS[2].id, [say('REFUTED: the scheduler suite is not flaky. Its fixture leaks a fake timer.')], {
      tokens: { in: 5200, out: 520 },
    });
    await wait(9000);
    if (stopped) return;

    stage.agentToolResult(A, AGENTS[5].id, 't-f-1', 'read 96 lines');
    stage.agentSays(A, AGENTS[5].id, [say('CONFIRMED: the token expiry check uses < where it needs <=.')], {
      tokens: { in: 4400, out: 470 },
    });
    await wait(9000);
    if (stopped) return;

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
    if (stopped) return;

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
    if (stopped) return;

    // The last line before the loop belongs to session A on purpose: with no pinned session the app
    // opens on whichever transcript was touched most recently, and landing on the two-person room
    // when there is an eighteen-person one next to it is a bad first frame. It also puts a real
    // cache-heavy response in the totals, which is where most of a session's tokens actually go.
    stage.assistant(A, [say('Collating what came back.')], {
      tokens: { in: 9700, out: 880, cacheRead: 96_000, cacheWrite: 12_000 },
    });

    log('the room is up. Leave it running; people will keep arriving and leaving.');

    // ---------------------------------------------------------------- and then it keeps going
    //
    // A still room reads as a broken one, so the demo never finishes. Every twelve seconds somebody
    // says something; every fourth turn the longest-serving scout stops being kept alive — which is
    // the only way an agent ever leaves — and a replacement is spawned a beat later. Nobody is
    // deleted and nothing is rewritten: leaving is the absence of a write, exactly as it is live.
    let turn = 0;
    let hired = 0;
    for (;;) {
      await wait(12_000);
      if (stopped) return;
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
        if (leaving) log(`${leaving} has finished — it will give up its chair and go`);

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
    }
  };

  void play().catch((err: unknown) => {
    // A write failing mid-scene (the temp directory vanished under us) is worth a line, not a
    // crash: the hub is still serving whatever was written, and the person is still watching.
    if (!stopped) log(`the demo stopped writing: ${String(err)}`);
  });

  return {
    root,
    stop: () => {
      stopped = true;
      clearInterval(ticker);
      for (const t of timers) clearTimeout(t);
      timers.clear();
    },
  };
}
