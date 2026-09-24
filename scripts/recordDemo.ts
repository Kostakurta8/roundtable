/**
 * `npx tsx scripts/recordDemo.ts`: the hosted demo's recording, made by the shipped hub.
 *
 * The page on GitHub Pages has no hub to talk to, so it replays one. What it replays is not a
 * mock-up of the protocol: this stages the same room `--demo` does (`./promo/demoRoom.ts`), starts
 * the real hub in-process on a loopback port nobody else is told about, connects to it exactly as
 * the page does, and writes down every frame the hub sends — `hello`, the rosters, the resets, the
 * backlogs, and every event — with the moment it arrived. The static build feeds those frames back
 * through the same `onMsg` a socket would, so the store, the office and every panel under them are
 * the ones a real session gets. Only the transport is swapped.
 *
 * It follows nothing. Both staged sessions are registered to this process's own pid, so the hub
 * attaches them by itself, and a socket that never sends `follow` records the tabs the page would
 * open on rather than a particular choice.
 *
 * The run is as long as the demo's own schedule needs for the room to fill, the two verdicts to
 * land and people to leave — and leaving is slow on purpose: an agent goes only after the shipped
 * `AGENT_QUIET_MS` of silence, which this deliberately does not shorten. A demo that walked people
 * out sooner would be a demo of a different program. So it stops a few seconds after the
 * `LEAVES`th agent is declared done, about four minutes in.
 *
 * Nothing here reads anything from this machine: the transcripts are written by `stage.ts` under
 * the OS temp directory, and the output is checked for that directory's path before it is written,
 * because the one frame that naturally carries it (`hello.root`) is rewritten below.
 *
 *   npx tsx scripts/recordDemo.ts               # the committed recording
 *   npx tsx scripts/recordDemo.ts --seconds=20  # a short one, for poking at the format
 */
import { mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import { isEv, type Ev } from '../shared/events';
import type { ServerMsg, SessionSummary } from '../shared/protocol';
import { startServer } from '../server/hub';
import { DEMO_SESSIONS, stageDemoRoom } from './promo/demoRoom';

const OUT = join('src', 'demo', 'recording.json');

/** How many agents must have walked out before the recording is long enough. */
const LEAVES = 2;
/** After the last of them is declared done: long enough to walk to the door and through it. */
const TAIL_MS = 10_000;
/** A ceiling, so a schedule change that means nobody ever leaves cannot record for ever. */
const MAX_MS = 330_000;

/**
 * What `hello.root` says instead of the temp directory the hub was really pointed at. The page only
 * prints it on the empty-machine panel, which a demo with two sessions never shows — but a path
 * under somebody's temp directory has no business being published either way.
 */
const STAGED_ROOT = '(a staged demo root)';

type Frame = [at: number, msg: ServerMsg | Ev];

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

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Every absolute time in a frame, made relative to the start of the recording.
 *
 * Stored relative so the player can put them back on *its* clock: the store and the panels judge
 * "working" and "4s ago" against `Date.now()`, so a room replayed with last year's timestamps would
 * be a room of people who all went quiet a year ago.
 */
function relative(msg: ServerMsg | Ev, t0: number): ServerMsg | Ev {
  // `mtime` is a float off `statSync`; the sub-millisecond part is noise nobody can see, and it is
  // most of the digits.
  const shiftRows = (rows: SessionSummary[]): SessionSummary[] =>
    rows.map((s) => ({ ...s, mtime: Math.round(s.mtime - t0) }));
  if (isEv(msg)) {
    if (msg.kind === 'workflowPhase') {
      return {
        ...msg,
        ts: msg.ts - t0,
        phases: msg.phases.map((p) => ({
          ...p,
          agents: p.agents.map((a) => (a.queuedAt === undefined ? a : { ...a, queuedAt: a.queuedAt - t0 })),
        })),
      };
    }
    return { ...msg, ts: msg.ts - t0 };
  }
  if (msg.kind === 'hello') return { ...msg, root: STAGED_ROOT, sessions: shiftRows(msg.sessions) };
  if (msg.kind === 'roster') return { ...msg, sessions: shiftRows(msg.sessions) };
  return msg;
}

async function main(): Promise<void> {
  const arg = process.argv.find((a) => a.startsWith('--seconds='));
  const fixedMs = arg ? Math.max(1, Number(arg.slice('--seconds='.length))) * 1000 : null;
  if (fixedMs !== null && !Number.isFinite(fixedMs)) throw new Error(`not a number of seconds: ${arg}`);

  const root = mkdtempSync(join(tmpdir(), 'roundtable-demo-record-'));
  const room = stageDemoRoom(root, (line) => console.log(`[record] ${line}`));

  // Both sessions' opening lines are written in the same instant, the api session's last, so the
  // hub's newest-first roster would put the two-person room first — and a page with nothing pinned
  // opens on `sessions[0]`. Touching the other transcript (a new mtime, not a byte written) makes
  // the first frame the room the demo is actually about. It is the same judgement `demoRoom.ts`
  // makes by writing session A last before its loop, made for a viewer who arrives at second zero.
  await sleep(25);
  const [busy] = DEMO_SESSIONS;
  for (const slug of readdirSync(join(root, 'projects'))) {
    const file = join(root, 'projects', slug, `${busy}.jsonl`);
    try {
      utimesSync(file, new Date(), new Date());
    } catch {
      // not this project's session
    }
  }

  const port = await freePort();
  const stop = await startServer(root, port, { usePolling: true, interval: 200, onError: () => {} });
  const frames: Frame[] = [];
  const t0 = Date.now();
  let span = 0;

  try {
    await new Promise<void>((resolve, reject) => {
      const sock = new WebSocket(`ws://127.0.0.1:${port}/ws`);
      let left = 0;
      let done: NodeJS.Timeout | null = null;
      const finish = (): void => {
        // The end of the take, not the last frame: the tail is silence on the wire and walking on
        // screen, and the player's hold is counted from here so the last agent out gets all of it.
        span = Date.now() - t0;
        clearTimeout(ceiling);
        if (done) clearTimeout(done);
        sock.close();
        resolve();
      };
      const ceiling = setTimeout(() => {
        if (fixedMs === null) console.warn(`[record] only ${left} of ${LEAVES} agents left before the ${MAX_MS / 1000}s ceiling`);
        finish();
      }, fixedMs ?? MAX_MS);

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
        if (!msg || typeof msg !== 'object') return;
        const at = Date.now() - t0;
        frames.push([at, relative(msg as ServerMsg | Ev, t0)]);
        if (fixedMs !== null || !isEv(msg) || msg.kind !== 'agentDone') return;
        left += 1;
        console.log(`[record] ${msg.ref.agentId} is done, ${(at / 1000).toFixed(1)}s in (${left}/${LEAVES})`);
        if (left === LEAVES) done = setTimeout(finish, TAIL_MS);
      });
    });
  } finally {
    room.stop();
    await stop();
    rmSync(root, { recursive: true, force: true });
  }

  // One frame per line: small enough to commit, and a re-recording diffs as a list of frames rather
  // than as one line that changed.
  const body = frames.map((f) => JSON.stringify(f)).join(',\n');
  const json = `{"v":1,"span":${span},"frames":[\n${body}\n]}\n`;
  // The staged root is the one machine-specific string that could have ridden along; say so loudly
  // rather than publish it. JSON escapes Windows backslashes, so the path is checked both ways.
  for (const needle of [root, JSON.stringify(root).slice(1, -1)]) {
    if (json.includes(needle)) throw new Error(`the recording mentions the staged root ${root}; refusing to write it`);
  }
  writeFileSync(OUT, json);

  const evs = frames.filter(([, m]) => isEv(m)).length;
  console.log(`[record] ${frames.length} frames (${evs} events) over ${(span / 1000).toFixed(1)}s → ${OUT}, ${(json.length / 1024).toFixed(1)} KiB`);
  // The staging ticker and the hub's timers are all cleared or unref'd, but chokidar's poller is
  // not ours to wait on.
  process.exit(0);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
