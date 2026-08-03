/**
 * The parser and the normalizer, against real transcripts — the test the fixtures cannot be.
 *
 * `fixtures/` is seven hand-written synthetic lines, and `fixtures/NOTES.md` says so. That is not a
 * criticism of the fixtures: real transcripts carry secrets and must never be committed, so the
 * repo genuinely cannot hold a realistic corpus. But it left nothing at all checking this code
 * against the data it exists to read, and the cost of that showed up as a headline figure that was
 * roughly half the truth for months — the shape that caused it (one response written as several
 * lines, each repeating that response's usage as it stood) appears in 59% of real subagent
 * responses and in none of the fixtures.
 *
 * So this reads whatever corpus is on the machine running it, asserts invariants rather than
 * values, and **skips itself** when there is nothing to read. Nothing is copied, nothing is
 * written, and no transcript content reaches an assertion message — a failure names a file and a
 * count, never a line.
 */
import { createReadStream, existsSync, readdirSync, statSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { evSession, isEv, type Ev, type TokenUse } from '../shared/events';
import { Normalizer } from '../server/normalize';
import { parseLine } from '../server/parse';
import { claudeRoot } from '../server/sessions';
import { initialState, reduce } from '../src/store';

/** Enough to be representative, few enough that the suite stays a few seconds. */
const FILES = 40;
/** Ragged on purpose, so responses routinely straddle a batch boundary the way they do live. */
const BATCH_SIZES = [1, 3, 7, 2, 5];

const PROJECTS = join(claudeRoot(), 'projects');
const HAVE_CORPUS = existsSync(PROJECTS);

function* walk(dir: string, depth = 0): Generator<string> {
  if (depth > 4) return;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return; // a live directory another process is writing; absent is fine
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* walk(p, depth + 1);
    // `journal.jsonl` is a Workflow's own log, not a transcript, and has a different shape.
    else if (e.name.endsWith('.jsonl') && e.name !== 'journal.jsonl') yield p;
  }
}

/** The most recent transcripts, which are the ones written by the CLI this code has to match. */
function sample(): string[] {
  const all = [...walk(PROJECTS)];
  return all
    .map((f) => ({ f, m: statSync(f).mtimeMs }))
    .sort((a, b) => b.m - a.m)
    .slice(0, FILES)
    .map((x) => x.f);
}

const zero = (): TokenUse => ({ in: 0, out: 0, cacheRead: 0, cacheWrite: 0 });
const plus = (a: TokenUse, b: TokenUse): TokenUse => ({
  in: a.in + b.in,
  out: a.out + b.out,
  cacheRead: a.cacheRead + b.cacheRead,
  cacheWrite: a.cacheWrite + b.cacheWrite,
});

async function lines(file: string): Promise<string[]> {
  const out: string[] = [];
  const rl = createInterface({ input: createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
  for await (const line of rl) if (line.trim()) out.push(line);
  return out;
}

/**
 * Ground truth for one file: for each `message.id`, the usage on its **last** line.
 *
 * Measured across all 2,548 transcripts on the machine this was written on, the last line's figure
 * is always the maximum — a response's usage only ever grows as its blocks are written.
 */
function trueUsage(raw: readonly string[]): TokenUse {
  const last = new Map<string, TokenUse>();
  let anonymous = zero();
  for (const line of raw) {
    let o: { message?: { id?: unknown; usage?: Record<string, unknown> } };
    try {
      o = JSON.parse(line) as typeof o;
    } catch {
      continue;
    }
    const u = o.message?.usage;
    if (!u || (typeof u.input_tokens !== 'number' && typeof u.output_tokens !== 'number')) continue;
    const n = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
    const use: TokenUse = {
      in: n(u.input_tokens),
      out: n(u.output_tokens),
      cacheRead: n(u.cache_read_input_tokens),
      cacheWrite: n(u.cache_creation_input_tokens),
    };
    const id = o.message?.id;
    if (typeof id === 'string') last.set(id, use);
    else anonymous = plus(anonymous, use);
  }
  let total = anonymous;
  for (const u of last.values()) total = plus(total, u);
  return total;
}

/** Feeds a file through the normalizer in ragged batches, flushing once per batch as the hub does. */
function normalized(raw: readonly string[]): Ev[] {
  const n = new Normalizer('corpus', 'main');
  const out: Ev[] = [];
  let i = 0;
  let b = 0;
  while (i < raw.length) {
    const take = BATCH_SIZES[b++ % BATCH_SIZES.length];
    for (const line of raw.slice(i, i + take)) {
      const parsed = parseLine(line);
      if (parsed) out.push(...n.feed(parsed));
    }
    out.push(...n.flush());
    i += take;
  }
  return out;
}

const describeCorpus = HAVE_CORPUS ? describe : describe.skip;

describeCorpus('real transcripts', () => {
  const files = HAVE_CORPUS ? sample() : [];

  it('found something to read', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it('reports exactly what every response really billed', async () => {
    // The one that matters, and the one no fixture could have caught. Reported as a per-file list
    // of mismatches so a failure says *which* transcript disagrees, never what is in it.
    const wrong: string[] = [];
    for (const f of files) {
      const raw = await lines(f);
      const truth = trueUsage(raw);
      let got = zero();
      for (const ev of normalized(raw)) {
        if (ev.kind !== 'usage') continue;
        got = plus(got, { in: ev.inTok, out: ev.outTok, cacheRead: ev.cacheRead ?? 0, cacheWrite: ev.cacheWrite ?? 0 });
      }
      if (JSON.stringify(got) !== JSON.stringify(truth)) {
        wrong.push(`${f.slice(-40)}: got ${JSON.stringify(got)} want ${JSON.stringify(truth)}`);
      }
    }
    expect(wrong).toEqual([]);
  }, 60_000);

  it('never throws, and never emits a frame the client would reject', async () => {
    for (const f of files) {
      const evs = normalized(await lines(f));
      // `isEv` is the client's own guard. An event the hub can produce and the client discards is
      // a silent hole in the pipe, and this is the only place the two are checked against a real
      // stream rather than against each other's tests.
      const rejected = evs.filter((e) => !isEv(e));
      expect(rejected, `${f.slice(-40)} produced ${rejected.length} unrecognizable frames`).toEqual([]);
      const seqs = evs.map((e) => e.seq);
      expect([...seqs].sort((a, b) => a - b), `${f.slice(-40)} seq not monotonic`).toEqual(seqs);
      expect(evs.every((e) => Number.isFinite(e.ts))).toBe(true);
      expect(evs.every((e) => evSession(e) === 'corpus')).toBe(true);
    }
  }, 60_000);

  it('folds into a state the UI can draw', async () => {
    for (const f of files) {
      const st = normalized(await lines(f)).reduce(reduce, initialState);
      // Every invariant the panels lean on, checked against data nobody wrote for a test.
      expect(st.msgs.length, `${f.slice(-40)} over the cap`).toBeLessThanOrEqual(1000);
      const ts = st.msgs.map((m) => m.ts);
      expect([...ts].sort((a, b) => a - b), `${f.slice(-40)} feed out of order`).toEqual(ts);
      expect(st.order.every((id) => st.agents[id] !== undefined)).toBe(true);
      expect(st.totalTok).toBeGreaterThanOrEqual(0);
      expect(Number.isFinite(st.cost)).toBe(true);
      // A compaction summary is the CLI's own words; it must never be latched as the human's task.
      const compaction = st.msgs.find((m) => m.source === 'compaction');
      if (compaction) expect(st.task).not.toBe(compaction.text);
    }
  }, 60_000);
});
