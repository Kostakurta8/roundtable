/**
 * Discovery: what sessions exist on this machine, which of them are alive, and which transcript
 * files belong to each.
 *
 * Everything here is read-only and defensive. `~/.claude` is a live directory being written by
 * another process, so every path can vanish between the listing and the stat, every JSON file can
 * be caught half-written, and none of that may take the observer down — an unreadable entry is
 * simply absent.
 */
import { closeSync, openSync, readdirSync, readFileSync, readSync, statSync, type Stats } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import type { AgentMeta, WorkflowAgentState, WorkflowPhase, WorkflowPhaseAgent } from '../shared/events';
import { classifyUserSource, oneLine } from './normalize';
import { parseLine, type RawLine } from './parse';

const JSONL_EXT = '.jsonl';
const META_EXT = '.meta.json';
const AGENT_PREFIX = 'agent-';
const WORKFLOWS_DIR = 'workflows';

/** Sidecars and journals are small; a cap keeps a corrupt or hostile file from being read whole. */
const MAX_SIDECAR_BYTES = 64 * 1024;

function tryStat(path: string): Stats | undefined {
  try {
    return statSync(path);
  } catch {
    return undefined; // gone, permission-denied, or racing a delete — treat as absent
  }
}

function tryReadDir(path: string): string[] {
  try {
    return readdirSync(path);
  } catch {
    return [];
  }
}

/** Reads a small JSON sidecar, or `undefined` if it is missing, oversized, or half-written. */
function readJson<T>(path: string): T | undefined {
  const st = tryStat(path);
  if (!st?.isFile() || st.size > MAX_SIDECAR_BYTES) return undefined;
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
    return parsed as T;
  } catch {
    return undefined; // mid-write, or not JSON at all
  }
}

export function claudeRoot(): string {
  return process.env.ROUNDTABLE_HOME ?? join(homedir(), '.claude');
}

export type SessionFile = { sessionId: string; slug: string; file: string; mtime: number };

export function listSessions(root: string): SessionFile[] {
  const projectsDir = join(root, 'projects');
  const out: SessionFile[] = [];

  for (const slug of tryReadDir(projectsDir)) {
    const slugDir = join(projectsDir, slug);
    if (!tryStat(slugDir)?.isDirectory()) continue;

    for (const name of tryReadDir(slugDir)) {
      if (!name.endsWith(JSONL_EXT)) continue; // top level only: session subdirs aren't sessions
      const file = join(slugDir, name);
      const st = tryStat(file);
      if (!st?.isFile()) continue;
      out.push({ sessionId: name.slice(0, -JSONL_EXT.length), slug, file, mtime: st.mtimeMs });
    }
  }
  return out;
}

// --------------------------------------------------------------- the label

/**
 * How much of a session's opening turn a tab can hold.
 *
 * Long enough that two sessions started in the same directory are told apart by their first
 * sentence, short enough that the picker is a list of tabs and not a list of paragraphs.
 */
const LABEL_MAX_LEN = 60;

/**
 * How far into a transcript the opening human turn is looked for, and how much is read at a time.
 *
 * This runs for **every** session on the machine on every roster sweep — 174 in one slug here, 438
 * across all of them — so reading a transcript to find one sentence is not an option: they run to
 * tens of megabytes. The bound is the design, and a session whose first human turn is past it
 * simply has no label, which is the same answer as a session nobody has asked anything yet.
 *
 * 64 KiB is measured, not guessed. Across the 427 sessions on this machine that contain a human
 * turn at all, the first one ends 14 229 bytes in at the median and 29 421 at the 90th percentile
 * — much further than "the first line" because the CLI's opening `user` line carries the injected
 * project context alongside the human's words. 64 KiB finds 407 of the 427 (95%); 8 KiB would find
 * one. The 16 KiB chunk is what keeps the typical cost to a single read: the scan stops at the
 * first human line, so the median session never asks for the other three chunks.
 */
export const LABEL_SCAN_BYTES = 64 * 1024;
const LABEL_CHUNK_BYTES = 16 * 1024;

const NEWLINE = 0x0a;

/** The human's own words on one `user` line, already flattened, redacted and clipped. */
function humanTurn(line: RawLine): string | undefined {
  if (line.type !== 'user') return undefined;
  const content = line.message?.content;
  const compacted = line.isCompactSummary === true;

  const texts: string[] =
    typeof content === 'string'
      ? [content]
      : Array.isArray(content)
        ? content
            .filter((b): b is { text: string } => !!b && typeof b === 'object' && typeof (b as { text?: unknown }).text === 'string')
            .map((b) => b.text)
        : [];

  for (const text of texts) {
    // Not a hook, not a caveat, not a slash-command echo, and never a compaction summary — that
    // last one is ~14 500 characters of the CLI's own boilerplate written as a user turn, and it
    // would make every long session's tab identical.
    if (classifyUserSource(text, compacted) !== 'human') continue;
    const label = oneLine(text, LABEL_MAX_LEN);
    if (label.length > 0) return label;
  }
  return undefined;
}

/**
 * The session's opening human turn, or `undefined` if it has not been asked anything yet.
 *
 * The CLI names a session after its cwd leaf plus a counter, so every session started in the same
 * directory is `dev-52`, `dev-70`, `dev-ef` — tabs that differ by two hex characters and by
 * nothing a person can use. What distinguishes them is what they were asked to do.
 *
 * Reads a bounded prefix and stops at the first hit; see `LABEL_SCAN_BYTES`. Only complete lines
 * are parsed, so the torn last line of a file another process is appending to is stepped over
 * rather than guessed at.
 */
export function sessionLabel(file: string): string | undefined {
  let fd: number;
  try {
    fd = openSync(file, 'r');
  } catch {
    return undefined; // gone, or racing a delete — treat as absent, exactly like everything here
  }
  try {
    const buf = Buffer.allocUnsafe(LABEL_SCAN_BYTES);
    let filled = 0; // bytes of the file held in `buf`
    let start = 0; // where the first not-yet-scanned line begins

    while (filled < LABEL_SCAN_BYTES) {
      const want = Math.min(LABEL_CHUNK_BYTES, LABEL_SCAN_BYTES - filled);
      // `readSync` may return short of what was asked for, and does on some filesystems.
      let got = 0;
      while (got < want) {
        const n = readSync(fd, buf, filled + got, want - got, filled + got);
        if (n <= 0) break;
        got += n;
      }
      if (got === 0) return undefined; // end of file, and nothing human in it
      const end = filled + got;

      for (;;) {
        const nl = buf.indexOf(NEWLINE, start);
        // `allocUnsafe` leaves whatever was in that memory past `end`; a newline found out there
        // is not data, and decoding up to it would hand `JSON.parse` somebody else's bytes.
        if (nl === -1 || nl >= end) break;
        const raw = buf.toString('utf8', start, nl);
        start = nl + 1;
        const parsed = raw.trim().length > 0 ? parseLine(raw) : null;
        const label = parsed ? humanTurn(parsed) : undefined;
        if (label) return label;
      }

      filled = end;
      if (got < want) return undefined; // short read: that was the end of the file
    }
    return undefined;
  } finally {
    closeSync(fd);
  }
}

/**
 * How much of the end of a transcript is read looking for the session's current title.
 *
 * A tail rather than a prefix, because unlike the opening human turn this is the *latest* answer:
 * the CLI re-titles a session as its topic moves, and on this machine one 4 MB transcript carries
 * 57 of them. 128 KiB is generous for what it has to find — an `ai-title` line is under 200 bytes
 * and one lands roughly every turn — and it is the same order as the label scan above, so a sweep
 * over a live session costs one bounded read at each end of the file rather than a walk through it.
 */
export const TITLE_SCAN_BYTES = 128 * 1024;

/** `{"type":"ai-title","aiTitle":"…"}` — the CLI's own topic title for the session. */
type AiTitleLine = { type?: unknown; aiTitle?: unknown };

/**
 * The CLI's current topic title for a session, or `undefined` if it has not written one.
 *
 * This is the line the CLI derives the terminal tab's own title from, which is the whole reason to
 * read it: it is the name the user is already looking at on their tab, produced without them
 * having to name anything. A session's derived `name` — `dev-60`, the cwd's leaf plus two hex
 * characters — cannot tell six tabs apart, and this can.
 *
 * Scanned backwards from the end and the *last* complete line wins, because the title is rewritten
 * as the conversation moves and only the newest one describes what the session is now about. A
 * partial line at either edge of the window is skipped rather than guessed at: the head of the
 * buffer is mid-line by construction, and the tail can be a line another process is still writing.
 */
export function sessionTitle(file: string): string | undefined {
  let fd: number;
  try {
    fd = openSync(file, 'r');
  } catch {
    return undefined; // gone, or racing a delete — absent, exactly like everything else here
  }
  try {
    const size = statSync(file).size;
    const want = Math.min(TITLE_SCAN_BYTES, size);
    if (want <= 0) return undefined;
    const from = size - want;
    const buf = Buffer.allocUnsafe(want);

    let got = 0;
    while (got < want) {
      const n = readSync(fd, buf, got, want - got, from + got);
      if (n <= 0) break;
      got += n;
    }
    if (got === 0) return undefined;

    // Unless the window starts at byte zero its first line is a fragment — it began before the
    // window did — so skip to the first newline and start from real data.
    let start = from === 0 ? 0 : buf.indexOf(NEWLINE, 0) + 1;
    if (start <= 0 && from !== 0) return undefined; // no complete line in the window at all

    let found: string | undefined;
    for (;;) {
      const nl = buf.indexOf(NEWLINE, start);
      if (nl === -1 || nl >= got) break; // the rest is a torn line, or `allocUnsafe` leftovers
      const raw = buf.toString('utf8', start, nl);
      start = nl + 1;
      // Cheap reject before parsing: nearly every line in the window is an assistant turn, and
      // running `JSON.parse` over a 128 KiB window of them on every sweep is the one cost worth
      // avoiding here.
      if (raw.includes('"ai-title"')) {
        const title = aiTitleOf(raw);
        if (title) found = title; // keep going: the last one is the current one
      }
    }
    return found;
  } catch {
    return undefined;
  } finally {
    closeSync(fd);
  }
}

/** The title on one raw line, when it is an `ai-title` line carrying a non-empty one. */
function aiTitleOf(raw: string): string | undefined {
  let parsed: AiTitleLine;
  try {
    parsed = JSON.parse(raw) as AiTitleLine;
  } catch {
    return undefined; // a half-written line is not a title
  }
  if (parsed.type !== 'ai-title' || typeof parsed.aiTitle !== 'string') return undefined;
  const title = oneLine(parsed.aiTitle, LABEL_MAX_LEN);
  return title.length > 0 ? title : undefined;
}

// ------------------------------------------------------------------ liveness

/**
 * One row of `~/.claude/sessions/<pid>.json` — the registry the CLI keeps of its own processes.
 *
 * This is the only honest source of "is this session actually running", and it carries the name
 * the CLI derived for it, which beats showing a user their own session as a bare hex id.
 */
export type LiveSession = {
  sessionId: string;
  pid?: number;
  cwd?: string;
  /** The CLI's own derived name, e.g. `dev-67`. */
  name?: string;
  /**
   * Where `name` came from: `derived` (the cwd's leaf plus a counter), `auto`, or `user`.
   *
   * The distinction decides whether the name is worth showing. `derived` is what the CLI falls
   * back to when nobody has said anything — six sessions in one directory all get one — while
   * `user` is a name somebody typed with `/rename` and is therefore the best label that exists.
   */
  nameSource?: string;
  /** `idle`, `running`, … — whatever the CLI last wrote. */
  status?: string;
  version?: string;
  kind?: string;
  startedAt?: number;
  updatedAt?: number;
};

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

/**
 * Every registered session, keyed by session id.
 *
 * A registry file outlives the process that wrote it — the CLI does not always get to clean up —
 * so presence here means "was registered", not "is running". The hub pairs it with transcript
 * mtime before calling anything live; see `hub.ts`.
 */
export function registeredSessions(root: string): Map<string, LiveSession> {
  const dir = join(root, 'sessions');
  const out = new Map<string, LiveSession>();

  for (const name of tryReadDir(dir)) {
    if (!name.endsWith('.json')) continue;
    const raw = readJson<Record<string, unknown>>(join(dir, name));
    const sessionId = str(raw?.sessionId);
    if (!raw || !sessionId) continue;

    const entry: LiveSession = {
      sessionId,
      pid: num(raw.pid),
      cwd: str(raw.cwd),
      name: str(raw.name),
      nameSource: str(raw.nameSource),
      status: str(raw.status),
      version: str(raw.version),
      kind: str(raw.kind),
      startedAt: num(raw.startedAt),
      updatedAt: num(raw.updatedAt),
    };
    // The same session id can appear twice if a pid was reused or a stale file was left behind;
    // the most recently touched record is the one that describes reality.
    const prev = out.get(sessionId);
    if (!prev || (entry.updatedAt ?? 0) >= (prev.updatedAt ?? 0)) out.set(sessionId, entry);
  }
  return out;
}

// -------------------------------------------------------------- agent files

export type AgentFile = {
  agentId: string;
  file: string;
  /** The `agent-<id>.meta.json` beside it. May not exist; `readAgentMeta` copes. */
  metaFile: string;
  /** Set for agents spawned by a Workflow script, which live one directory deeper. */
  workflowId?: string;
};

function collectAgents(dir: string, workflowId: string | undefined, out: AgentFile[]): void {
  for (const name of tryReadDir(dir)) {
    if (!name.startsWith(AGENT_PREFIX) || !name.endsWith(JSONL_EXT)) continue; // skips *.meta.json
    const file = join(dir, name);
    if (!tryStat(file)?.isFile()) continue;
    const agentId = name.slice(AGENT_PREFIX.length, -JSONL_EXT.length);
    if (!agentId) continue;
    out.push({
      agentId,
      file,
      metaFile: join(dir, `${AGENT_PREFIX}${agentId}${META_EXT}`),
      ...(workflowId ? { workflowId } : {}),
    });
  }
}

/**
 * Every subagent transcript of one session — the plain ones directly under `subagents/`, and the
 * Workflow ones a further level down under `subagents/workflows/wf_<id>/`.
 *
 * The workflow tier is not optional decoration: a single `Workflow` call can spawn a dozen agents
 * that exist nowhere else, and a version of this function that stopped at the top level rendered
 * an empty office through the busiest part of a run.
 */
export function subagentFiles(root: string, slug: string, sessionId: string): AgentFile[] {
  const subagentsDir = join(root, 'projects', slug, sessionId, 'subagents');
  const out: AgentFile[] = [];

  collectAgents(subagentsDir, undefined, out);

  const workflowsDir = join(subagentsDir, WORKFLOWS_DIR);
  for (const wf of tryReadDir(workflowsDir)) {
    const dir = join(workflowsDir, wf);
    if (!tryStat(dir)?.isDirectory()) continue;
    collectAgents(dir, wf, out);
  }
  return out;
}

/** Every directory that can hold a subagent transcript for this session, for the watcher to add. */
export function agentDirs(root: string, slug: string, sessionId: string): string[] {
  const subagentsDir = join(root, 'projects', slug, sessionId, 'subagents');
  const dirs = [subagentsDir];
  const workflowsDir = join(subagentsDir, WORKFLOWS_DIR);
  if (tryStat(workflowsDir)?.isDirectory()) {
    dirs.push(workflowsDir);
    for (const wf of tryReadDir(workflowsDir)) {
      const dir = join(workflowsDir, wf);
      if (tryStat(dir)?.isDirectory()) dirs.push(dir);
    }
  }
  return dirs.filter((d) => tryStat(d)?.isDirectory());
}

/**
 * The sidecar an agent is born with: `{agentType, description, toolUseId, spawnDepth, model}`.
 *
 * `description` is the caller's own sentence for the task and becomes the agent's display name;
 * `toolUseId` is what lets the hub match this child to the parent's `Task` call and so build the
 * real spawn tree. Workflow agents get a thinner sidecar with no description, so the label falls
 * back to the type — the office would rather print `workflow-subagent` than a hex id.
 */
export function readAgentMeta(metaFile: string, workflowId?: string): AgentMeta {
  const raw = readJson<Record<string, unknown>>(metaFile);
  const meta: AgentMeta = {};
  if (workflowId) meta.workflowId = workflowId;
  if (!raw) return meta;

  const model = str(raw.model);
  const label = str(raw.description);
  const agentType = str(raw.agentType);
  const parentToolUseId = str(raw.toolUseId);
  // The authoritative parent link, and the only one that resolves on its own. `toolUseId` needs
  // the parent's `Task` call to still be in the client's store, so a depth-2 agent whose
  // grandparent's spawn line has been trimmed past the message cap loses its parent and re-roots
  // at `main`. 79 of the 2 105 sidecars on this machine carry it, every one at `spawnDepth: 2`.
  const parentAgentId = str(raw.parentAgentId);
  const spawnDepth = num(raw.spawnDepth);

  if (model) meta.model = model;
  if (label) meta.label = label;
  else if (agentType) meta.label = agentType;
  if (agentType) meta.agentType = agentType;
  if (parentToolUseId) meta.parentToolUseId = parentToolUseId;
  if (parentAgentId) meta.parentAgentId = parentAgentId;
  if (spawnDepth !== undefined) meta.spawnDepth = spawnDepth;

  return meta;
}

// ----------------------------------------------------------------- workflows

/**
 * How large a run file may be before it is refused rather than parsed.
 *
 * These are not sidecars and `MAX_SIDECAR_BYTES` cannot be reused: real run files reach 1.4 MB,
 * almost all of it the workflow script plus a 400-character prompt and result preview per agent,
 * and a 64 KiB cap would silently drop most of the runs on this machine. The cap that matters is
 * the one that keeps a single pathological file off the hub's event loop, so it is set well above
 * anything observed and well below anything that would stall a sweep.
 */
export const MAX_WORKFLOW_BYTES = 8 * 1024 * 1024;

const WORKFLOW_PREFIX = 'wf_';
const JSON_EXT = '.json';

/** A run file, and a stamp that changes when its bytes do. */
export type WorkflowRunFile = { workflowId: string; file: string; stamp: string };

/**
 * Every Workflow run this session has finished.
 *
 * These live in the session's *own* `workflows` directory — a sibling of `subagents`, not the
 * `workflows` directory nested inside it that holds the run's agent transcripts. Both exist, both
 * are named the same, and only this one holds the phase record.
 *
 * Returns a stamp rather than the contents so a caller can skip a file it has already read. That
 * is the whole cost story: the hub sweeps this every half-second while a session is followed, and
 * a run file is written exactly once and never touched again, so after the first read every later
 * sweep costs one directory listing and one stat per run.
 */
export function workflowRunFiles(root: string, slug: string, sessionId: string): WorkflowRunFile[] {
  const dir = join(root, 'projects', slug, sessionId, WORKFLOWS_DIR);
  const out: WorkflowRunFile[] = [];

  for (const name of tryReadDir(dir)) {
    if (!name.startsWith(WORKFLOW_PREFIX) || !name.endsWith(JSON_EXT)) continue;
    const file = join(dir, name);
    const st = tryStat(file);
    if (!st?.isFile()) continue; // a directory that happens to be named like a run file
    out.push({
      workflowId: name.slice(0, -JSON_EXT.length),
      file,
      stamp: `${st.mtimeMs}:${st.size}`,
    });
  }
  return out;
}

/** One run's phase record, as `readWorkflowRun` recovers it. */
export type WorkflowRun = {
  workflowId: string;
  workflowName?: string;
  status: string;
  phases: WorkflowPhase[];
  activePhase?: number;
  /** When the run ended, from its own numbers where it wrote them and the file's mtime otherwise. */
  endedAt: number;
};

const AGENT_STATES: ReadonlySet<string> = new Set<WorkflowAgentState>([
  'start',
  'progress',
  'done',
  'error',
]);

const FINISHED: ReadonlySet<string> = new Set<WorkflowAgentState>(['done', 'error']);

/** What is being accumulated for one phase while the progress rows are walked. */
type PhaseAcc = {
  index: number;
  title?: string;
  /** Earliest queue time of any agent in it; `Infinity` for a phase that never got one. */
  rank: number;
  /** Where this phase was first mentioned, as the tie-break for phases with no times at all. */
  seenAt: number;
  agents: WorkflowPhaseAgent[];
};

/**
 * The phase record of one finished Workflow run, or `undefined` if the file cannot be believed.
 *
 * Two things here are taken from the real corpus rather than from the shape the file suggests.
 *
 * The phase roster comes from the progress rows, not from the top-level `phases` array: that array
 * is a declaration written by the script's author and one real run declares a single phase while
 * its own agents are attributed to two. An agent naming a phase nothing registered still gets that
 * phase, because losing it would lose the agent.
 *
 * The order comes from when the agents were queued, not from the declared `index`. The index is a
 * registration number — on one real run the very first agent queued carries `phaseIndex: 2` and
 * the 88 after it carry `phaseIndex: 1` — so sorting by it draws the run running backwards.
 */
export function readWorkflowRun(file: string): WorkflowRun | undefined {
  const st = tryStat(file);
  if (!st?.isFile() || st.size > MAX_WORKFLOW_BYTES) return undefined;

  let raw: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
    raw = parsed as Record<string, unknown>;
  } catch {
    return undefined; // mid-write, or not JSON at all
  }

  const rows: unknown[] = Array.isArray(raw.workflowProgress) ? raw.workflowProgress : [];
  const acc = new Map<number, PhaseAcc>();

  const phaseFor = (index: number, seenAt: number): PhaseAcc => {
    let p = acc.get(index);
    if (!p) {
      p = { index, rank: Number.POSITIVE_INFINITY, seenAt, agents: [] };
      acc.set(index, p);
    }
    return p;
  };

  rows.forEach((row, at) => {
    if (!row || typeof row !== 'object' || Array.isArray(row)) return;
    const r = row as Record<string, unknown>;
    const index = num(r.phaseIndex) ?? num(r.index);
    if (index === undefined) return;

    if (r.type === 'workflow_phase') {
      const p = phaseFor(index, at);
      p.title ??= str(r.title);
      return;
    }
    if (r.type !== 'workflow_agent') return;

    const agentId = str(r.agentId);
    const state = str(r.state);
    if (!agentId || !state || !AGENT_STATES.has(state)) return;

    const p = phaseFor(index, at);
    // The agent's own copy of the title, which is the only record of it when the run was killed
    // before the phase was registered.
    p.title ??= str(r.phaseTitle);

    const label = str(r.label);
    const attempt = num(r.attempt);
    const queuedAt = num(r.queuedAt) ?? num(r.startedAt);
    if (queuedAt !== undefined) p.rank = Math.min(p.rank, queuedAt);

    p.agents.push({
      agentId,
      state: state as WorkflowAgentState,
      ...(label ? { label } : {}),
      ...(attempt !== undefined ? { attempt } : {}),
      ...(queuedAt !== undefined ? { queuedAt } : {}),
    });
  });

  if (acc.size === 0) return undefined; // valid JSON, but nothing that describes a run

  const ordered = [...acc.values()].sort((a, b) => a.rank - b.rank || a.seenAt - b.seenAt);
  const phases: WorkflowPhase[] = ordered.map((p, order) => ({
    index: p.index,
    title: p.title ?? `Phase ${p.index}`,
    order,
    agents: p.agents,
  }));

  // Where the run was standing when it stopped: the last phase still holding an agent that never
  // reached an end. `error` is an end — a failed agent is finished, not stuck.
  let activePhase: number | undefined;
  for (const phase of phases) {
    if (phase.agents.some((a) => !FINISHED.has(a.state))) activePhase = phase.order;
  }

  const workflowId = str(raw.runId) ?? basename(file, JSON_EXT);
  const workflowName = str(raw.workflowName);
  const startTime = num(raw.startTime);
  const durationMs = num(raw.durationMs);

  return {
    workflowId,
    ...(workflowName ? { workflowName } : {}),
    status: str(raw.status) ?? 'unknown',
    phases,
    ...(activePhase !== undefined ? { activePhase } : {}),
    endedAt: startTime !== undefined && durationMs !== undefined ? startTime + durationMs : st.mtimeMs,
  };
}
