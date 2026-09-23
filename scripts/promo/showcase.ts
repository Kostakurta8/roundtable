/**
 * A finished fan-out session, written in one go on a virtual clock — for `--demo --gif`, and for
 * the timelapse at the top of the README.
 *
 * `demoRoom.ts` stages a session *live*, a line every few seconds, because it is watched as it
 * happens. A clip needs the opposite: a whole run that is already over. So this writes about
 * twenty minutes of a session in a few milliseconds, every line stamped with the minute it would
 * have happened at, and the clip reads the timestamps rather than the file times.
 *
 * The shape is the one that makes subagents worth watching: an orchestrator that maps a service
 * with six scouts, hands eight changes to eight builders, and puts a verifier on every one — and
 * one verifier says no, so a ninth builder is sent to fix it and a ninth verifier to check the fix.
 * The content is invented, the way the trailer's is, so that nothing of anybody's appears in it.
 *
 * Deterministic: the jitter comes from a seeded generator, so the same code stages the same bytes
 * and the GIF in the README can be regenerated exactly.
 */
import { MODEL, MODEL_ALT, say, Stage, thinking, toolUse } from './stage';

export const SHOWCASE_SESSION = '9b1c2d3e-4f50-4617-8a9b-0c1d2e3f4a5b';
const SLUG = 'C--work-billing';

/** The virtual start: a Thursday morning. Only the differences matter; the wall clock shows it. */
const T0 = Date.UTC(2026, 8, 17, 9, 12, 0);

/** mulberry32 — small, seeded, and enough to keep twenty people from moving in lockstep. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Job = { id: string; desc: string; files: string[]; report: string };

const SCOUTS: Job[] = [
  { id: 'a41c09e7b25d3f816', desc: 'map the queue consumers', files: ['billing/consumers/invoice.ts', 'billing/consumers/refund.ts', 'billing/queue.ts'], report: 'Three consumers. Two ack before the ledger write lands.' },
  { id: 'b72e5d10c9a84f3e2', desc: 'list every retry path', files: ['billing/retry.ts', 'lib/backoff.ts', 'billing/consumers/invoice.ts'], report: 'Retries are unbounded in two places and capped at 5 in one.' },
  { id: 'c3f8a61d2e7b09c54', desc: 'read the ledger writer', files: ['ledger/write.ts', 'ledger/schema.sql', 'ledger/txn.ts'], report: 'The ledger write is not idempotent; a replay posts twice.' },
  { id: 'd9e04b7a1c5f26d83', desc: 'trace the webhook handler', files: ['api/webhooks/stripe.ts', 'api/middleware/raw.ts'], report: 'Signatures are checked after the body is parsed, not before.' },
  { id: 'e15b3c8f0a6d47e91', desc: 'inventory the feature flags', files: ['config/flags.ts', 'billing/cutover.ts'], report: 'No flag guards the cutover; it would switch everyone at once.' },
  { id: 'f60d2a9e8b3c15a47', desc: 'find the cron jobs', files: ['jobs/cron.ts', 'jobs/nightly-invoices.ts', 'infra/schedule.yml'], report: 'Two cron jobs still enqueue on the old queue directly.' },
];

const BUILDS: Job[] = [
  { id: '1a9f3e7c5b2d8046e', desc: 'fix the ack order', files: ['billing/consumers/invoice.ts', 'billing/consumers/refund.ts'], report: 'Acks now follow the ledger write in both consumers.' },
  { id: '2b8e4d6a3c1f9057d', desc: 'cap the retries', files: ['billing/retry.ts', 'lib/backoff.ts'], report: 'Every retry path is capped at 5 with jittered backoff.' },
  { id: '3c7d5e9b2a4f8163c', desc: 'make ledger writes idempotent', files: ['ledger/write.ts', 'ledger/schema.sql'], report: 'Ledger writes carry an idempotency key now.' },
  { id: '4d6c8f1a9e3b2574b', desc: 'check webhook signatures first', files: ['api/webhooks/stripe.ts', 'api/middleware/raw.ts'], report: 'The raw body is verified before anything parses it.' },
  { id: '5e5b7a2c8d4f3681a', desc: 'flag-gate the cutover', files: ['config/flags.ts', 'billing/cutover.ts'], report: 'The cutover sits behind billing.newQueue, off by default.' },
  { id: '6f4a9b3d7c5e1792f', desc: 'move cron to the new queue', files: ['jobs/cron.ts', 'jobs/nightly-invoices.ts'], report: 'Both cron jobs enqueue through the new client.' },
  { id: '7a3b1c4e6d8f2803e', desc: 'add a dead-letter queue', files: ['billing/dlq.ts', 'infra/queues.yml'], report: 'Poison messages land in billing-dlq after 5 tries.' },
  { id: '8b2c3d5f7e9a1914d', desc: 'emit queue metrics', files: ['billing/metrics.ts', 'lib/telemetry.ts'], report: 'Depth, age and retries are exported per consumer.' },
];

/** The one change the verifier sends back. */
const REFUTED = 2;
const FIX: Job = {
  id: '9c1d2e6a8f3b4025c',
  desc: 'fix the double write on retry',
  files: ['ledger/write.ts', 'ledger/txn.ts'],
  report: 'The key is checked inside the transaction now, so a racing retry is a no-op.',
};

export function stageShowcase(root: string): { sessionId: string } {
  const stage = new Stage(root);
  const sid = SHOWCASE_SESSION;
  stage.addSession({ sessionId: sid, slug: SLUG, cwd: 'C:\\work\\billing', name: 'billing-3' });

  const r = rng(0x5eed);
  const q: { t: number; n: number; fn: () => void }[] = [];
  let order = 0;
  const at = (t: number, fn: () => void): void => {
    q.push({ t, n: order++, fn });
  };
  let tu = 0;
  const tid = (): string => `toolu_${String(++tu).padStart(4, '0')}`;

  // ---------------------------------------------------------------- one child's whole run
  /**
   * A child from spawn to report, and the parent's result for its `Task` landing after that, which
   * is what walks it out of the door. Returns when it reported, so a verifier can follow it.
   */
  const child = (job: Job, start: number, kind: 'scout' | 'build' | 'verify', spawnId: string, outcome?: 'ok' | 'err'): number => {
    let t = start;
    at(t, () =>
      stage.spawn(sid, job.id, {
        toolUseId: spawnId,
        description: job.desc,
        agentType: kind === 'scout' ? 'Explore' : 'general-purpose',
        model: kind === 'build' ? MODEL : MODEL_ALT,
        prompt: `${job.desc}. Report what you find in two sentences.`,
      }),
    );
    const steps = kind === 'scout' ? 4 + Math.floor(r() * 3) : kind === 'build' ? 5 + Math.floor(r() * 3) : 3 + Math.floor(r() * 2);
    let first = true;
    for (let i = 0; i < steps; i++) {
      t += 9_000 + r() * 22_000;
      const id = tid();
      const file = job.files[i % job.files.length];
      const tool =
        kind === 'scout'
          ? (['Grep', 'Read', 'Glob', 'Read'] as const)[i % 4]
          : kind === 'build'
            ? i === steps - 1
              ? 'Bash'
              : (['Read', 'Edit', 'Edit', 'Bash', 'Edit'] as const)[i % 5]
            : (['Read', 'Bash', 'Read'] as const)[i % 3];
      const input: Record<string, unknown> =
        tool === 'Grep'
          ? { pattern: 'enqueue|ack\\(', path: file.split('/')[0] }
          : tool === 'Glob'
            ? { pattern: `${file.split('/')[0]}/**/*.ts` }
            : tool === 'Bash'
              ? { command: 'npm test -- billing', description: 'run the billing suite' }
              : tool === 'Edit'
                ? { file_path: file, old_string: 'ack()', new_string: 'await write(); ack()' }
                : { file_path: file };
      const blocks: unknown[] = [];
      if (i === 1 && r() < 0.6) blocks.push(thinking(`${job.desc} — start where it touches ${file.split('/').pop()}`));
      blocks.push(toolUse(id, tool, input));
      const tokens = first
        ? { in: 1200, out: 180 + Math.round(r() * 300), cacheWrite: 38_000 + Math.round(r() * 12_000) }
        : { in: 600, out: 150 + Math.round(r() * 600), cacheRead: 40_000 + Math.round(r() * 30_000 * (i + 1)) };
      first = false;
      at(t, () => stage.agentSays(sid, job.id, blocks, { model: kind === 'build' ? MODEL : MODEL_ALT, tokens }));
      // Some builds fail a test run on the way and have to go round again.
      const fails = kind === 'build' && tool === 'Bash' && i < steps - 1 && r() < 0.5;
      at(t + 2_000 + r() * 6_000, () =>
        stage.agentToolResult(sid, job.id, id, fails ? 'FAIL billing/consumer.test.ts — expected 1 ledger row, got 2' : 'ok'),
      );
    }
    t += 6_000 + r() * 8_000;
    const report = kind === 'verify' ? (outcome === 'err' ? `REFUTED — ${job.report}` : `CONFIRMED — ${job.report}`) : job.report;
    at(t, () => stage.agentSays(sid, job.id, [say(report)], { tokens: { in: 500, out: 260, cacheRead: 90_000 } }));
    // The parent hears back a beat later, and that result is what lets the child go home.
    at(t + 3_000, () => stage.toolResult(sid, spawnId, report));
    return t + 3_000;
  };

  /** The orchestrator opening several `Task` calls in one response. */
  const fanOut = (t: number, line: string, jobs: { job: Job; spawnId: string }[]): void => {
    at(t, () =>
      stage.assistant(
        sid,
        [
          say(line),
          ...jobs.map(({ job, spawnId }) =>
            toolUse(spawnId, 'Task', { description: job.desc, prompt: job.desc, subagent_type: 'general-purpose', run_in_background: false }),
          ),
        ],
        { model: MODEL, tokens: { in: 5200, out: 700 + jobs.length * 90, cacheRead: 140_000 } },
      ),
    );
  };

  // ---------------------------------------------------------------- the run
  at(0, () =>
    stage.human(sid, "migrate billing off the old job queue — split the work up, and verify every change before you tell me it's done"),
  );
  at(4_000, () =>
    stage.assistant(sid, [thinking('the queue is touched in more places than the README admits'), toolUse('toolu_g1', 'Grep', { pattern: 'enqueue', path: 'billing' })], {
      model: MODEL,
      tokens: { in: 8_400, out: 420, cacheWrite: 46_000 },
    }),
  );
  at(7_000, () => stage.toolResult(sid, 'toolu_g1', '23 matches across 9 files'));

  // Six scouts, staggered the way a real fan-out lands: one response, children starting a beat apart.
  const scoutIds = SCOUTS.map(() => tid());
  fanOut(12_000, 'Mapping it first: six scouts, one per corner of the service.', SCOUTS.map((job, i) => ({ job, spawnId: scoutIds[i] })));
  let scoutsBack = 0;
  SCOUTS.forEach((job, i) => {
    scoutsBack = Math.max(scoutsBack, child(job, 13_500 + i * 1_400, 'scout', scoutIds[i]));
  });

  // Eight builders once the map is in, and a verifier on each as it finishes.
  const planAt = scoutsBack + 8_000;
  at(planAt - 3_000, () =>
    stage.assistant(sid, [thinking('eight independent changes; the ledger one is the dangerous one')], { model: MODEL, tokens: { in: 9_000, out: 380, cacheRead: 150_000 } }),
  );
  const buildIds = BUILDS.map(() => tid());
  fanOut(planAt, 'Scouts are back. Eight changes, one builder each, and a verifier on every one.', BUILDS.map((job, i) => ({ job, spawnId: buildIds[i] })));
  let lastVerdict = 0;
  let refutedAt = 0;
  BUILDS.forEach((job, i) => {
    const done = child(job, planAt + 1_500 + i * 1_200, 'build', buildIds[i]);
    const v: Job = { id: `v${job.id.slice(1)}`, desc: `verify: ${job.desc}`, files: job.files, report: job.report };
    const vid = tid();
    const vStart = done + 4_000;
    at(vStart - 1_000, () =>
      stage.assistant(
        sid,
        [toolUse(vid, 'Task', { description: v.desc, prompt: v.desc, subagent_type: 'general-purpose', run_in_background: false })],
        { model: MODEL, tokens: { in: 2_200, out: 240, cacheRead: 160_000 } },
      ),
    );
    const refute = i === REFUTED;
    if (refute) v.report = 'a racing retry still posts the invoice twice.';
    const back = child(v, vStart, 'verify', vid, refute ? 'err' : 'ok');
    if (refute) refutedAt = back;
    lastVerdict = Math.max(lastVerdict, back);
  });

  // The refutation sends a ninth builder, and a ninth verifier after it.
  const fixId = tid();
  at(refutedAt + 5_000, () =>
    stage.assistant(
      sid,
      [
        say('Refuted on the ledger. Sending a fix before anything merges.'),
        toolUse(fixId, 'Task', { description: FIX.desc, prompt: FIX.desc, subagent_type: 'general-purpose', run_in_background: false }),
      ],
      { model: MODEL, tokens: { in: 3_100, out: 310, cacheRead: 170_000 } },
    ),
  );
  const fixDone = child(FIX, refutedAt + 6_000, 'build', fixId);
  const recheck: Job = { id: '0d9e8f7a6b5c4d3e2', desc: 'verify: the ledger fix', files: FIX.files, report: 'a replayed message leaves exactly one ledger row.' };
  const recheckId = tid();
  at(fixDone + 3_000, () =>
    stage.assistant(sid, [toolUse(recheckId, 'Task', { description: recheck.desc, prompt: recheck.desc, subagent_type: 'general-purpose', run_in_background: false })], {
      model: MODEL,
      tokens: { in: 2_000, out: 220, cacheRead: 175_000 },
    }),
  );
  const end = Math.max(lastVerdict, child(recheck, fixDone + 4_000, 'verify', recheckId, 'ok'));
  at(end + 6_000, () =>
    stage.assistant(sid, [say('All eight changes verified; one was refuted and fixed. Ready to merge behind billing.newQueue.')], {
      model: MODEL,
      tokens: { in: 6_000, out: 520, cacheRead: 190_000 },
    }),
  );

  q.sort((a, b) => a.t - b.t || a.n - b.n);
  for (const e of q) {
    stage.clock = () => T0 + e.t;
    e.fn();
  }
  return { sessionId: sid };
}


