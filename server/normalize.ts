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

/**
 * `SECRET_MYSQL_P` only runs on text that is talking about MySQL in the first place.
 *
 * The pattern has to be "`-p` then a run of non-space", because that is genuinely the shape —
 * the password is glued to the flag with no separator. Against a shell command line that is a
 * fair trade. Against English it is not: `find . -print`, `git log -p`, `curl -params` are all
 * ordinary things to write, and this redactor stopped being a shell-only concern the moment the
 * human's own `user` lane started going through it. Somebody watching their own sentence come
 * back with `-p***` in it cannot tell whether the app mangled their text or their prompt really
 * said that — and of the two, the app quietly corrupting the one lane that is supposed to be
 * verbatim is much the worse failure.
 *
 * Gating on the word costs nothing where it matters: a `mysql -p…` worth masking is, by
 * construction, inside a command that says `mysql`.
 */
const MYSQL_CONTEXT = /\bmysql\b/i;

/** The token formats that are recognizable on sight, so a leaked one never needs a `key=` beside it. */
const SECRET_TOKEN = /\b(sk-ant-|sk-proj-|sk-|gh[pousr]_|AKIA|xox[abposr]-|npm_)[A-Za-z0-9_-]{16,}/g;

const redact = (s: string): string => {
  const masked = s
    // `lead` is captured and put back: the pattern has to consume the character before the key to
    // prove it is not part of a longer word, and dropping it would silently corrupt the line —
    // `export DB_PASSWORD=x` would come out as `exportDB_PASSWORD=***`.
    .replace(
      SECRET_KV,
      (_m, lead: string, key: string, sep: string, quote: string) => `${lead}${key}${sep}${quote}***${quote}`,
    )
    .replace(SECRET_HEADER, '$1$2 ***')
    .replace(SECRET_TOKEN, '$1***');
  return MYSQL_CONTEXT.test(s) ? masked.replace(SECRET_MYSQL_P, '$1***') : masked;
};

/** Whitespace runs — including newlines — collapsed to single spaces, then trimmed. */
const flatten = (s: string): string => s.replace(/\s+/g, ' ').trim();

const clipTo = (s: string, max: number): string => (s.length > max ? `${s.slice(0, max - 1)}…` : s);

/**
 * User prose reduced to one safe line: whitespace collapsed, credentials replaced, then clipped.
 *
 * The shape every label in this app is made of — a tool's target, a session's opening turn — and
 * exported so `server/sessions.ts` builds its label the same way rather than growing a second
 * redactor that lags this one. A label is rendered on a nameplate or a tab, so the flattening is
 * not cosmetic: the alternative is a tab whose second line is somewhere off the edge of the screen.
 */
export const oneLine = (text: string, max: number): string => clipTo(redact(flatten(text)), max);

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
  [/^\s*<(system-reminder|task-notification)>/, 'reminder'],
  [/^\s*(<user-prompt-submit-hook>|[A-Za-z ]*hook additional context:)/, 'hook'],
  // A skill body is the one piece of machinery on this lane that wears no tag: the CLI injects it
  // as a plain user turn opening `Base directory for this skill: <path>`. Anchored at the start of
  // the line so a human writing *about* a skill's base directory is untouched — the marker is the
  // shape of an injection, not the presence of the words.
  [/^\s*Base directory for this skill:/, 'command'],
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

/**
 * Who wrote a `user` line, from the raw text exactly as the transcript holds it.
 *
 * Exported because `server/sessions.ts` has to ask the same question to find a session's opening
 * human turn, and a second implementation of "is this the human speaking" is the kind of fork this
 * codebase has already paid for once: two readers of the same messages that quietly disagreed, so
 * a line was a verdict to the room and nothing at all to the feed. There is one answer to this
 * question and this is it.
 */
export function classifyUserSource(text: string, compacted = false): UserSource {
  if (compacted || COMPACT_OPENER.test(text)) return 'compaction';
  for (const [re, source] of SOURCE_MARKERS) {
    if (re.test(text)) return source;
  }
  return 'human';
}

/**
 * The tag names the CLI wraps its own text in, and the only ones ever taken off.
 *
 * This is a closed list on purpose. Stripping "any tag" would eat a human's own `<div>` out of a
 * prompt and gut a pasted code block, so the rule is not "markup is not prose" — it is "these nine
 * names are written by the CLI and by nothing else". The first six are the ones `SOURCE_MARKERS`
 * already classifies on; the rest are the wrappers that arrive on the same lane and were being
 * rendered verbatim: a card that read `command-name` in angle brackets where a sentence belonged.
 *
 * What is deliberately left alone is the structure *inside* a payload — a `task-notification`
 * carries `status`, `summary`, `result` and more, and those are a shape this file has not measured
 * a rendering for. Unwrapping the envelope is what stops the markup from being the first thing a
 * person reads.
 */
const WRAPPER_TAGS: readonly string[] = [
  'local-command-caveat',
  'command-name',
  'command-message',
  'command-args',
  'local-command-stdout',
  'local-command-stderr',
  'system-reminder',
  'task-notification',
  'user-prompt-submit-hook',
];

/**
 * A complete wrapper with its payload captured, or a lone tag of the same names with nothing to
 * capture. The second half is not decoration: a `task-notification` opened and never closed is a
 * real shape, and leaving its opening tag on the card would defeat the whole point.
 */
const WRAPPER = new RegExp(
  `<(${WRAPPER_TAGS.join('|')})>([\\s\\S]*?)</\\1>|</?(?:${WRAPPER_TAGS.join('|')})>`,
  'g',
);

/**
 * The CLI's markup taken off, and the payloads left reading as one message.
 *
 * A no-op when the text carries none of those names, so an ordinary prompt is returned byte for
 * byte — not trimmed, not re-spaced, not touched. When there are wrappers, each payload and each
 * run of loose text between them becomes a part, empty parts are dropped, and the parts are joined
 * by a single space. Dropping the empties is what makes `command-args` cost nothing: keeping its
 * surrounding whitespace left the card trailing a blank line, which reads as a message cut off
 * mid-sentence. Joining by a space is what makes the three-tag slash-command echo read as
 * `/effort effort` rather than as three indented fragments; every wrapper that carries more than a
 * field of its own — a stdout dump, a notification — arrives alone, so the join never runs across
 * one of those.
 */
function unwrapMarkup(text: string): string {
  WRAPPER.lastIndex = 0;
  if (!WRAPPER.test(text)) return text;

  const parts: string[] = [];
  const add = (s: string): void => {
    const t = s.trim();
    if (t.length > 0) parts.push(t);
  };

  WRAPPER.lastIndex = 0;
  let at = 0;
  for (let m = WRAPPER.exec(text); m !== null; m = WRAPPER.exec(text)) {
    add(text.slice(at, m.index));
    if (m[2] !== undefined) add(m[2]); // the pair branch; a lone tag captures nothing
    at = m.index + m[0].length;
  }
  add(text.slice(at));
  return parts.join(' ');
}

/**
 * How much of a `user` line crosses the socket.
 *
 * Measured over the transcripts on this machine: the longest human turn is 14 816 characters and
 * the 99th percentile is 8 899, so this cap has never clipped a word anybody typed here. What it
 * bounds is the rest of the lane and the pathological case — a `task-notification` carrying a whole
 * subagent report runs to 16 238, a compaction summary to about 14 500, and a pasted prompt has no
 * upper limit at all short of the tailer's own 1 MiB line cap.
 */
const USER_TEXT_MAX = 16_384;

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

/**
 * How many lines a string of file content is.
 *
 * A trailing newline terminates the last line rather than opening another — `a\nb\n` is two lines
 * in every editor and every diff, and a naive `split('\n').length` says three. CRLF needs nothing
 * special: the `\r` rides along inside its line, so a Windows file counts the same as a Unix one.
 * An empty string is zero lines, which is the honest answer for a `Write` that empties a file.
 */
const lineCount = (s: string): number => {
  if (s.length === 0) return 0;
  const n = s.split('\n').length;
  return s.endsWith('\n') ? n - 1 : n;
};

/**
 * How big an edit was, as far as the call itself says.
 *
 * `Edit` carries both sides, so both are knowable. `Write` carries only the new content: what it
 * removed depends on what was on disk, which is not in the transcript — so `removed` is left off
 * rather than reported as 0, because `+40 −0` for a rewrite that replaced a thousand lines is a
 * confident lie where absence is merely silence. `NotebookEdit` (and any vintage that shapes the
 * input differently) carries neither, and gets neither.
 *
 * The known imprecision is `replace_all`: `old_string` is counted once, so an edit that replaced
 * five occurrences reports a fifth of what it removed. Counting the occurrences would need the
 * file, which the observer does not read.
 */
function editSize(input: Readonly<Record<string, unknown>>): { added?: number; removed?: number } {
  const out: { added?: number; removed?: number } = {};
  if (typeof input.old_string === 'string') out.removed = lineCount(input.old_string);
  const newText = typeof input.new_string === 'string' ? input.new_string : input.content;
  if (typeof newText === 'string') out.added = lineCount(newText);
  return out;
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

  /**
   * One `user` line as a person should see it.
   *
   * Classified from the **raw** text and only then unwrapped, which is the ordering the whole lane
   * depends on: `SOURCE_MARKERS` anchors at the start of the string, and `<command-name>/effort` …
   * unwraps to `/effort`, which classifies as `human`. Unwrapping first would therefore relabel
   * every slash-command echo as the human speaking — putting machine text back in their mouth,
   * which is the one thing `source` exists to prevent.
   *
   * Nothing is returned for a line that was only markup: a wrapper with an empty payload is not a
   * message, and an empty card is worse than no card. A line that was genuinely empty to begin
   * with still reports, because that is a fact about the transcript rather than about this filter.
   */
  private userMessage(raw: string, compacted: boolean, ts: number): DistributiveOmit<Ev, 'seq'> | undefined {
    const source = classifyUserSource(raw, compacted);
    const text = clipTo(redact(unwrapMarkup(raw)), USER_TEXT_MAX);
    if (text.length === 0 && raw.length > 0) return undefined;
    return { kind: 'userMessage', ref: this.ref(), text, source, ts };
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
      const msg = this.userMessage(content, compacted, ts);
      if (msg) push(msg);
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
          const msg = this.userMessage(b.text, compacted, ts);
          if (msg) push(msg);
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
            // `toolUseId` is the same `b.id` the `toolStart` above carries: it is what lets the
            // client fold the line counts onto the exact call that made this edit instead of
            // inferring it from emit order.
            push({
              kind: 'fileEdit',
              ref: this.ref(),
              path: input.file_path,
              toolUseId: b.id,
              ...editSize(input),
              ts,
            });
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
