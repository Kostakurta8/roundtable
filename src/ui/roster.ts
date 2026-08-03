/**
 * Roster shaping: the agent list as a tree, and the numbers panels compare against.
 *
 * Topology is real information, not decoration — agents never talk to each other, they are
 * spawned by a parent and report back to it — so a flat alphabetical list actively misleads.
 * `main` is the root; a child sits under whichever agent's `Task` call created it.
 */
import type { RtAgent, RtState } from '../store';
import { MAIN } from '../store';

export type RosterRow = { agent: RtAgent; depth: number };

/** Deeper than any real spawn tree, and shallow enough that the indent still fits the rail. */
const MAX_DEPTH = 6;

/**
 * Depth-first, parents before children, siblings in the order they were first seen.
 *
 * An agent whose parent is unknown — the sidecar has not landed yet, or a truncated backlog ate
 * the spawn — is treated as a root rather than hidden, because an agent missing from the roster
 * while visibly at a desk in the room is the worse failure.
 */
export function rosterTree(state: RtState): RosterRow[] {
  const kids = new Map<string, string[]>();
  const roots: string[] = [];

  for (const id of state.order) {
    const a = state.agents[id];
    if (!a) continue;
    const parent = a.parentId;
    if (parent && parent !== id && state.agents[parent]) {
      const list = kids.get(parent);
      if (list) list.push(id);
      else kids.set(parent, [id]);
    } else {
      roots.push(id);
    }
  }

  // `main` first when it exists: it is the session, and everything else hangs off it.
  roots.sort((a, b) => (a === MAIN ? -1 : b === MAIN ? 1 : 0));

  const out: RosterRow[] = [];
  const seen = new Set<string>();
  const walk = (id: string, depth: number): void => {
    // A cycle cannot happen through honest data, but the parent link comes off disk and a loop
    // here would hang the render rather than draw a wrong tree.
    if (seen.has(id) || depth > MAX_DEPTH) return;
    seen.add(id);
    const agent = state.agents[id];
    if (!agent) return;
    out.push({ agent, depth });
    for (const kid of kids.get(id) ?? []) walk(kid, depth + 1);
  };
  for (const id of roots) walk(id, 0);
  // Anything the walk could not reach (a cycle, or a depth cut) still gets a row.
  for (const id of state.order) {
    if (seen.has(id)) continue;
    const agent = state.agents[id];
    if (agent) out.push({ agent, depth: 0 });
  }
  return out;
}

/** The largest token total in the roster, so a bar can be drawn as a share of the busiest agent. */
export const peakTokens = (rows: readonly RosterRow[]): number =>
  rows.reduce((max, r) => Math.max(max, r.agent.tokens), 0);

/** Tool call counts across the whole session, busiest first. */
export function toolHistogram(state: RtState): { tool: string; n: number }[] {
  const counts = new Map<string, number>();
  for (const id of state.order) {
    const a = state.agents[id];
    if (!a) continue;
    for (const [tool, n] of Object.entries(a.toolCounts)) {
      counts.set(tool, (counts.get(tool) ?? 0) + n);
    }
  }
  return [...counts.entries()]
    .map(([tool, n]) => ({ tool, n }))
    .sort((a, b) => b.n - a.n || a.tool.localeCompare(b.tool));
}
