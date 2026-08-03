/**
 * RawLine → Ev[]: the one place transcript shape becomes observer vocabulary.
 *
 * One Normalizer per transcript file. It holds the little state a fold needs — whether the agent
 * has been announced, whether its model is known yet, what its sidecar said — so that two files
 * can never contaminate each other's `agentSeen`.
 */
import {
  isZeroUse,
  maxUse,
  subUse,
  ZERO_USE,
  type AgentMeta,
  type AgentRef,
  type Ev,
  type TokenUse,
  type UserSource,
} from '../shared/events';
import type { RawLine } from './parse';

/** Omit that distributes over a union, so each member keeps its own shape minus K. */
type DistributiveOmit<T, K extends keyof never> = T extends unknown ? Omit<T, K> : never;

// Module-level so seq stays monotonic across every Normalizer instance in the process.
let SEQ = 0;

/** Test seam: resets the shared counter so a fixture run starts from a known sequence. */
export const __resetSeq = (): void => {
  SEQ = 0;
};

/**
 * The next sequence number, for events the hub derives rather than reads — `agentDone`, which
 * exists only because a parent's `tool_result` came back, has no line of its own to be normalized
 * from. Sharing the counter is the point: `seq` must be monotonic across everything a client
 * receives, whichever half of the server minted it.
 */
export const nextSeq = (): number => ++SEQ;

const FILE_EDIT_TOOLS: readonly string[] = ['Edit', 'Write', 'NotebookEdit'];
const SPAWN_TOOLS: readonly string[] = ['Task', 'Agent'];

/**
 * Where a tool call names the thing it is acting on, in precedence order.
 *
 * Four keys used to be read — `file_path`, `pattern`, `command`, `url` — which covered the file
 * and shell tools and nothing else. Measured by running this file over every transcript on this
 * machine (2 553 files, 84 607 `tool_use` blocks), that named 74 495 of them — **88.05%** — and
 * left **11.95%** anonymous: the room showed those agents doing something unnameable and the feed
 * showed a bare tool name. The list below names 82 382, **97.37%**, leaving 2.63%.
 *
 * The counts are how often each key is the one that wins, over that same corpus. Order is by what
 * identifies the call best, not by frequency — `subject` sits above `description` because a
 * `TaskCreate` carries both and its `subject` is the one-line title while its `description` is a
 * paragraph; `description` sits above `prompt` because an `Agent` spawn carries both and the
 * description is the caller's own three-word summary of the prompt.
 *
 * What is deliberately still anonymous is the 2.63%: `StructuredOutput` (1 490 calls, whose input
 * *is* the schema payload — there is no target in it), `AskUserQuestion` (135, a `questions`
 * array), and the Playwright verbs that genuinely act on nothing in particular — `browser_close`,
 * `browser_resize`, `browser_console_messages`. Inventing a target for those would be worse than
 * having none.
 */
const TARGET_KEYS: readonly string[] = [
  'file_path', //     Read, Edit, Write, NotebookEdit                                     31 890
  'pattern', //       Grep, Glob                                                           3 832
  'command', //       Bash                                                                34 454
  'url', //           WebFetch                                                             4 200
  'query', //         WebSearch, ToolSearch, and the MCP search tools                      3 881
  'subject', //       TaskCreate, TaskUpdate — the short title, not the paragraph            582
  'description', //   Agent/Task spawns, Workflow                                            435
  'subagent_type', // an Agent spawn that carried no description                                 0
  'skill', //         Skill                                                                   135
  'prompt', //        ScheduleWakeup, and a spawn with none of the above                        42
  'taskId', //        TaskUpdate                                                              810
  'task_id', //       TaskStop, TaskOutput                                                     91
  'element', //       the Playwright tools' own words for what they clicked or typed into     320
  'filename', //      browser_take_screenshot, browser_snapshot                                245
  'scriptPath', //    Workflow                                                                  16
  'function', //      browser_evaluate                                                         905
  'code', //          browser_run_code_unsafe                                                  361
  'text', //          browser_type, browser_wait_for                                            54
  'key', //           browser_press_key                                                         10
];

/**
 * How much of a target crosses the socket.
 *
 * Uncapped, the average target is 220 characters and the longest in the corpus is 35 125 — a
 * pasted script inside a `Bash` command. A target is a label: `src/office/mapping.ts` puts it on a
 * nameplate 60 characters wide, the tools panel puts it on one ellipsized row. Sending thirty-five
 * kilobytes per tool call to render sixty of them is a cost with no reader.
 */
const TARGET_MAX_LEN = 400;

/**
 * How much of a failure crosses the socket.
 *
 * 2 291 error results, averaging 479 characters; 80% of them are under 600 and survive whole. The
 * longest is 10 040 — a `mysql --help` dump behind an `Exit code 1`, where the first line is the
 * whole story anyway. Truncation is from the head because that is where these messages put the
 * sentence: `Exit code 127` is followed immediately by `php: command not found`.
 */
const ERROR_MAX = 600;

/** The CLI wraps some of its own failures in this. It is markup, not message: 350 of 2 291. */
const TOOL_USE_ERROR = /^\s*<tool_use_error>([\s\S]*)<\/tool_use_error>\s*$/;

/**
 * A named credential and its value, as a stack trace echoes it back.
 *
 * Not hypothetical and not rare enough to ignore: 5 of the corpus's 2 291 error results carry a
 * plaintext password, every one of them a Python traceback re-printing the `pymysql.connect(host=…,
 * user='root', password='…')` line that raised. Error text is the one field here that is verbatim
 * machine output rather than a path or a tool name, so it is the one that needs this. The key is
 * kept and only the value is replaced, so the message still reads.
 */
const SECRET_KV =
  /(^|[^A-Za-z0-9])((?:[A-Za-z0-9]+[_-])*(?:password|passwd|pwd|secret|api[_-]?key|apikey|access[_-]?token|auth[_-]?token|client[_-]?secret))(\s*[=:]\s*)(["']?)([^\s,;"')]+)\4/gi;

/**
 * `Authorization: Bearer …` and `-p<password>`, which carry no key to match on.
 *
 * The header form is a fixed phrase rather than a `key=value`, so `SECRET_KV` cannot see it; the
 * MySQL form is worse — `-p` is glued to the password with no separator at all, which is why it is
 * matched as its own shape rather than by a general rule.
 */
const SECRET_HEADER = /\b(Authorization\s*:\s*)(Bearer|Basic)\s+\S+/gi;
const SECRET_MYSQL_P = /(\s-p)(?!assword\b)([^\s'"]+)/g;

/** The token formats that are recognizable on sight, so a leaked one never needs a `key=` beside it. */
const SECRET_TOKEN = /\b(sk-ant-|sk-proj-|sk-|gh[pousr]_|AKIA|xox[abposr]-|npm_)[A-Za-z0-9_-]{16,}/g;

const redact = (s: string): string =>
  s
    // `lead` is captured and put back: the pattern has to consume the character before the key to
    // prove it is not part of a longer word, and dropping it would silently corrupt the line —
    // `export DB_PASSWORD=x` would come out as `exportDB_PASSWORD=***`.
    .replace(
      SECRET_KV,
      (_m, lead: string, key: string, sep: string, quote: string) => `${lead}${key}${sep}${quote}***${quote}`,
    )
    .replace(SECRET_HEADER, '$1$2 ***')
    .replace(SECRET_MYSQL_P, '$1***')
    .replace(SECRET_TOKEN, '$1***');

/** Whitespace runs — including newlines — collapsed to single spaces, then trimmed. */
const flatten = (s: string): string => s.replace(/\s+/g, ' ').trim();

const clipTo = (s: string, max: number): string => (s.length > max ? `${s.slice(0, max - 1)}…` : s);

/**
 * The first key a tool call actually filled in, flattened to one line and capped.
 *
 * Flattening is not cosmetic: 9 661 `Bash` commands, 479 `browser_evaluate` functions and 359
 * `browser_run_code_unsafe` bodies span several lines, and every reader of `target` renders it as
 * a single label — a nameplate, a status line, one row of a table.
 *
 * Redacted for the same reason the error text is, and more urgently since this list grew: a
 * target is now sometimes an SQL statement or a page-evaluate body rather than a path, and a
 * `Bash` command with `pwd=…` on it is a thing that has really been typed. What this catches is a
 * named credential and a recognizable token; what it cannot catch is a secret that looks like any
 * other string — a bare literal inside an `insert into … values (…)` is still a bare literal.
 */
function targetOf(input: Readonly<Record<string, unknown>>): string | undefined {
  for (const key of TARGET_KEYS) {
    const v = input[key];
    if (typeof v !== 'string') continue;
    const flat = flatten(v);
    if (flat.length > 0) return clipTo(redact(flat), TARGET_MAX_LEN);
  }
  return undefined;
}

/**
 * What a failed `tool_result` said, ready to cross the socket.
 *
 * Newlines survive — 59% of these are multi-line and the shape is the message ("Exit code 1" then
 * the stderr that explains it) — so the panel renders this pre-wrapped rather than as one line.
 */
function errorText(content: unknown): string | undefined {
  let raw: string;
  if (typeof content === 'string') {
    raw = content;
  } else if (Array.isArray(content)) {
    // No error in the corpus arrives this way, but 10 798 *successful* results do, so the shape is
    // real and a future vintage could use it for both. Non-text blocks (images) contribute nothing.
    raw = content
      .map((b) => (b && typeof b === 'object' && typeof (b as { text?: unknown }).text === 'string' ? (b as { text: string }).text : ''))
      .filter((t) => t.length > 0)
      .join('\n');
  } else {
    return undefined;
  }
  const unwrapped = TOOL_USE_ERROR.exec(raw)?.[1] ?? raw;
  const text = redact(unwrapped.replace(/\r\n/g, '\n').trim());
  return text.length === 0 ? undefined : clipTo(text, ERROR_MAX);
}

/**
 * The `user` lane carries far more than the human. Each marker below is written by the CLI itself
 * and never by a person, so a line that opens with one is machinery, not speech.
 */
const SOURCE_MARKERS: readonly (readonly [RegExp, UserSource])[] = [
  [/^\s*<local-command-caveat>/, 'caveat'],
  [/^\s*<(command-name|command-message|command-args|local-command-stdout|local-command-stderr)>/, 'command'],
  [/^\s*<system-reminder>/, 'reminder'],
  [/^\s*(<user-prompt-submit-hook>|[A-Za-z ]*hook additional context:)/, 'hook'],
];

/**
 * The sentence every compaction summary opens with.
 *
 * `isCompactSummary` is the authoritative marker and is checked first; this is the fallback for a
 * CLI vintage that does not write the flag. A human typing this exact boilerplate as their own
 * prompt is not a risk worth designing around, and the only consequence of a false positive is
 * that the line does not become the whiteboard task — which is the safe direction.
 */
const COMPACT_OPENER = /^\s*This session is being continued from a previous conversation/;

function classify(text: string, compacted = false): UserSource {
  if (compacted || COMPACT_OPENER.test(text)) return 'compaction';
  for (const [re, source] of SOURCE_MARKERS) {
    if (re.test(text)) return source;
  }
  return 'human';
}

/**
 * A transcript timestamp, or the clock as a last resort.
 *
 * `Date.parse` yields NaN for anything it does not recognize, and a NaN `ts` is not a cosmetic
 * problem downstream: it fails every comparison, so the feed's sorted insert puts the message in
 * an arbitrary place, the timeline cannot bucket it, and `new Date(NaN).toISOString()` throws
 * inside the render. Falling back to now is a small lie about when; NaN is a broken UI.
 */
function toEpochMs(iso: string | undefined, fallback: number): number {
  if (typeof iso !== 'string') return fallback;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : fallback;
}

const nonEmpty = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0;

const int = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

export class Normalizer {
  private seenAgent = false;
  /**
   * The model this agent's lines last reported.
   *
   * Not a "have we seen one yet" latch: 9% of real transcripts carry more than one model, from a
   * `/model` switch or an overload fallback, and an agent that latched the first one forever
   * priced the rest of its session at the wrong rate card and printed the wrong name in the HUD.
   */
  private lastModel?: string;
  private meta: AgentMeta;

  /**
   * The response whose usage is currently being accumulated, and how much of it has been sent.
   *
   * A single assistant response is appended as several JSONL lines — one per content block, and a
   * long turn with thinking plus half a dozen tool calls runs to eight — all sharing one
   * `message.id`. Each line repeats that response's usage *as it stood when the line was written*,
   * so the first says `output_tokens: 1` and the last says the total. Summing every line
   * over-counted by roughly 2.4x; keeping the first under-counted by roughly half — measured over
   * all 2 548 transcripts on this machine, 26 094 of 62 943 responses diverge, and first-wins
   * reports 39.7M output tokens where last-wins reports 80.3M.
   *
   * So neither: the last line wins, and what gets published is the difference between what the
   * response has now billed and what has already been reported for it. `flush()` is what emits
   * that difference, which is why a response is never held past the batch it arrived in.
   */
  private usageId?: string;
  private usageSeen: TokenUse = ZERO_USE;
  private usageSent: TokenUse = ZERO_USE;
  private usageModel?: string;
  private usageTs = 0;

  constructor(
    private readonly sessionId: string,
    private readonly agentId: string | 'main',
    meta: AgentMeta = {},
  ) {
    this.meta = meta;
    this.lastModel = meta.model;
  }

  private ref(): AgentRef {
    return { sessionId: this.sessionId, agentId: this.agentId };
  }

  private stamp(e: DistributiveOmit<Ev, 'seq'>): Ev {
    return { ...e, seq: ++SEQ } as Ev;
  }

  /**
   * Folds in a sidecar that was read (or re-read) after construction.
   *
   * The sidecar and the transcript race: which one lands first depends on filesystem timing, so
   * this returns a fresh `agentSeen` whenever it actually learned something. Nothing is emitted
   * when the sidecar adds no new field, so a rescan loop cannot spam the roster.
   */
  applyMeta(meta: AgentMeta, ts = Date.now()): Ev[] {
    let changed = false;
    const merged: AgentMeta = { ...this.meta };
    for (const [k, v] of Object.entries(meta) as [keyof AgentMeta, unknown][]) {
      if (v === undefined || merged[k] === v) continue;
      (merged as Record<string, unknown>)[k] = v;
      changed = true;
    }
    if (!changed) return [];
    this.meta = merged;
    if (merged.model) this.lastModel = merged.model;
    this.seenAgent = true;
    return [this.stamp({ kind: 'agentSeen', ref: this.ref(), ...merged, ts })];
  }

  feed(line: RawLine): Ev[] {
    const out: Ev[] = [];
    const ts = toEpochMs(line.timestamp, Date.now());
    const push = (e: DistributiveOmit<Ev, 'seq'>): void => {
      out.push(this.stamp(e));
    };

    // The first line of a file always announces its agent. The model is usually still unknown at
    // that point (an opening user turn carries none), so the first line that does reveal one
    // emits a second `agentSeen` with it filled in — an upsert on the client, not a duplicate.
    // Every *later* change of model does the same, because a session that switches models has
    // genuinely changed what it is: a different name to print and a different rate card to bill.
    const model = line.message?.model;
    const hasModel = typeof model === 'string';
    if (!this.seenAgent) {
      this.seenAgent = true;
      push({ kind: 'agentSeen', ref: this.ref(), ...this.meta, ...(hasModel ? { model } : {}), ts });
      if (hasModel) this.lastModel = model;
    } else if (hasModel && model !== this.lastModel) {
      this.lastModel = model;
      push({ kind: 'agentSeen', ref: this.ref(), ...this.meta, model, ts });
    }

    const content = line.message?.content;
    const compacted = line.isCompactSummary === true;

    if (line.type === 'user' && typeof content === 'string') {
      push({ kind: 'userMessage', ref: this.ref(), text: content, source: classify(content, compacted), ts });
    }

    if (Array.isArray(content)) {
      for (const block of content) {
        if (!block || typeof block !== 'object') continue; // malformed/null block — skip, never crash
        const b = block as Record<string, unknown>;

        if (b.type === 'thinking' && nonEmpty(b.thinking)) {
          push({ kind: 'thinking', ref: this.ref(), text: b.thinking, ts });
          continue;
        }

        if (b.type === 'text' && typeof b.text === 'string' && line.message?.role === 'assistant') {
          // An assistant turn that is only whitespace is a real thing in transcripts (a turn that
          // went straight to tools). It would render as an empty card and, in the office, as an
          // agent walking a blank note across the room.
          if (nonEmpty(b.text)) push({ kind: 'agentText', ref: this.ref(), text: b.text, ts });
          continue;
        }

        if (b.type === 'text' && nonEmpty(b.text) && line.message?.role === 'user') {
          const text = b.text;
          push({ kind: 'userMessage', ref: this.ref(), text, source: classify(text, compacted), ts });
          continue;
        }

        if (b.type === 'tool_result' && typeof b.tool_use_id === 'string') {
          const ok = !b.is_error;
          // Only a failure carries its text: a successful result is the tool's output, which is
          // the transcript itself and belongs nowhere near a status line.
          const error = ok ? undefined : errorText(b.content);
          push({
            kind: 'toolResult',
            ref: this.ref(),
            toolUseId: b.tool_use_id,
            ok,
            ...(error === undefined ? {} : { error }),
            ts,
          });
          continue;
        }

        if (b.type === 'tool_use' && typeof b.name === 'string' && typeof b.id === 'string') {
          const input = (b.input ?? {}) as Record<string, unknown>;
          const target = targetOf(input);
          push({ kind: 'toolStart', ref: this.ref(), tool: b.name, toolUseId: b.id, target, ts });

          if (FILE_EDIT_TOOLS.includes(b.name) && typeof input.file_path === 'string') {
            push({ kind: 'fileEdit', ref: this.ref(), path: input.file_path, ts });
          }
          if (SPAWN_TOOLS.includes(b.name) && typeof input.prompt === 'string') {
            // The child's id is not knowable here — it appears only once the child's own sidecar
            // lands on disk. `toolUseId` is what the hub later matches that sidecar against.
            push({
              kind: 'agentSpawn',
              ref: this.ref(),
              childAgentId: 'pending',
              prompt: input.prompt,
              toolUseId: b.id,
              ...(typeof input.run_in_background === 'boolean'
                ? { background: input.run_in_background }
                : {}),
              ts,
            });
          }
        }
      }
    }

    const usage = line.message?.usage;
    const usageId = line.message?.id;
    if (usage && (typeof usage.input_tokens === 'number' || typeof usage.output_tokens === 'number')) {
      const reported: TokenUse = {
        in: int(usage.input_tokens),
        out: int(usage.output_tokens),
        cacheRead: int(usage.cache_read_input_tokens),
        cacheWrite: int(usage.cache_creation_input_tokens),
      };
      if (usageId === undefined) {
        // No id: these lines cannot be grouped into a response at all, so each one stands alone.
        // Counting it is the lesser error — under-reporting a real turn is worse than the rare
        // double count from a transcript vintage that omits the field.
        if (!isZeroUse(reported)) {
          out.push(this.usageEvent(reported, hasModel ? model : this.lastModel, ts));
        }
      } else {
        // A different response has begun, so the previous one is complete: publish whatever of it
        // is still unreported before the accumulator is pointed somewhere else. In 250 sampled
        // transcripts, across 35 101 usage-bearing lines, an id never resumed after another id
        // appeared — responses are written contiguously — so this is the only place a response
        // ends other than the end of a read batch.
        const continuing = this.usageId === usageId;
        if (this.usageId !== undefined && !continuing) {
          out.push(...this.flush());
          // `flush` leaves `usageSent` holding the *previous* response's total. The accumulator is
          // about to point at a different response, which has reported nothing yet.
          this.usageSent = ZERO_USE;
        }
        this.usageId = usageId;
        // Field-wise max, not a straight overwrite. A response's usage almost always only grows,
        // but not quite always: one response in 400 sampled transcripts reported its cache figures
        // *down* on a later line (cacheRead 246 389 → 228 908, cacheWrite 4 975 → 0). Overwriting
        // made the next delta negative, and the store adds deltas — so the session's token total
        // and its cost visibly fell mid-run before recovering. Taking the maximum keeps the total
        // identical to last-wins for every response that behaves, and monotonic for the one that
        // does not.
        this.usageSeen = continuing ? maxUse(this.usageSeen, reported) : reported;
        this.usageModel = hasModel ? model : this.usageModel;
        this.usageTs = ts;
      }
    }

    return out;
  }

  /**
   * Publishes whatever the current response has billed and not yet reported.
   *
   * The hub calls this at the end of every read batch, so a response that arrives whole — which is
   * almost all of them — is published on the same tick as its last line, carrying the true total
   * rather than the `output_tokens: 1` its first line claimed. A response split across two batches
   * simply reports the rest of itself in the second, because what is published is a difference and
   * `usageSent` remembers what the first batch already said.
   */
  flush(): Ev[] {
    if (this.usageId === undefined) return [];
    const delta = subUse(this.usageSeen, this.usageSent);
    if (isZeroUse(delta)) return [];
    this.usageSent = this.usageSeen;
    return [this.usageEvent(delta, this.usageModel, this.usageTs)];
  }

  private usageEvent(use: TokenUse, model: string | undefined, ts: number): Ev {
    return this.stamp({
      kind: 'usage',
      ref: this.ref(),
      inTok: use.in,
      outTok: use.out,
      cacheRead: use.cacheRead,
      cacheWrite: use.cacheWrite,
      ...(model === undefined ? {} : { model }),
      ts,
    });
  }
}
