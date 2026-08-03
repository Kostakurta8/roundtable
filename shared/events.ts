/**
 * The normalized event vocabulary: everything the hub can learn from a transcript, in one union.
 *
 * Every frame carries `ts` (epoch ms) and `seq` (monotonic across the whole process). `seq` is
 * what makes the stream idempotent — the client folds by it, so a replayed backlog, a double
 * `follow`, or a watcher that reads the same bytes twice can never be counted twice.
 */

export type AgentRef = { sessionId: string; agentId: string | 'main' };

/**
 * What `agent-<id>.meta.json` tells us about a subagent, plus the model its lines report.
 *
 * The sidecar exists from the moment the agent is spawned, which is why it is worth reading: the
 * transcript alone identifies an agent by a bare hex id, and nobody watching an office wants to
 * be told that `af72b58f0662a3abe` just stood up. `description` is the human sentence the caller
 * wrote ("Map the office layout"), and `toolUseId` is the parent's `tool_use` id — the only thing
 * that ties a child back to the `Task` call that created it, and so the only honest source for
 * the parent→child tree.
 */
export type AgentMeta = {
  model?: string;
  /** The caller's own description of the task, used as the agent's display name. */
  label?: string;
  /** Registered subagent type: `Explore`, `general-purpose`, `workflow-subagent`… */
  agentType?: string;
  /** The parent's `tool_use` id for the `Task` call that spawned this agent. */
  parentToolUseId?: string;
  /** 1 for a child of the session, 2 for a child of a child. */
  spawnDepth?: number;
  /** The `wf_…` run this agent belongs to, when a Workflow script spawned it. */
  workflowId?: string;
};

/**
 * One usage report.
 *
 * Cache tokens are not a footnote: a real turn bills something like 2 input, 897 output, 19 103
 * cache-write and 28 931 cache-read, so a total that counts only `in + out` understates the turn
 * by a factor of fifty. They are separate fields rather than folded into `in` because they are
 * priced differently — a cache read is a tenth of an input token, a cache write is a quarter more
 * — and the cost estimate needs them apart.
 */
export type TokenUse = {
  in: number;
  out: number;
  cacheRead: number;
  cacheWrite: number;
};

export const ZERO_USE: TokenUse = { in: 0, out: 0, cacheRead: 0, cacheWrite: 0 };

export const useTotal = (u: TokenUse): number => u.in + u.out + u.cacheRead + u.cacheWrite;

export const addUse = (a: TokenUse, b: TokenUse): TokenUse => ({
  in: a.in + b.in,
  out: a.out + b.out,
  cacheRead: a.cacheRead + b.cacheRead,
  cacheWrite: a.cacheWrite + b.cacheWrite,
});

/**
 * `a - b`, field by field.
 *
 * A streamed response is written as several JSONL lines that share one `message.id`, and each
 * repeats that response's usage *as it stands so far* — the first line says `output_tokens: 1`
 * and the last says the total. The normalizer therefore publishes the difference between what a
 * response has now billed and what it has already reported, so the store can keep adding.
 */
export const subUse = (a: TokenUse, b: TokenUse): TokenUse => ({
  in: a.in - b.in,
  out: a.out - b.out,
  cacheRead: a.cacheRead - b.cacheRead,
  cacheWrite: a.cacheWrite - b.cacheWrite,
});

/**
 * The larger of each field.
 *
 * A response's usage is meant to only grow as its lines are written, and almost always does — but
 * one response in 400 sampled transcripts reported its cache figures *down* on a later line. Since
 * what crosses the wire is a difference and the store adds differences, that would publish a
 * negative delta and the session's totals would visibly fall mid-run.
 */
export const maxUse = (a: TokenUse, b: TokenUse): TokenUse => ({
  in: Math.max(a.in, b.in),
  out: Math.max(a.out, b.out),
  cacheRead: Math.max(a.cacheRead, b.cacheRead),
  cacheWrite: Math.max(a.cacheWrite, b.cacheWrite),
});

/** True when every field is zero — a delta worth publishing has at least one that is not. */
export const isZeroUse = (u: TokenUse): boolean =>
  u.in === 0 && u.out === 0 && u.cacheRead === 0 && u.cacheWrite === 0;

/** How a tool call ended, as the office and the feed both need to show it. */
export type ToolOutcome = 'ok' | 'err';

/**
 * The verdict an agent wrote, if it wrote one — the single implementation, for the two readers
 * that have to agree.
 *
 * `src/store.ts` decides whether a chat card is badged CONFIRMED or REFUTED;
 * `src/office/mapping.ts` decides whether the room stages a confront and in which colour. They
 * read the same messages, so a message that is a verdict to one and not to the other puts an
 * agent on a red walk across the office that the feed has no card for. That is not hypothetical:
 * the two had already forked — the store tested `/\bREFUTED\b/` while mapping still used
 * `.includes('REFUTED')`, under a comment insisting the two matched "exactly" — so "UNREFUTED"
 * was a refutation to the room and nothing at all to the feed.
 *
 * Case-sensitive, because prose like "confirmed the fix" is not a verdict. Word-bounded, because
 * an unbounded substring fires on "UNREFUTED" and on any token that happens to contain the
 * marker. A message carrying both markers is a refutation: the negative result is the one that
 * matters.
 */
export const verdictOf = (text: string): ToolOutcome | undefined =>
  /\bREFUTED\b/.test(text) ? 'err' : /\bCONFIRMED\b/.test(text) ? 'ok' : undefined;

/**
 * Who really wrote a `user` line.
 *
 * The `user` role in a transcript is a lane, not a person: slash-command echoes, hook output,
 * `<system-reminder>` blocks, tool results and pasted attachments all arrive on it. Rendering the
 * lot as "you said" put a wall of machine text in the human's mouth and buried their actual
 * prompt, so the normalizer labels each line and the feed shows only `human` by default.
 *
 * `compaction` is the CLI's own summary of everything it had to forget. It is the largest thing
 * on the lane — around 14 500 characters — and it is written *as* a user turn, so it read as the
 * longest sentence the human had ever typed and, being a user turn in the main transcript, it
 * became the session's task on the whiteboard.
 */
export type UserSource = 'human' | 'command' | 'hook' | 'reminder' | 'caveat' | 'compaction';

export type Ev =
  | { kind: 'sessionSeen'; sessionId: string; cwd: string; live: boolean; ts: number; seq: number }
  | ({ kind: 'agentSeen'; ref: AgentRef; ts: number; seq: number } & AgentMeta)
  | { kind: 'userMessage'; ref: AgentRef; text: string; source?: UserSource; ts: number; seq: number }
  | { kind: 'agentText'; ref: AgentRef; text: string; ts: number; seq: number }
  | { kind: 'thinking'; ref: AgentRef; text: string; ts: number; seq: number }
  | { kind: 'toolStart'; ref: AgentRef; tool: string; target?: string; toolUseId: string; ts: number; seq: number }
  | {
      kind: 'toolResult';
      ref: AgentRef;
      toolUseId: string;
      ok: boolean;
      /**
       * What the failure actually said — absent on success, and absent on a failure that carried
       * no text at all.
       *
       * `ok: boolean` on its own is the end of the trail: the UI could colour a chip red and count
       * it, and a person looking at that chip had no way to find out what went wrong, in an app
       * whose whole job is to explain what a session is doing. The text is the transcript's own,
       * normalized by `server/normalize.ts` — unwrapped from `<tool_use_error>`, redacted, and
       * capped — never a sentence this codebase wrote on the tool's behalf.
       *
       * Measured over every transcript on this machine (2 552 files, 84 493 `tool_result` blocks):
       * 2 291 are errors, and every single one of them carries `content` as a plain string. The
       * array-of-blocks form is real — 10 798 *successful* results use it, mostly to return images
       * — so the extractor handles both, but no failure has ever arrived that way here.
       */
      error?: string;
      ts: number;
      seq: number;
    }
  | { kind: 'fileEdit'; ref: AgentRef; path: string; ts: number; seq: number }
  | {
      kind: 'agentSpawn';
      ref: AgentRef;
      childAgentId: string;
      prompt: string;
      /** The `tool_use` id of the `Task` call, so the child's sidecar can be matched to it later. */
      toolUseId?: string;
      /**
       * Whether the caller launched this agent in the background.
       *
       * It decides what the parent's eventual `tool_result` actually means. For a foreground spawn
       * the parent blocks until the child is finished, so the result *is* the end. For a background
       * one it comes back the instant the agent is launched, and the child then works for minutes
       * or tens of minutes afterwards — 246 spawns on this machine reported the child done while it
       * was still writing, by as much as 995 seconds.
       *
       * Only 43% of real spawns record the flag at all (102 true, 43 false, 189 absent out of 334),
       * so it is a fast path and never the only test: absent is treated as "cannot rely on the
       * result", which is the safe direction.
       */
      background?: boolean;
      ts: number;
      seq: number;
    }
  /** The parent's `tool_result` for a spawn came back: that child has finished. */
  | { kind: 'agentDone'; ref: AgentRef; ok: boolean; ts: number; seq: number }
  /**
   * Tokens billed since the last `usage` for this agent — a delta, always, never a running total.
   *
   * The transcript does not report deltas: a streamed response writes one line per content block,
   * each repeating that response's usage as it stands, so the first line of a long turn says
   * `output_tokens: 1` and the last says the real figure. `server/normalize.ts` holds the current
   * response and publishes the difference, which is why the store can simply keep adding.
   */
  | {
      kind: 'usage';
      ref: AgentRef;
      /** Retained so a hub and a client of different vintages still agree on the basics. */
      inTok: number;
      outTok: number;
      cacheRead?: number;
      cacheWrite?: number;
      /**
       * The model that billed these tokens.
       *
       * 9% of transcripts carry more than one — a `/model` switch, or an overload fallback — and
       * pricing a whole session at whichever model happened to speak first is off by the ratio
       * between two rate cards. Absent only when the line itself named no model.
       */
      model?: string;
      ts: number;
      seq: number;
    };

export type EvKind = Ev['kind'];

/**
 * Every kind this build knows. Used by the guard below, and by the client's filter UI so a new
 * event kind shows up as a filter row without anyone having to remember to add it there too.
 */
export const EV_KINDS: readonly EvKind[] = [
  'sessionSeen',
  'agentSeen',
  'userMessage',
  'agentText',
  'thinking',
  'toolStart',
  'toolResult',
  'fileEdit',
  'agentSpawn',
  'agentDone',
  'usage',
];

const KIND_SET: ReadonlySet<string> = new Set<string>(EV_KINDS);

/**
 * Recognizes an event frame.
 *
 * Control frames (`hello`, `backlogTruncated`) carry no `seq`, which is the property this keys on
 * — but a bare `'seq' in x` check would also accept a control frame from a newer hub that happened
 * to grow one, and hand the reducer an object with no handler. Checking the kind against the known
 * set instead means an unknown frame is ignored rather than folded, which is the safe direction:
 * this client must survive a hub that knows more than it does.
 */
export const isEv = (x: unknown): x is Ev => {
  if (!x || typeof x !== 'object') return false;
  const o = x as { kind?: unknown; seq?: unknown; ts?: unknown };
  return typeof o.kind === 'string' && KIND_SET.has(o.kind) && typeof o.seq === 'number' && typeof o.ts === 'number';
};

/** The agent an event belongs to, or `undefined` for the session-wide ones that have no `ref`. */
export const evAgent = (ev: Ev): string | undefined => ('ref' in ev ? ev.ref.agentId : undefined);

/**
 * The session an event belongs to, whichever shape it has.
 *
 * Every event carries this one way or the other — inside `ref` for the ones about an agent, at the
 * top level for `sessionSeen`, which is about no agent in particular. It became load-bearing when
 * the client stopped following one session at a time: this is what routes an arriving frame to the
 * right session's store, and `'ref' in ev` alone silently drops the only kind that has no agent.
 */
export const evSession = (ev: Ev): string => ('ref' in ev ? ev.ref.sessionId : ev.sessionId);
