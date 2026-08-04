/**
 * The movie set: a synthetic `~/.claude` root, built from scratch, that the observer hub can be
 * pointed at instead of the real one.
 *
 * Nothing here reads or copies anything from the user's machine. Every line is written by this
 * file, in the schema `fixtures/NOTES.md` records as verified against CC v2.1.220, so a recording
 * made against this root cannot leak a prompt, a path, a project name or a session id. That is the
 * whole reason it exists: the session picker lists real project directories, and a trailer is a
 * thing you hand to strangers.
 *
 * The one thing it is not is a *simulation*. Lines written here go to disk and are picked up by
 * chokidar, parsed, normalized, broadcast and folded exactly like a real session's — the pipeline
 * under test is the shipped one, and only the content is invented.
 */
import { mkdirSync, rmSync, utimesSync, writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';

/** A model with a rate card, so the cost line is a real figure rather than a floor. */
export const MODEL = 'claude-fable-5';
/** Deliberately a second model, so `EST` has something to be honest about if it has no card. */
export const MODEL_ALT = 'claude-sonnet-5';

export type SessionSpec = {
  sessionId: string;
  /** The `projects/<slug>` directory. */
  slug: string;
  /** What the picker and the tab show. Invented, and obviously so. */
  cwd: string;
  /** The name the CLI registry carries; this is what a session tab is labelled with. */
  name: string;
};

/**
 * Marks a file as having just been written.
 *
 * The hub decides a subagent has finished by how long its transcript has been still, so a file
 * whose mtime is older than it looks is an agent that walks out of the room before the camera is
 * rolling. Every write here goes through the same helper for that reason.
 */
function touch(file: string): void {
  const now = new Date();
  try {
    utimesSync(file, now, now);
  } catch {
    // racing our own write is harmless — the next append touches it again
  }
}

function appendLine(file: string, obj: unknown): void {
  appendFileSync(file, `${JSON.stringify(obj)}\n`);
  touch(file);
}

export class Stage {
  readonly root: string;
  private uuid = 0;
  private msgId = 0;
  /** sessionId → the paths that session writes to. */
  private readonly sessions = new Map<string, { spec: SessionSpec; main: string; subagents: string }>();

  constructor(root: string) {
    this.root = root;
    rmSync(root, { recursive: true, force: true });
    mkdirSync(join(root, 'projects'), { recursive: true });
    mkdirSync(join(root, 'sessions'), { recursive: true });
  }

  private nextUuid(): string {
    this.uuid += 1;
    return `u${String(this.uuid).padStart(4, '0')}`;
  }

  private nextMsgId(): string {
    this.msgId += 1;
    return `msg_${String(this.msgId).padStart(4, '0')}`;
  }

  private now(): string {
    return new Date().toISOString();
  }

  private paths(sessionId: string): { spec: SessionSpec; main: string; subagents: string } {
    const s = this.sessions.get(sessionId);
    if (!s) throw new Error(`stage: unknown session ${sessionId}`);
    return s;
  }

  /** Creates the directory layout for one session and returns its main transcript path. */
  addSession(spec: SessionSpec): string {
    const slugDir = join(this.root, 'projects', spec.slug);
    const subagents = join(slugDir, spec.sessionId, 'subagents');
    mkdirSync(subagents, { recursive: true });
    const main = join(slugDir, `${spec.sessionId}.jsonl`);
    writeFileSync(main, '');
    touch(main);
    this.sessions.set(spec.sessionId, { spec, main, subagents });
    return main;
  }

  /**
   * Writes `sessions/<pid>.json`, the CLI's own registry — the only thing that makes a session
   * count as *running*, which is what raises a tab and lights the dot in the picker.
   *
   * `pid` must be a process that is genuinely alive: the hub asks the kernel with signal 0
   * (`server/hub.ts:209`) and a dead pid is correctly reported as not running. The recorder passes
   * its own pid, which is alive for exactly as long as the recording.
   */
  register(sessionId: string, pid: number): void {
    const { spec } = this.paths(sessionId);
    const file = join(this.root, 'sessions', `${sessionId}.json`);
    writeFileSync(
      file,
      JSON.stringify({
        sessionId,
        pid,
        cwd: spec.cwd,
        name: spec.name,
        status: 'running',
        version: '2.1.220',
        kind: 'cli',
        startedAt: Date.now(),
        updatedAt: Date.now(),
      }),
    );
  }

  /**
   * Re-stamps every registry entry.
   *
   * A registration goes stale after 90 seconds (`LIVE_WINDOW_MS`, `server/hub.ts:115`) and the
   * recording is longer than that, so without a heartbeat the tab strip would quietly vanish
   * halfway through the take — which is exactly the bug the window exists to catch, arriving in
   * the middle of a shot.
   */
  heartbeat(pid: number): void {
    for (const sessionId of this.sessions.keys()) this.register(sessionId, pid);
  }

  // ------------------------------------------------------------------ main transcript

  /** A human turn. Becomes the whiteboard's task when it is the first one. */
  human(sessionId: string, text: string): void {
    const { spec, main } = this.paths(sessionId);
    appendLine(main, {
      type: 'user',
      uuid: this.nextUuid(),
      parentUuid: null,
      sessionId,
      timestamp: this.now(),
      cwd: spec.cwd,
      version: '2.1.220',
      message: { role: 'user', content: text },
    });
  }

  /**
   * An assistant turn on the main transcript.
   *
   * `usage` is per-response and this writer gives every line its own `message.id`, so nothing is
   * double-counted: the normalizer keys cache-repeat lines by that id, and two lines sharing one
   * would be read as the same response restated rather than as two responses.
   */
  assistant(
    sessionId: string,
    content: unknown[],
    opts: { model?: string; tokens?: { in: number; out: number; cacheRead?: number; cacheWrite?: number } } = {},
  ): void {
    const { main } = this.paths(sessionId);
    const t = opts.tokens ?? { in: 1200, out: 300 };
    appendLine(main, {
      type: 'assistant',
      uuid: this.nextUuid(),
      parentUuid: null,
      sessionId,
      timestamp: this.now(),
      message: {
        id: this.nextMsgId(),
        role: 'assistant',
        model: opts.model ?? MODEL,
        content,
        usage: {
          input_tokens: t.in,
          output_tokens: t.out,
          cache_creation_input_tokens: t.cacheWrite ?? 0,
          cache_read_input_tokens: t.cacheRead ?? 0,
        },
      },
    });
  }

  /** The result of a tool call, which is what closes the "working at a desk" state. */
  toolResult(sessionId: string, toolUseId: string, text: string): void {
    const { spec, main } = this.paths(sessionId);
    appendLine(main, {
      type: 'user',
      uuid: this.nextUuid(),
      parentUuid: null,
      sessionId,
      timestamp: this.now(),
      cwd: spec.cwd,
      version: '2.1.220',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content: text }] },
    });
  }

  // ------------------------------------------------------------------- subagents

  /**
   * Opens a subagent transcript and its sidecar.
   *
   * The sidecar's `toolUseId` is the only link back to the parent's `Task` call, and so the only
   * thing that makes the spawn tree real rather than a flat list; `description` is what the roster
   * and the peek card call this person.
   */
  spawn(
    sessionId: string,
    agentId: string,
    opts: { toolUseId: string; description: string; agentType: string; model?: string; prompt: string },
  ): void {
    const { spec, subagents } = this.paths(sessionId);
    const metaFile = join(subagents, `agent-${agentId}.meta.json`);
    writeFileSync(
      metaFile,
      JSON.stringify({
        agentId,
        agentType: opts.agentType,
        description: opts.description,
        toolUseId: opts.toolUseId,
        spawnDepth: 1,
        model: opts.model ?? MODEL_ALT,
      }),
    );
    touch(metaFile);

    const file = join(subagents, `agent-${agentId}.jsonl`);
    writeFileSync(file, '');
    touch(file);
    appendLine(file, {
      parentUuid: null,
      isSidechain: true,
      agentId,
      type: 'user',
      sessionId,
      timestamp: this.now(),
      cwd: spec.cwd,
      version: '2.1.220',
      message: { role: 'user', content: opts.prompt },
    });
  }

  /** A turn by a subagent: thinking, text, tool calls — whatever blocks are handed in. */
  agentSays(
    sessionId: string,
    agentId: string,
    content: unknown[],
    opts: { model?: string; tokens?: { in: number; out: number; cacheRead?: number; cacheWrite?: number } } = {},
  ): void {
    const { subagents } = this.paths(sessionId);
    const t = opts.tokens ?? { in: 800, out: 220 };
    appendLine(join(subagents, `agent-${agentId}.jsonl`), {
      parentUuid: null,
      isSidechain: true,
      agentId,
      type: 'assistant',
      sessionId,
      timestamp: this.now(),
      message: {
        id: this.nextMsgId(),
        role: 'assistant',
        model: opts.model ?? MODEL_ALT,
        content,
        usage: {
          input_tokens: t.in,
          output_tokens: t.out,
          cache_creation_input_tokens: t.cacheWrite ?? 0,
          cache_read_input_tokens: t.cacheRead ?? 0,
        },
      },
    });
  }

  /**
   * Keeps agents on the floor without saying anything.
   *
   * The hub decides an agent has finished from its transcript's **mtime** (`server/hub.ts:818`),
   * so an agent nobody writes to walks out `quietMs` later. During a take most of the cast has to
   * stay put through beats that are about somebody else, and the obvious fix — appending filler —
   * is not available: every appended line is an event, and an event from a subagent is a walk
   * across the room and a speech bubble. Touching the file moves the mtime and writes no bytes, so
   * the tailer's byte offset is already at the end and nothing is emitted. Staying is silent,
   * which is what staying looks like.
   *
   * Leaving is therefore the absence of a call: drop an agent from the set and it goes.
   */
  keepAlive(sessionId: string, agentIds: readonly string[]): void {
    const { subagents } = this.paths(sessionId);
    for (const id of agentIds) touch(join(subagents, `agent-${id}.jsonl`));
  }

  /** A subagent's own `tool_result` line, so its open call closes and it can be seen to finish. */
  agentToolResult(sessionId: string, agentId: string, toolUseId: string, text: string): void {
    const { spec, subagents } = this.paths(sessionId);
    appendLine(join(subagents, `agent-${agentId}.jsonl`), {
      parentUuid: null,
      isSidechain: true,
      agentId,
      type: 'user',
      sessionId,
      timestamp: this.now(),
      cwd: spec.cwd,
      version: '2.1.220',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content: text }] },
    });
  }
}

// -------------------------------------------------------------------- content blocks

export const thinking = (text: string): unknown => ({ type: 'thinking', thinking: text, signature: 'sig' });
export const say = (text: string): unknown => ({ type: 'text', text });
export const toolUse = (id: string, name: string, input: Record<string, unknown>): unknown => ({
  type: 'tool_use',
  id,
  name,
  input,
});
/**
 * A spawn, as the parent writes it: a `Task` call whose id the child's sidecar quotes back.
 *
 * `description` is not decoration — it is first in the normalizer's precedence for a tool's
 * target, so it is what the parent's own nameplate reads while the spawn is open. Without it the
 * room would say `Task general-purpose`.
 */
export const task = (id: string, prompt: string, subagentType: string): unknown =>
  toolUse(id, 'Task', { prompt, description: prompt, subagent_type: subagentType });
