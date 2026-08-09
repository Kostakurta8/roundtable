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
import { join } from 'node:path';
import type { AgentMeta } from '../shared/events';
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
