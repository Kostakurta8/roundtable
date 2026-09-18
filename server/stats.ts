/**
 * `--stats`: what the transcripts on this machine say about your own fan-out.
 *
 * The office answers "what is happening right now". This answers "what has been happening", over
 * every transcript Claude Code has left under the root — and it exists because the same three
 * counting mistakes catch everybody, including the author, twice:
 *
 *   1. A multi-block response is written as several lines and **every line repeats the same
 *      complete usage object**. Summing per line over-reports output by roughly 3x. Usage is
 *      therefore deduplicated on `message.id` here, keeping the last line seen for an id.
 *   2. `subagents/` holds three kinds of file — plain agents, workflow agents one directory
 *      deeper, and the workflow's own `journal.jsonl`, which is not an agent at all. The walk
 *      comes from `subagentFiles`, which knows the difference.
 *   3. A single hook firing writes **two** records (`hook_success` and `hook_additional_context`)
 *      that share a `toolUseID`, so counting lines over-reports firings. They are deduplicated on
 *      that pair here.
 *
 * Nothing is written and nothing leaves the machine: this reads the same files the hub reads.
 */
import { readFileSync } from 'node:fs';
import { listSessions, subagentFiles, type AgentFile } from './sessions';

/** One response's usage, as the transcript writes it. */
type Usage = {
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
};

export type FileStats = {
  /** Output tokens, deduplicated on `message.id`. */
  output: number;
  cacheCreation: number;
  cacheRead: number;
  /** `cache_creation_input_tokens` of the first response only — an agent's cold-start entry fee. */
  firstResponseCacheCreation: number;
  /** Assistant responses (distinct ids), not lines. */
  responses: number;
  /** Lines carrying a usage block, which is the number the naive sum would have used. */
  usageLines: number;
  /** The naive per-line sum, kept so the over-count can be reported rather than asserted. */
  outputPerLine: number;
  toolCalls: number;
  /** Seconds between the first and last timestamped line. */
  seconds: number;
};

const EMPTY: FileStats = {
  output: 0,
  cacheCreation: 0,
  cacheRead: 0,
  firstResponseCacheCreation: 0,
  responses: 0,
  usageLines: 0,
  outputPerLine: 0,
  toolCalls: 0,
  seconds: 0,
};

/**
 * One transcript, read the way the accounting has to be done.
 *
 * Keyed on `message.id` and keeping the **last** line seen for that id: a response is written
 * progressively, and the final line is the one whose usage is complete.
 */
export function readTranscript(file: string): FileStats {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return { ...EMPTY };
  }
  const byId = new Map<string, Usage>();
  const order: string[] = [];
  let usageLines = 0;
  let outputPerLine = 0;
  let toolCalls = 0;
  let first = 0;
  let last = 0;

  for (const line of text.split('\n')) {
    if (!line) continue;
    let row: Record<string, unknown>;
    try {
      row = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue; // a partially written last line is normal on a live session
    }
    const stamp = typeof row.timestamp === 'string' ? Date.parse(row.timestamp) : NaN;
    if (Number.isFinite(stamp)) {
      if (!first || stamp < first) first = stamp;
      if (stamp > last) last = stamp;
    }
    if (row.type !== 'assistant') continue;
    const message = row.message as { id?: string; usage?: Usage; content?: unknown } | undefined;
    if (!message) continue;
    for (const block of Array.isArray(message.content) ? message.content : []) {
      if ((block as { type?: string })?.type === 'tool_use') toolCalls++;
    }
    const usage = message.usage;
    if (!usage) continue;
    usageLines++;
    outputPerLine += usage.output_tokens ?? 0;
    const id = message.id ?? `line-${usageLines}`;
    if (!byId.has(id)) order.push(id);
    byId.set(id, usage);
  }

  let output = 0;
  let cacheCreation = 0;
  let cacheRead = 0;
  for (const usage of byId.values()) {
    output += usage.output_tokens ?? 0;
    cacheCreation += usage.cache_creation_input_tokens ?? 0;
    cacheRead += usage.cache_read_input_tokens ?? 0;
  }
  const firstId = order[0];
  return {
    output,
    cacheCreation,
    cacheRead,
    firstResponseCacheCreation: firstId ? (byId.get(firstId)?.cache_creation_input_tokens ?? 0) : 0,
    responses: byId.size,
    usageLines,
    outputPerLine,
    toolCalls,
    seconds: first && last ? (last - first) / 1000 : 0,
  };
}

/** Every hook firing in one transcript, deduplicated the way the transcript forces. */
export function readHooks(file: string, into: Map<string, Set<string>>): number {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return 0;
  }
  let records = 0;
  for (const line of text.split('\n')) {
    if (!line.includes('"hookName"')) continue;
    let row: unknown;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    const rec = findHook(row);
    if (!rec) continue;
    records++;
    const name = String(rec.hookName);
    // One firing writes a hook_success and a hook_additional_context sharing a toolUseID; where
    // there is no tool (a SessionStart, say) the record's own line identity is the best key there
    // is, so the pair falls back to the enclosing line's uuid.
    const key = String(
      rec.toolUseID ?? (row as { parentUuid?: string; uuid?: string }).parentUuid ?? (row as { uuid?: string }).uuid ?? records,
    );
    const seen = into.get(name) ?? new Set<string>();
    seen.add(`${file}:${key}`);
    into.set(name, seen);
  }
  return records;
}

function findHook(node: unknown): Record<string, unknown> | null {
  if (Array.isArray(node)) {
    for (const item of node) {
      const hit = findHook(item);
      if (hit) return hit;
    }
    return null;
  }
  if (node && typeof node === 'object') {
    const obj = node as Record<string, unknown>;
    if (typeof obj.hookName === 'string') return obj;
    for (const value of Object.values(obj)) {
      const hit = findHook(value);
      if (hit) return hit;
    }
  }
  return null;
}

export type Stats = {
  transcripts: number;
  runsWithSubagents: number;
  children: number;
  childrenByTier: { task: number; workflow: number };
  output: { parent: number; children: number; childSharePct: number };
  perLine: { lines: number; responses: number; summed: number; deduped: number; overcountPct: number };
  /**
   * The same over-count split by tier, because it is not evenly spread: a main transcript writes a
   * response progressively, one line per content block, each repeating the complete usage object,
   * while a subagent transcript mostly writes one line per response. Reported separately so the
   * reader can see which of their files the trap actually lives in.
   */
  perLineByTier: {
    parent: { summed: number; deduped: number; overcountPct: number };
    children: { summed: number; deduped: number; overcountPct: number };
  };
  /** Child share measured only inside runs that spawned subagents, where the ratio means something. */
  childShareWithinFanOutPct: number;
  coldStartAvg: number;
  medianChildrenPerRun: number;
  medianToolCalls: number;
  medianSeconds: number;
  silent: { count: number; pct: number };
  cacheReadPerOutputToken: number;
  hooks: { records: number; firings: number; overcountPct: number; byName: [string, number][] };
};

const median = (xs: number[]): number => {
  if (!xs.length) return 0;
  const sorted = [...xs].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
};

const pct = (part: number, whole: number): number => (whole ? Math.round((part / whole) * 1000) / 10 : 0);

/** Walk every session under `root` and total it up. */
export function collectStats(root: string): Stats {
  const sessions = listSessions(root);
  const hookKeys = new Map<string, Set<string>>();
  let hookRecords = 0;
  let parentOutput = 0;
  let childOutput = 0;
  let coldStartTotal = 0;
  let usageLines = 0;
  let responses = 0;
  let summedPerLine = 0;
  let deduped = 0;
  let cacheRead = 0;
  let totalOutput = 0;
  let runsWithSubagents = 0;
  let children = 0;
  const tiers = { task: 0, workflow: 0 };
  const perRun: number[] = [];
  const toolCalls: number[] = [];
  const seconds: number[] = [];
  let silent = 0;

  let parentSummed = 0;
  let parentDeduped = 0;
  let childSummed = 0;
  let childDeduped = 0;
  let fanOutParentOutput = 0;

  const account = (s: FileStats, tier: 'parent' | 'child'): void => {
    usageLines += s.usageLines;
    responses += s.responses;
    summedPerLine += s.outputPerLine;
    deduped += s.output;
    cacheRead += s.cacheRead;
    totalOutput += s.output;
    if (tier === 'parent') {
      parentSummed += s.outputPerLine;
      parentDeduped += s.output;
    } else {
      childSummed += s.outputPerLine;
      childDeduped += s.output;
    }
  };

  for (const session of sessions) {
    const parent = readTranscript(session.file);
    account(parent, 'parent');
    parentOutput += parent.output;
    hookRecords += readHooks(session.file, hookKeys);

    const kids: AgentFile[] = subagentFiles(root, session.slug, session.sessionId);
    if (!kids.length) continue;
    runsWithSubagents++;
    fanOutParentOutput += parent.output;
    perRun.push(kids.length);
    for (const kid of kids) {
      const s = readTranscript(kid.file);
      account(s, 'child');
      children++;
      if (kid.workflowId) tiers.workflow++;
      else tiers.task++;
      childOutput += s.output;
      coldStartTotal += s.firstResponseCacheCreation;
      toolCalls.push(s.toolCalls);
      seconds.push(s.seconds);
      // A child that made no tool call and wrote nothing did not do a small job; it did no job,
      // and from the parent's side that is indistinguishable from still working.
      if (s.toolCalls === 0 && s.output === 0) silent++;
    }
  }

  const firings = [...hookKeys.values()].reduce((n, set) => n + set.size, 0);
  const byName: [string, number][] = [...hookKeys.entries()]
    .map(([name, set]) => [name, set.size] as [string, number])
    .sort((a, b) => b[1] - a[1]);

  const over = (summed: number, real: number): number =>
    real ? Math.round(((summed - real) / real) * 1000) / 10 : 0;

  return {
    transcripts: sessions.length,
    runsWithSubagents,
    children,
    childrenByTier: tiers,
    output: { parent: parentOutput, children: childOutput, childSharePct: pct(childOutput, parentOutput + childOutput) },
    perLine: {
      lines: usageLines,
      responses,
      summed: summedPerLine,
      deduped,
      overcountPct: over(summedPerLine, deduped),
    },
    perLineByTier: {
      parent: { summed: parentSummed, deduped: parentDeduped, overcountPct: over(parentSummed, parentDeduped) },
      children: { summed: childSummed, deduped: childDeduped, overcountPct: over(childSummed, childDeduped) },
    },
    childShareWithinFanOutPct: pct(childOutput, fanOutParentOutput + childOutput),
    coldStartAvg: children ? Math.round(coldStartTotal / children) : 0,
    medianChildrenPerRun: median(perRun),
    medianToolCalls: median(toolCalls),
    medianSeconds: Math.round(median(seconds)),
    silent: { count: silent, pct: pct(silent, children) },
    cacheReadPerOutputToken: totalOutput ? Math.round(cacheRead / totalOutput) : 0,
    hooks: {
      records: hookRecords,
      firings,
      overcountPct: firings ? Math.round(((hookRecords - firings) / firings) * 1000) / 10 : 0,
      byName,
    },
  };
}

const n = (x: number): string => x.toLocaleString('en-US');

/** The report, written to be pasted somewhere as-is. */
export function formatStats(s: Stats, root: string): string {
  const lines: string[] = [];
  lines.push(`roundtable --stats   ${root}`, '');
  lines.push(`  ${n(s.transcripts)} session transcripts, ${n(s.runsWithSubagents)} of them spawned subagents`);
  lines.push(
    `  ${n(s.children)} children  (${n(s.childrenByTier.task)} task, ${n(s.childrenByTier.workflow)} workflow)` +
      `  median ${n(s.medianChildrenPerRun)} per run`,
  );
  lines.push('');
  lines.push(`  children wrote ${s.childShareWithinFanOutPct}% of the output of the runs that spawned them`);
  lines.push(
    `  across every session on this machine, children are ${s.output.childSharePct}% of all output` +
      `  (${n(s.output.children)} vs ${n(s.output.parent)} written in main transcripts)`,
  );
  lines.push(`  cold start: ${n(s.coldStartAvg)} cache-creation tokens per child, before it does any work`);
  lines.push(`  median child: ${n(s.medianToolCalls)} tool calls over ${n(s.medianSeconds)} s`);
  if (s.children) {
    lines.push(
      `  ${n(s.silent.count)} of ${n(s.children)} children (${s.silent.pct}%) made no tool call and wrote nothing`,
    );
  }
  lines.push(`  ${n(s.cacheReadPerOutputToken)} cache-read tokens per output token`);
  lines.push('');
  lines.push(
    `  usage blocks: ${n(s.perLine.lines)} lines describe ${n(s.perLine.responses)} responses` +
      ` — summing per line reports ${n(s.perLine.summed)} output tokens against ${n(s.perLine.deduped)} real (+${s.perLine.overcountPct}%)`,
  );
  lines.push(
    `    and it is not evenly spread: main transcripts +${s.perLineByTier.parent.overcountPct}%,` +
      ` subagent transcripts +${s.perLineByTier.children.overcountPct}%`,
  );
  if (s.hooks.records) {
    lines.push('');
    lines.push(
      `  hooks: ${n(s.hooks.records)} records = ${n(s.hooks.firings)} firings (+${s.hooks.overcountPct}% if you count lines)`,
    );
    for (const [name, count] of s.hooks.byName.slice(0, 8)) lines.push(`    ${name.padEnd(24)} ${n(count)}`);
    lines.push('    a hook absent from this list is one of three things: never registered,');
    lines.push('    never fired, or fired without writing a record. Absence is a hint, not proof.');
  }
  lines.push('');
  lines.push('  Nothing was written and nothing left this machine.');
  return lines.join('\n');
}
