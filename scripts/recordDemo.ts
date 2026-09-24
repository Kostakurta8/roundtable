/**
 * `npx tsx scripts/recordDemo.ts`: the hosted demo's recording, read by the shipped hub.
 *
 * The page on GitHub Pages has no hub to talk to, so it replays one. What it replays is not a
 * mock-up of the protocol. This stages the session the README's timelapse shows
 * (`./promo/showcase.ts`: six scouts, eight builders, a verifier on every change, one refuted and
 * fixed) beside a small second session so the page has tabs, starts the real hub in-process on a
 * loopback port nobody else is told about, and connects to it exactly as the page does. Every
 * event on the page is one the hub sent — the lines it parsed, and the ones it derived, above all
 * the `agentDone` that walks each agent out of the door.
 *
 * What it does not keep is *when* the hub sent them. The showcase is written in one go, stamped
 * across nine minutes, so the hub replays it the way it replays any session that already happened:
 * one burst, and a room that is over before the first frame. `src/demo/timelapse.ts` deals the
 * frames out again on a compressed clock — silences clamped to a beat, the run scaled to
 * `PLAY_MS` — and frames them as a live hub would have: `hello`, a `reset`/backlog/`ready` per
 * session, then one frame per event at its own moment, and a `roster` whenever a transcript moved.
 * The banner says TIMELAPSE because that is what it is.
 *
 * Why not record the `--demo` room live, as this used to: it keeps the hub's real timing, and the
 * real timing of a staged room is a thin story — in 283 seconds, four tool calls came back and two
 * people left. The README's visitors had just watched a much fuller one.
 *
 * Nothing here reads anything from this machine: every transcript is written by `./promo/stage.ts`
 * under the OS temp directory, and the output is checked for this machine's paths before it is
 * written, because the one frame that naturally carries one (`hello.root`) is rewritten by the cut.
 *
 *   npx tsx scripts/recordDemo.ts
 */
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { homedir, hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import { evSession, isEv, type Ev } from '../shared/events';
import type { HelloMsg, ServerMsg } from '../shared/protocol';
import { startServer } from '../server/hub';
import { cut, type Take } from '../src/demo/timelapse';
import { SHOWCASE_SESSION, stageShowcase } from './promo/showcase';
import { MODEL, MODEL_ALT, say, Stage, thinking, toolUse, type SessionSpec } from './promo/stage';

const OUT = join('src', 'demo', 'recording.json');

/**
 * How long the showcase's run plays, first line to last.
 *
 * About seventy seconds is what the story needs at the office's own walking pace: the scouts are
 * seated inside ten, reports are walked over one at a time instead of in a queue, and the fix
 * after the refutation is still a person doing work rather than a blur. Add the tail and the
 * player's hold and the loop comes round in a minute and a half.
 */
const PLAY_MS = 70_000;
/**
 * What a silence the clamp shortened lasts on screen: time for somebody to cross part of the room.
 * The showcase is evenly spaced, so at this length the clamp barely bites and the scale does the
 * work — which is right for it, and still right for a re-staged story with a long wait in it.
 */
const BEAT_MS = 1500;
/**
 * After the last frame. The last verifier's verdict lands a second before the orchestrator's closing
 * line, and from there it still has a whole errand in `src/office/engine.ts` to walk: over to main,
 * a `SPEAK_HOLD_MS` there, back to its chair, up to six seconds of `DONE_LINGER_MS` and its spread,
 * then the door — thirteen to eighteen seconds. Ten, the first guess, restarted the loop with the
 * room emptying a second or two before, so the ending never got to read as an ending.
 */
const TAIL_MS = 15_000;
/** `DEFAULT_ROSTER_MS` in `server/hub.ts`, which does not export it. */
const ROSTER_MS = 4000;
/** After both sessions are ready, how long the hub must stay quiet before the take is complete. */
const SETTLE_MS = 2000;
/** A ceiling, so a hub that never says `ready` cannot hang the recorder. */
const COLLECT_MS = 60_000;

/**
 * What `hello.root` says instead of the temp directory the hub was really pointed at. The page only
 * prints it on the empty-machine panel, which a demo with two sessions never shows — but a path
 * under somebody's temp directory has no business being published either way.
 */
const STAGED_ROOT = '(a staged demo root)';

/**
 * What `stageShowcase` hands its own `addSession`, restated: it writes no registry entry — a clip
 * reads a session that is over and never needed one — and without an entry the hub would neither
 * call it running nor attach it by itself.
 */
const LEAD = { sessionId: SHOWCASE_SESSION, cwd: 'C:\\work\\billing', name: 'billing-3' } as const;

/** The second tab: a two-person session in another repo, so the page shows that tabs exist. */
const SIDE: SessionSpec = {
  sessionId: '4e7a0c19-2b8d-4f63-9a15-7c3e8d2b6f01',
  slug: 'C--work-invoices-web',
  cwd: 'C:\\work\\invoices-web',
  name: 'invoices-web-4',
};

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

/**
 * The CLI's registry entry, which is what makes a session count as running. Our own pid, which is
 * alive for exactly as long as the take, so the hub attaches both sessions without being asked and
 * the socket records the tabs the page would open on rather than a particular choice.
 */
function register(root: string, s: { sessionId: string; cwd: string; name: string }): void {
  writeFileSync(
    join(root, 'sessions', `${s.sessionId}.json`),
    JSON.stringify({ ...s, pid: process.pid, status: 'running', version: '2.1.220', kind: 'cli', startedAt: Date.now(), updatedAt: Date.now() }),
  );
}

/** Every line's timestamp in one transcript, in the order they were written. */
function stamps(file: string): number[] {
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => Date.parse((JSON.parse(l) as { timestamp?: string }).timestamp ?? ''))
    .filter(Number.isFinite);
}

/**
 * The second session, on the showcase's own clock.
 *
 * Its main-transcript lines land a couple of milliseconds before one of the showcase's, never on
 * their own. The roster lists sessions newest first and the tabs keep that order, so a side session
 * that wrote while the busy one was quiet would swap the two tabs over for as long as the quiet
 * lasted — a strip that shuffles itself is the first thing a visitor would read as a glitch. The
 * subagents write whenever they like: only the main transcript dates a session.
 */
function stageSide(dir: string, t0: number, leadWrites: readonly number[]): void {
  const stage = new Stage(dir);
  const sid = SIDE.sessionId;
  stage.addSession(SIDE);
  const at = (ms: number, fn: () => void): void => {
    stage.clock = () => t0 + ms;
    fn();
  };
  /** Just ahead of the showcase's first main-transcript line at or after `from`. */
  const ahead = (from: number): number => {
    const w = leadWrites.find((t) => t - t0 >= from);
    if (w === undefined) throw new Error(`the showcase writes nothing to its main transcript after ${from / 1000}s`);
    return w - t0 - 2;
  };

  const scout = { id: 'e2a7c4f90b3d61852', spawn: 'toolu_s01', desc: 'trace the totals rounding' };
  const build = { id: 'f3b8d5a01c4e72963', spawn: 'toolu_s05', desc: 'round the totals once' };
  const report1 = 'Each line item is rounded before the sum, so a long invoice drifts by a cent.';
  const report2 = 'Totals are summed from the raw amounts and rounded once; every row matches its invoice.';
  const brief = (d: string): string => `${d}. Report what you find in two sentences.`;
  const spawnCall = (id: string, d: string, type: string): unknown =>
    toolUse(id, 'Task', { description: d, prompt: d, subagent_type: type, run_in_background: false });

  // Before the take: already asked, and already fanned out.
  at(-50_000, () => stage.human(sid, 'some invoice totals on the dashboard are a cent off — find out why and fix it'));
  at(-46_000, () =>
    stage.assistant(sid, [thinking('rounding, almost certainly — the question is where'), say('Sending a scout to find where the totals get rounded.'), spawnCall(scout.spawn, scout.desc, 'Explore')], {
      model: MODEL,
      tokens: { in: 3_900, out: 260, cacheWrite: 31_000 },
    }),
  );
  at(-45_000, () => stage.spawn(sid, scout.id, { toolUseId: scout.spawn, description: scout.desc, agentType: 'Explore', model: MODEL_ALT, prompt: brief(scout.desc) }));

  const steps = (agent: string, from: number, list: readonly [ms: number, id: string, tool: string, input: Record<string, unknown>, back: number, result: string][], model: string): void => {
    list.forEach(([ms, id, tool, input, back, result], i) => {
      const tokens = i === 0 ? { in: 1_100, out: 210, cacheWrite: 34_000 } : { in: 600, out: 180 + i * 90, cacheRead: 38_000 + i * 21_000 };
      at(from + ms, () => stage.agentSays(sid, agent, [toolUse(id, tool, input)], { model, tokens }));
      at(from + ms + back, () => stage.agentToolResult(sid, agent, id, result));
    });
  };
  steps(
    scout.id,
    0,
    [
      [18_000, 'toolu_s02', 'Grep', { pattern: 'toFixed|Math.round', path: 'web' }, 2_000, '14 matches across 5 files'],
      [44_000, 'toolu_s03', 'Read', { file_path: 'web/invoices/totals.ts' }, 1_500, 'ok'],
      [72_000, 'toolu_s04', 'Read', { file_path: 'web/invoices/LineItem.tsx' }, 1_000, 'ok'],
    ],
    MODEL_ALT,
  );

  const handback = ahead(110_000);
  at(handback - 9_000, () => stage.agentSays(sid, scout.id, [say(report1)], { tokens: { in: 500, out: 240, cacheRead: 80_000 } }));
  at(handback, () => stage.toolResult(sid, scout.spawn, report1));
  at(handback + 1, () =>
    stage.assistant(sid, [say('Found it. Sending a fix.'), spawnCall(build.spawn, build.desc, 'general-purpose')], {
      model: MODEL,
      tokens: { in: 2_600, out: 220, cacheRead: 52_000 },
    }),
  );
  at(handback + 1_500, () => stage.spawn(sid, build.id, { toolUseId: build.spawn, description: build.desc, agentType: 'general-purpose', model: MODEL, prompt: brief(build.desc) }));
  steps(
    build.id,
    handback,
    [
      [20_000, 'toolu_s06', 'Read', { file_path: 'web/invoices/totals.ts' }, 1_500, 'ok'],
      [44_000, 'toolu_s07', 'Edit', { file_path: 'web/invoices/totals.ts', old_string: 'sum(rounded)', new_string: 'round(sum(raw))' }, 1_000, 'ok'],
      [68_000, 'toolu_s08', 'Bash', { command: 'npm test -- invoices', description: 'run the invoice suite' }, 6_000, 'FAIL invoices/totals.test.ts — expected 1204.37, got 1204.36'],
      [92_000, 'toolu_s09', 'Edit', { file_path: 'web/invoices/LineItem.tsx', old_string: 'round(amount)', new_string: 'amount' }, 1_000, 'ok'],
      [116_000, 'toolu_s10', 'Bash', { command: 'npm test -- invoices', description: 'run the invoice suite' }, 6_000, 'ok'],
    ],
    MODEL,
  );

  const done = ahead(handback + 135_000);
  at(done - 6_000, () => stage.agentSays(sid, build.id, [say(report2)], { model: MODEL, tokens: { in: 500, out: 260, cacheRead: 96_000 } }));
  at(done, () => stage.toolResult(sid, build.spawn, report2));
  at(done + 1, () =>
    stage.assistant(sid, [say('Fixed: the totals round once, after the sum, and the dashboard matches every invoice.')], {
      model: MODEL,
      tokens: { in: 3_000, out: 310, cacheRead: 60_000 },
    }),
  );
}

/**
 * Connects the way the page does and keeps what the hub sends: the `hello`, and each attached
 * session's events from its `reset` on — the backlog, and anything its catch-up read finishes after
 * `ready`, which is why the take waits for the hub to go quiet rather than stopping at the second
 * `ready`. The periodic rosters and bare `ready`s are not kept: the cut makes its own, on its clock.
 */
function collect(port: number, expect: number): Promise<Take> {
  return new Promise<Take>((resolve, reject) => {
    const sock = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    let hello: HelloMsg | null = null;
    const evs = new Map<string, Ev[]>();
    const ready = new Set<string>();
    let quiet: NodeJS.Timeout | null = null;
    const settle = (): void => {
      if (ready.size < expect) return;
      if (quiet) clearTimeout(quiet);
      quiet = setTimeout(finish, SETTLE_MS);
    };
    const finish = (): void => {
      clearTimeout(ceiling);
      sock.close();
      if (!hello) return reject(new Error('the hub never said hello'));
      resolve({ hello, sessions: [...evs].map(([sessionId, list]) => ({ sessionId, evs: list })) });
    };
    const ceiling = setTimeout(() => {
      sock.terminate();
      reject(new Error(`only ${ready.size} of ${expect} sessions were ready after ${COLLECT_MS / 1000}s`));
    }, COLLECT_MS);

    sock.on('error', (err) => {
      clearTimeout(ceiling);
      reject(err);
    });
    sock.on('message', (data) => {
      let msg: unknown;
      try {
        msg = JSON.parse(String(data));
      } catch {
        return;
      }
      if (isEv(msg)) {
        evs.get(evSession(msg))?.push(msg);
        settle();
        return;
      }
      const m = msg as ServerMsg;
      if (m.kind === 'hello') hello = m;
      else if (m.kind === 'reset') evs.set(m.sessionId, []);
      else if (m.kind === 'ready' && evs.has(m.sessionId)) {
        ready.add(m.sessionId);
        settle();
      }
    });
  });
}

async function main(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'roundtable-demo-record-'));
  const side = mkdtempSync(join(tmpdir(), 'roundtable-demo-side-'));
  let json = '';
  let summary = '';
  try {
    stageShowcase(root);
    const [slug] = readdirSync(join(root, 'projects'));
    const leadWrites = stamps(join(root, 'projects', slug, `${LEAD.sessionId}.jsonl`));
    // A `Stage` wipes the directory it is handed, so the second session is staged beside the
    // showcase and moved in, rather than staged into the same root.
    stageSide(side, leadWrites[0], leadWrites);
    cpSync(join(side, 'projects'), join(root, 'projects'), { recursive: true });
    register(root, LEAD);
    register(root, SIDE);

    const port = await freePort();
    const stop = await startServer(root, port, { usePolling: true, interval: 200, backlogLimit: 5_000_000, onError: () => {} });
    let take: Take;
    try {
      take = await collect(port, 2);
    } finally {
      await stop();
    }

    // The one field a hub fills from outside the root it was pointed at: what the terminal on the
    // recording machine calls a session, when it can prove which window is which.
    take = { ...take, hello: { ...take.hello, sessions: take.hello.sessions.map(({ tabTitle: _, ...row }) => row) } };
    const c = cut(take, { lead: LEAD.sessionId, playMs: PLAY_MS, beatMs: BEAT_MS, tailMs: TAIL_MS, rosterMs: ROSTER_MS, root: STAGED_ROOT });

    for (const [at, m] of c.frames) {
      if (isEv(m) || (m.kind !== 'hello' && m.kind !== 'roster')) continue;
      if (m.sessions[0]?.sessionId !== LEAD.sessionId) {
        throw new Error(`at ${at}ms the ${m.kind} lists ${m.sessions[0]?.name} first: the tabs would trade places`);
      }
    }

    // One frame per line: small enough to commit, and a re-recording diffs as a list of frames rather
    // than as one line that changed.
    const body = c.frames.map((f) => JSON.stringify(f)).join(',\n');
    const lapse = JSON.stringify({ realMs: c.realMs, playMs: c.playMs });
    json = `{"v":1,"span":${c.span},"timelapse":${lapse},"frames":[\n${body}\n]}\n`;

    const evs = c.frames.flatMap(([at, m]) => (isEv(m) ? [[at, m] as const] : []));
    const first = (pick: (e: Ev) => boolean): string => {
      const hit = evs.find(([, e]) => pick(e));
      return hit ? `${(hit[0] / 1000).toFixed(1)}s` : 'never';
    };
    const lead = (e: Ev): boolean => evSession(e) === LEAD.sessionId;
    summary = [
      `${c.frames.length} frames (${evs.length} events), ${(c.realMs / 1000).toFixed(0)}s of session in ${(c.playMs / 1000).toFixed(1)}s, span ${(c.span / 1000).toFixed(1)}s`,
      `silences over ${(c.capMs / 1000).toFixed(1)}s clamped; first scout at ${first((e) => lead(e) && e.kind === 'agentSeen' && e.parentToolUseId !== undefined)}, ` +
        `first report ${first((e) => lead(e) && e.kind === 'agentText' && e.ref.agentId !== 'main')}, ` +
        `REFUTED ${first((e) => e.kind === 'agentText' && e.text.startsWith('REFUTED'))}, ` +
        `last told done at ${(Math.max(...evs.filter(([, e]) => e.kind === 'agentDone').map(([at]) => at)) / 1000).toFixed(1)}s`,
    ].join('\n[record] ');
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(side, { recursive: true, force: true });
  }

  // Everything in the file was written by the stage or derived by the hub from it, so nothing of
  // this machine should be able to ride along; say so loudly rather than publish it if it does.
  // JSON escapes Windows backslashes, so each path is checked both ways. Short needles are skipped:
  // a four-letter host name such as `work` is also a word in the staged content, and refusing on
  // it would be a false alarm, while every real path here is longer than that.
  for (const needle of [root, side, homedir(), tmpdir(), hostname()]) {
    if (needle.length < 6) continue;
    for (const form of [needle, JSON.stringify(needle).slice(1, -1)]) {
      if (json.includes(form)) throw new Error(`the recording mentions ${needle} from this machine; refusing to write it`);
    }
  }
  writeFileSync(OUT, json);
  console.log(`[record] ${summary}`);
  console.log(`[record] → ${OUT}, ${(json.length / 1024).toFixed(1)} KiB`);
  // The hub's timers are all cleared or unref'd, but chokidar's poller is not ours to wait on.
  process.exit(0);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
