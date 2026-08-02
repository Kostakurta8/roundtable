import { readdirSync, statSync, type Stats } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const JSONL_EXT = '.jsonl';
const AGENT_PREFIX = 'agent-';

function tryStat(path: string): Stats | undefined {
  try {
    return statSync(path);
  } catch {
    return undefined; // gone, permission-denied, or racing a delete — treat as absent
  }
}

export function claudeRoot(): string {
  return process.env.ROUNDTABLE_HOME ?? join(homedir(), '.claude');
}

export function listSessions(root: string): { sessionId: string; slug: string; file: string; mtime: number }[] {
  const projectsDir = join(root, 'projects');
  let slugs: string[];
  try {
    slugs = readdirSync(projectsDir);
  } catch {
    return []; // no projects/ dir yet
  }

  const out: { sessionId: string; slug: string; file: string; mtime: number }[] = [];
  for (const slug of slugs) {
    const slugDir = join(projectsDir, slug);
    if (!tryStat(slugDir)?.isDirectory()) continue;

    let entries: string[];
    try {
      entries = readdirSync(slugDir);
    } catch {
      continue;
    }

    for (const name of entries) {
      if (!name.endsWith(JSONL_EXT)) continue; // top level only: session subdirs aren't sessions
      const file = join(slugDir, name);
      const st = tryStat(file);
      if (!st?.isFile()) continue;
      out.push({ sessionId: name.slice(0, -JSONL_EXT.length), slug, file, mtime: st.mtimeMs });
    }
  }
  return out;
}

export function subagentFiles(root: string, slug: string, sessionId: string): { agentId: string; file: string }[] {
  const subagentsDir = join(root, 'projects', slug, sessionId, 'subagents');
  let entries: string[];
  try {
    entries = readdirSync(subagentsDir);
  } catch {
    return []; // no subagents/ dir — main-only session
  }

  const out: { agentId: string; file: string }[] = [];
  for (const name of entries) {
    if (!name.startsWith(AGENT_PREFIX) || !name.endsWith(JSONL_EXT)) continue; // skips *.meta.json
    const file = join(subagentsDir, name);
    const st = tryStat(file);
    if (!st?.isFile()) continue;
    out.push({ agentId: name.slice(AGENT_PREFIX.length, -JSONL_EXT.length), file });
  }
  return out;
}
