/**
 * Discovery: what sessions exist on this machine, which of them are alive, and which transcript
 * files belong to each.
 *
 * Everything here is read-only and defensive. `~/.claude` is a live directory being written by
 * another process, so every path can vanish between the listing and the stat, every JSON file can
 * be caught half-written, and none of that may take the observer down — an unreadable entry is
 * simply absent.
 */
import { readdirSync, readFileSync, statSync, type Stats } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { AgentMeta } from '../shared/events';

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
  const spawnDepth = num(raw.spawnDepth);

  if (model) meta.model = model;
  if (label) meta.label = label;
  else if (agentType) meta.label = agentType;
  if (agentType) meta.agentType = agentType;
  if (parentToolUseId) meta.parentToolUseId = parentToolUseId;
  if (spawnDepth !== undefined) meta.spawnDepth = spawnDepth;

  return meta;
}
