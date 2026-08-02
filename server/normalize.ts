import type { AgentRef, Ev } from '../shared/events';
import type { RawLine } from './parse';

/** Omit that distributes over a union, so each member keeps its own shape minus K. */
type DistributiveOmit<T, K extends keyof any> = T extends unknown ? Omit<T, K> : never;

// Module-level so seq stays monotonic across every Normalizer instance in the process.
let SEQ = 0;

const toEpochMs = (iso?: string): number => (typeof iso === 'string' ? Date.parse(iso) : Date.now());

const FILE_EDIT_TOOLS: readonly string[] = ['Edit', 'Write', 'NotebookEdit'];
const SPAWN_TOOLS: readonly string[] = ['Task', 'Agent'];

export class Normalizer {
  private seenAgent = false;
  private modelSeen = false;

  constructor(
    private readonly sessionId: string,
    private readonly agentId: string | 'main',
  ) {}

  private ref(): AgentRef {
    return { sessionId: this.sessionId, agentId: this.agentId };
  }

  feed(line: RawLine): Ev[] {
    const out: Ev[] = [];
    const ts = toEpochMs(line.timestamp);
    const push = (e: DistributiveOmit<Ev, 'seq'>): void => {
      out.push({ ...e, seq: ++SEQ });
    };

    // First line of a file always announces the agent. Its model is usually still
    // unknown at that point (e.g. the opening line is a user turn), so once a later
    // line first reveals message.model, emit one more agentSeen with it filled in.
    const model = line.message?.model;
    const hasModel = typeof model === 'string';
    if (!this.seenAgent) {
      this.seenAgent = true;
      push({ kind: 'agentSeen', ref: this.ref(), model, ts });
      if (hasModel) this.modelSeen = true;
    } else if (!this.modelSeen && hasModel) {
      this.modelSeen = true;
      push({ kind: 'agentSeen', ref: this.ref(), model, ts });
    }

    const content = line.message?.content;
    if (line.type === 'user' && typeof content === 'string') {
      push({ kind: 'userMessage', ref: this.ref(), text: content, ts });
    }

    if (Array.isArray(content)) {
      for (const block of content) {
        if (!block || typeof block !== 'object') continue; // skip malformed/null blocks, never crash
        const b = block as Record<string, unknown>;

        if (b.type === 'thinking' && typeof b.thinking === 'string' && b.thinking.trim().length > 0) {
          push({ kind: 'thinking', ref: this.ref(), text: b.thinking, ts });
        } else if (b.type === 'text' && typeof b.text === 'string' && line.message?.role === 'assistant') {
          push({ kind: 'agentText', ref: this.ref(), text: b.text, ts });
        } else if (b.type === 'tool_result' && typeof b.tool_use_id === 'string') {
          push({ kind: 'toolResult', ref: this.ref(), toolUseId: b.tool_use_id, ok: !b.is_error, ts });
        } else if (b.type === 'tool_use' && typeof b.name === 'string' && typeof b.id === 'string') {
          const input = (b.input ?? {}) as Record<string, unknown>;
          const target =
            typeof input.file_path === 'string'
              ? input.file_path
              : typeof input.pattern === 'string'
                ? input.pattern
                : undefined;
          push({ kind: 'toolStart', ref: this.ref(), tool: b.name, toolUseId: b.id, target, ts });

          if (FILE_EDIT_TOOLS.includes(b.name) && typeof input.file_path === 'string') {
            push({ kind: 'fileEdit', ref: this.ref(), path: input.file_path, ts });
          }
          if (SPAWN_TOOLS.includes(b.name) && typeof input.prompt === 'string') {
            push({ kind: 'agentSpawn', ref: this.ref(), childAgentId: 'pending', prompt: input.prompt, ts });
          }
        }
        // Unrecognized block types are silently skipped.
      }
    }

    const usage = line.message?.usage;
    if (usage && typeof usage.input_tokens === 'number' && typeof usage.output_tokens === 'number') {
      push({ kind: 'usage', ref: this.ref(), inTok: usage.input_tokens, outTok: usage.output_tokens, ts });
    }

    return out;
  }
}
