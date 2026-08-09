/**
 * One transcript line, narrowed just enough to read without trusting it.
 *
 * The JSONL schema is undocumented and moves between CLI releases, so everything past `type` is
 * optional and every consumer re-checks the field it wants. A line this parser cannot make sense
 * of is dropped, never guessed at.
 */
export type RawLine = {
  type: string;
  uuid?: string;
  parentUuid?: string;
  agentId?: string;
  sessionId?: string;
  timestamp?: string;
  cwd?: string;
  version?: string;
  gitBranch?: string;
  /**
   * True on the one `user` line the CLI writes after compacting a conversation.
   *
   * That line is not the human speaking: it is ~14 500 characters of the CLI's own summary,
   * opening "This session is being continued from a previous conversation that ran out of
   * context." Without this flag it reads as the longest thing the user ever typed, and — being a
   * `user` turn in the main transcript — it becomes the session's task.
   */
  isCompactSummary?: boolean;
  message?: {
    /**
     * The API response id. One assistant response is written across several JSONL lines — one per
     * content block — and every one of them repeats the same `usage` object, so this is what
     * tells them apart from genuinely separate turns.
     */
    id?: string;
    role?: string;
    model?: string;
    content?: unknown;
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      cache_creation_input_tokens?: number;
      cache_read_input_tokens?: number;
    };
  };
};

export function parseLine(raw: string): RawLine | null {
  try {
    const v: unknown = JSON.parse(raw);
    if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
    const o = v as Record<string, unknown>;
    if (typeof o.type !== 'string') return null;
    return o as unknown as RawLine;
  } catch {
    return null;
  }
}
