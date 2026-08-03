/**
 * Behavior mapping: the pure translation from the hub's normalized event stream (`Ev`) into
 * commands the office simulation understands (`Cmd`). `mapEvent` never touches the DOM, the
 * clock, or any store — the same event (and the same roster) always produces the same
 * commands, which is what lets the office engine be driven straight off this layer and replayed
 * later with no live socket in sight.
 *
 * This is the seam that decides what the room is *able* to say. It used to fold eleven event
 * kinds into six commands and drop five of them, so the office could report that twelve agents
 * existed and that some of them were typing, and nothing else: not whether a tool call worked,
 * not who asked whom, and — because `agentDone` never arrived — not that anybody had ever
 * finished. Every kind is carried now, and `toolStart` arrives as a tool *kind* and a target
 * rather than as one flattened label, because "reading a file" and "running a command" are two
 * different pictures and a single string cannot be either of them.
 */
import { verdictOf, type Ev } from '../../shared/events';

/**
 * What a tool *does*, as the room has to draw it.
 *
 * The room cannot show forty tool names, and it should not try: what a viewer needs from across
 * the office is the shape of the work. These six are the distinctions that change the picture —
 * a person holding a page reads differently from a person at a terminal, and both read
 * differently from a person who has handed the work to somebody else and is waiting.
 */
export type ToolAct = 'read' | 'write' | 'run' | 'browse' | 'delegate' | 'other';

/**
 * The tools this build knows how to picture.
 *
 * Deliberately a table and not a heuristic. An unknown tool is `other` — a person working at
 * their desk, which is true of anything — rather than a guess: showing an agent walking to the
 * window because a tool name happened to contain "web" is a lie the viewer has no way to check.
 */
const TOOL_ACTS: Readonly<Record<string, ToolAct>> = {
  Read: 'read',
  Grep: 'read',
  Glob: 'read',
  LS: 'read',
  NotebookRead: 'read',
  Edit: 'write',
  Write: 'write',
  MultiEdit: 'write',
  NotebookEdit: 'write',
  Bash: 'run',
  BashOutput: 'run',
  KillShell: 'run',
  KillBash: 'run',
  WebFetch: 'browse',
  WebSearch: 'browse',
  Task: 'delegate',
  Agent: 'delegate',
  Workflow: 'delegate',
  SendMessage: 'delegate',
};

/** The picture a tool name maps to. Exported so the renderer and the tests share one table. */
export const toolAct = (tool: string): ToolAct => TOOL_ACTS[tool] ?? 'other';

export type Cmd =
  | { op: 'ensureActor'; agentId: string; parentToolUseId?: string }
  | { op: 'think'; agentId: string; text: string }
  /** A tool call opened. `id` is the `tool_use` id `toolEnd` closes it by. */
  | { op: 'tool'; agentId: string; id: string; tool: string; act: ToolAct; target?: string }
  /** That call came back. The one event that says whether any of this is working. */
  | { op: 'toolEnd'; agentId: string; id: string; ok: boolean }
  /** A file changed on disk. */
  | { op: 'edit'; agentId: string; path: string }
  /** This agent handed work to a child. `child` is `'pending'` until the child's sidecar lands. */
  | { op: 'spawn'; agentId: string; child: string; prompt: string; toolUseId?: string }
  /** This agent has finished. The command hot-desking is built on. */
  | { op: 'done'; agentId: string; ok: boolean }
  /** An instruction was addressed to this agent — the human's, or its parent's. */
  | { op: 'prompt'; agentId: string; text: string; from: 'human' | 'parent' }
  | { op: 'deliver'; agentId: string; to: 'main'; text: string } // walk to orchestrator, speak
  | { op: 'confront'; agentId: string; to: string; text: string; verdict: 'ok' | 'err' }
  | { op: 'status'; agentId: string; text: string };

const THINK_MAX = 90;
const SENTENCE_MAX = 120;

/**
 * How much of a tool's target survives. A `Bash` target is the whole command line and a `Grep`
 * target is a raw pattern; both routinely run to several hundred characters, and the room shows
 * this on a nameplate and a monitor that are tens of pixels wide.
 */
const TARGET_MAX = 60;

/** A glance, not the transcript: plain char-count truncation, no ellipsis marker. */
const cap = (s: string, max: number): string => (s.length > max ? s.slice(0, max) : s);

/**
 * The first sentence of a message, for a speech bubble: up to and including the first
 * `.` / `!` / `?`, or up to (excluding) the first newline; the whole text if none of those
 * appear. Trimmed, then capped at ~120 chars either way.
 */
function firstSentence(text: string): string {
  const t = text.trim();
  // A terminator only counts when whitespace or the end of the text follows it. A bare `[.!?]`
  // cut "Latency rose 1.4x" to "Latency rose 1." and every numbered list to "1." — the decimal
  // point and the list marker are the two most common full stops in this domain, and neither
  // ends a sentence.
  const idx = t.search(/[.!?](?=\s|$)|\n/);
  const cut = idx === -1 ? t : t[idx] === '\n' ? t.slice(0, idx) : t.slice(0, idx + 1);
  return cap(cut.trim(), SENTENCE_MAX);
}

/** Escapes regex metacharacters so a roster id can be dropped into a pattern literally. */
const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * True when `id` occurs in `text` as its own token, not embedded inside a longer run of
 * letters/digits. Real agent ids are hex-like, and verdict prose in this domain routinely
 * carries commit SHAs, artifact ids, and other alphanumeric tokens — a bare substring check
 * would let id `'ok'` fire on "okay", or `'abc123'` fire on `'xabc1234def'`. A boundary is
 * anything that is not `[A-Za-z0-9]` — punctuation, whitespace, or the start/end of the text.
 */
function isNamed(text: string, id: string): boolean {
  if (!id) return false;
  return new RegExp(`(?<![A-Za-z0-9])${escapeRegExp(id)}(?![A-Za-z0-9])`).test(text);
}

/**
 * The roster agent named in `text`, if any — scanned in the roster's own (insertion) order so
 * the result is deterministic. `main` is never returned here: it is already the fallback, and
 * counting it as a match would let the literal word "main" (present whole in ordinary phrases
 * like "main branch") shadow a genuinely named agent whenever main happens to be first in the
 * roster — which it usually is, being the first agent seen.
 */
function namedInRoster(text: string, roster: ReadonlySet<string>): string | undefined {
  for (const id of roster) {
    if (id !== 'main' && isNamed(text, id)) return id;
  }
  return undefined;
}

/** Mirrors `src/App.tsx`'s HUD token formatting: plain below 1000, one-decimal `k` at/above it. */
const fmtTok = (n: number): string => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

/**
 * Translates one normalized event into zero or more office commands.
 *
 * `roster` is the set of agent ids seen so far. The caller accumulates it from this module's own
 * `ensureActor` commands as the stream plays; `mapEvent` only ever reads it, so it stays pure
 * with respect to its arguments and keeps no module-level mutable state of its own.
 */
export function mapEvent(ev: Ev, roster: ReadonlySet<string> = new Set<string>()): Cmd[] {
  switch (ev.kind) {
    case 'agentSeen': {
      // The sidecar's `parentToolUseId` is the only honest link between a child and the `Task`
      // call that made it: the spawn line itself never knows the child's id. Carrying it here is
      // what lets the engine join the two halves and draw a parent→child edge.
      const cmd: Cmd = { op: 'ensureActor', agentId: ev.ref.agentId };
      return [ev.parentToolUseId ? { ...cmd, parentToolUseId: ev.parentToolUseId } : cmd];
    }

    case 'thinking':
      return [{ op: 'think', agentId: ev.ref.agentId, text: cap(ev.text, THINK_MAX) }];

    case 'toolStart': {
      const target = ev.target === undefined ? undefined : cap(ev.target.trim(), TARGET_MAX);
      return [
        {
          op: 'tool',
          agentId: ev.ref.agentId,
          id: ev.toolUseId,
          tool: ev.tool,
          act: toolAct(ev.tool),
          ...(target ? { target } : {}),
        },
      ];
    }

    case 'toolResult':
      return [{ op: 'toolEnd', agentId: ev.ref.agentId, id: ev.toolUseId, ok: ev.ok }];

    case 'fileEdit':
      return [{ op: 'edit', agentId: ev.ref.agentId, path: ev.path }];

    case 'agentSpawn': {
      const cmd: Cmd = {
        op: 'spawn',
        agentId: ev.ref.agentId,
        child: ev.childAgentId,
        prompt: firstSentence(ev.prompt),
      };
      return [ev.toolUseId ? { ...cmd, toolUseId: ev.toolUseId } : cmd];
    }

    case 'agentDone':
      // `ref` is the agent that *finished*, not the parent that noticed — the hub derives this
      // event from the parent's `tool_result` but addresses it to the child.
      return [{ op: 'done', agentId: ev.ref.agentId, ok: ev.ok }];

    case 'userMessage': {
      // A `user` line in the main transcript is the human; the same line in a subagent's
      // transcript is the brief its parent handed down. Both are somebody being told what to do,
      // which is a thing the room can show, but they are not the same thing and the renderer is
      // allowed to distinguish them.
      const from = ev.ref.agentId === 'main' ? 'human' : 'parent';
      // Machine text on the `user` lane — hook output, reminders, command echoes — is not an
      // instruction anybody gave, and the office should not act as though it were.
      if (from === 'human' && ev.source !== undefined && ev.source !== 'human') return [];
      return [{ op: 'prompt', agentId: ev.ref.agentId, text: firstSentence(ev.text), from }];
    }

    case 'agentText': {
      const verdict = verdictOf(ev.text);
      if (verdict) {
        const to = namedInRoster(ev.text, roster) ?? 'main';
        return [{ op: 'confront', agentId: ev.ref.agentId, to, text: firstSentence(ev.text), verdict }];
      }
      // Main talking with no verdict is not a trip across the room — the chat feed already
      // shows it, and main cannot walk a note to itself.
      if (ev.ref.agentId === 'main') return [];
      return [{ op: 'deliver', agentId: ev.ref.agentId, to: 'main', text: firstSentence(ev.text) }];
    }

    case 'usage': {
      const total = ev.inTok + ev.outTok;
      return [{ op: 'status', agentId: ev.ref.agentId, text: `${fmtTok(total)} tok` }];
    }

    // `sessionSeen` carries no `ref` at all — there is no actor for it to be about — and any
    // future kind this layer does not yet know must leave the room exactly as it was.
    default:
      return [];
  }
}
