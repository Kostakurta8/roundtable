import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Ev } from '../shared/events';
import { Normalizer } from '../server/normalize';
import { parseLine } from '../server/parse';
import {
  agentLook,
  initialState,
  MSG_CAP,
  OPEN_TOOL_GRACE_MS,
  reduce,
  workingAgents,
  WORKING_WINDOW_MS,
  type RtState,
} from '../src/store';

/** Same helper the Normalizer tests use: a whole fixture file → the events it produces. */
const feedAll = (file: string, agentId: 'main' | string): Ev[] => {
  const n = new Normalizer('fix-sess', agentId);
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .flatMap((l) => {
      const r = parseLine(l);
      return r ? n.feed(r) : [];
    });
};

const MAIN_FIXTURE = join('fixtures', 'main-session.jsonl');
const SUB_FIXTURE = join('fixtures', 'agent-abc123.jsonl');

const fold = (evs: Ev[], from: RtState = initialState): RtState => evs.reduce(reduce, from);

// --- hand-built events, for the rules the fixtures do not exercise ------------
const ref = (agentId: string) => ({ sessionId: 's', agentId });
let SEQ = 0;
const next = () => ++SEQ;
const text = (agentId: string, t: string, ts = 1000): Ev => ({
  kind: 'agentText', ref: ref(agentId), text: t, ts, seq: next(),
});
const thinking = (agentId: string, t: string, ts = 1000): Ev => ({
  kind: 'thinking', ref: ref(agentId), text: t, ts, seq: next(),
});
const toolStart = (agentId: string, tool: string, target?: string, ts = 1000): Ev => ({
  kind: 'toolStart', ref: ref(agentId), tool, target, toolUseId: `tu${SEQ}`, ts, seq: next(),
});
const fileEdit = (agentId: string, path: string, ts = 1000): Ev => ({
  kind: 'fileEdit', ref: ref(agentId), path, ts, seq: next(),
});
const agentSeen = (agentId: string, model?: string, ts = 1000): Ev => ({
  kind: 'agentSeen', ref: ref(agentId), model, ts, seq: next(),
});
const userMessage = (agentId: string, t: string, ts = 1000): Ev => ({
  kind: 'userMessage', ref: ref(agentId), text: t, ts, seq: next(),
});
const usage = (agentId: string, inTok: number, outTok: number, ts = 1000): Ev => ({
  kind: 'usage', ref: ref(agentId), inTok, outTok, ts, seq: next(),
});

describe('reduce — fixture stream', () => {
  it('folds the main fixture into a chat feed', () => {
    const st = fold(feedAll(MAIN_FIXTURE, 'main'));

    // exactly one human turn
    const userMsgs = st.msgs.filter((m) => m.agentId === 'user');
    expect(userMsgs).toHaveLength(1);
    expect(userMsgs[0].text).toBe('find the flaky test');

    // the agent's reply carries the thinking block that preceded it
    const withThinking = st.msgs.filter((m) => m.agentId === 'main' && m.thinking);
    expect(withThinking.length).toBeGreaterThanOrEqual(1);
    expect(withThinking[0].thinking).toContain('scheduler.spec mixes timers');
    expect(withThinking[0].text).toBe('Plan: scout then verify.');

    // the Grep tool_use became a chip on that message
    expect(st.msgs.flatMap((m) => m.tools.map((t) => t.label))).toContain('Grep retryWithBackoff');

    // usage accumulated
    expect(st.totalTok).toBeGreaterThan(0);
    expect(st.totalTok).toBe(198); // 10+120 then 8+60
    expect(st.agents.main.tokens).toBe(198);
    expect(st.agents.main.model).toBe('claude-fable-5');
  });

  it('renders a spawn as its own system line', () => {
    const st = fold(feedAll(MAIN_FIXTURE, 'main'));
    const sys = st.msgs.filter((m) => m.agentId === 'system');
    expect(sys).toHaveLength(1);
    expect(sys[0].text).toContain('scout suites');
  });

  it('keeps msgs in ts order when file batches replay out of chronological order', () => {
    // The hub replays a backlog per file, so a subagent batch can arrive before older
    // main-transcript events; the feed must still read chronologically.
    const st = fold([...feedAll(SUB_FIXTURE, 'abc123'), ...feedAll(MAIN_FIXTURE, 'main')]);
    const tss = st.msgs.map((m) => m.ts);
    expect([...tss].sort((a, b) => a - b)).toEqual(tss);
    expect(st.msgs[0].text).toBe('find the flaky test'); // earliest event, replayed last
    expect(st.msgs.at(-1)?.agentId).toBe('abc123');
  });
});

describe('reduce — rules', () => {
  it('keeps arrival order for equal timestamps (stable sort)', () => {
    const st = fold([text('a', 'first', 500), text('b', 'second', 500), text('c', 'third', 500)]);
    expect(st.msgs.map((m) => m.text)).toEqual(['first', 'second', 'third']);
    expect(st.msgs.map((m) => m.id)).toEqual([1, 2, 3]);
  });

  it('attaches a thinking block to one message only', () => {
    const st = fold([thinking('a', 'weighing options'), text('a', 'one'), text('a', 'two')]);
    expect(st.msgs[0].thinking).toBe('weighing options');
    expect(st.msgs[1].thinking).toBeUndefined();
  });

  it('never lends one agent thinking to another', () => {
    const st = fold([thinking('a', 'mine'), text('b', 'not mine'), text('a', 'mine indeed')]);
    expect(st.msgs.find((m) => m.agentId === 'b')?.thinking).toBeUndefined();
    expect(st.msgs.find((m) => m.agentId === 'a')?.thinking).toBe('mine');
  });

  it('chips land on the current message, and wait for the next one when there is none', () => {
    const st = fold([
      toolStart('a', 'Grep', 'retryWithBackoff'), // no message open yet → buffered
      text('a', 'found it'),
      toolStart('a', 'Bash', 'npm test'), // message already open → appended
      text('b', 'unrelated'),
    ]);
    const a = st.msgs.find((m) => m.agentId === 'a');
    expect(a?.tools.map((t) => t.label)).toEqual(['Grep retryWithBackoff', 'Bash npm test']);
    expect(st.msgs.find((m) => m.agentId === 'b')?.tools).toEqual([]);
    expect(st.agents.a.status).toContain('Bash');
  });

  it('repeats a genuinely repeated tool call — chips are a log, not a set', () => {
    const st = fold([text('a', 'rerunning'), toolStart('a', 'Bash', 'npm test'), toolStart('a', 'Bash', 'npm test')]);
    expect(st.msgs[0].tools.map((t) => t.label)).toEqual(['Bash npm test', 'Bash npm test']);
  });

  // A file-editing tool_use makes the normalizer emit BOTH toolStart and fileEdit, so the store
  // is fed the same action twice and must still show it once. Driven through the real Normalizer
  // rather than hand-built events, so the coupling stays honest if the normalizer ever changes.
  const editLine = (tool: string, path: string): Ev[] =>
    new Normalizer('s', 'main').feed({
      type: 'assistant',
      timestamp: '2026-08-02T10:00:00.000Z',
      message: {
        role: 'assistant',
        model: 'm',
        content: [
          { type: 'text', text: 'patching it' },
          { type: 'tool_use', id: 'tu1', name: tool, input: { file_path: path } },
        ],
      },
    });

  it('shows one chip per file edit, not one per event', () => {
    const evs = editLine('Edit', 'src/retry.ts');
    // guard: the double emission this test exists for is really there
    expect(evs.filter((e) => e.kind === 'toolStart' || e.kind === 'fileEdit')).toHaveLength(2);

    expect(fold(evs).msgs[0].tools.map((t) => t.label)).toEqual(['Edit src/retry.ts']);
  });

  it('keeps the precise tool name when a Write reports a file edit', () => {
    // Write emits toolStart 'Write <path>' and fileEdit 'Edit <path>' — two different labels for
    // one action, so equal-label dedup would not have been enough.
    expect(fold(editLine('Write', 'src/new.ts')).msgs[0].tools.map((t) => t.label)).toEqual(['Write src/new.ts']);
  });

  it('still reports a file edit in the agent status', () => {
    const st = fold([text('a', 'writing'), fileEdit('a', 'src/x.ts')]);
    expect(st.msgs[0].tools).toEqual([]); // the chip is the tool call's, not this event's
    expect(st.agents.a.status).toBe('Edit src/x.ts');
  });

  it('reads verdicts out of the text, REFUTED winning a tie', () => {
    const st = fold([
      text('a', '✓ CONFIRMED — 50/50 green', 1),
      text('b', '✕ REFUTED — still 6 red', 2),
      text('c', 'CONFIRMED by a, then REFUTED by b', 3),
      text('d', 'confirmed the fix by hand', 4), // prose, not a verdict marker
    ]);
    expect(st.msgs.map((m) => m.verdict)).toEqual(['ok', 'err', 'err', undefined]);
  });

  it('never marks the human turn with a verdict', () => {
    const st = fold([userMessage('main', 'their claim was REFUTED, check it')]);
    expect(st.msgs[0].agentId).toBe('user');
    expect(st.msgs[0].verdict).toBeUndefined();
  });

  it('files a subagent prompt as a system line, not as words the human said', () => {
    // A user turn inside a subagent transcript is the prompt its parent handed down.
    const st = fold([userMessage('main', 'find the bug'), userMessage('abc123', 'scout the suites')]);
    expect(st.msgs.map((m) => m.agentId)).toEqual(['user', 'system']);
    expect(st.msgs[1].text).toContain('scout the suites');
    expect(st.msgs[1].text).toContain('abc123');
  });

  it('merges a later agentSeen instead of duplicating the agent', () => {
    const st = fold([agentSeen('a'), text('a', 'hi'), agentSeen('a', 'claude-fable-5')]);
    expect(Object.keys(st.agents)).toEqual(['a']);
    expect(st.agents.a.model).toBe('claude-fable-5');
  });

  it('accumulates tokens per agent and in total', () => {
    const st = fold([usage('a', 10, 20), usage('b', 1, 2), usage('a', 5, 0)]);
    expect(st.agents.a.tokens).toBe(35);
    expect(st.agents.b.tokens).toBe(3);
    expect(st.totalTok).toBe(38);
  });

  /**
   * An event this build does not know must change nothing the UI draws. It does still advance the
   * sequence high-water mark and the session clock — that is bookkeeping about the stream, not
   * about its content, and a reducer that skipped it would re-fold the unknown event on every
   * replay for the rest of the session.
   */
  it('leaves everything it draws untouched for an unknown event kind', () => {
    const st = fold([text('a', 'hi')]);
    const unknown = { kind: 'quantumFlux', ref: ref('a'), ts: 1, seq: 99 } as unknown as Ev;
    const after = reduce(st, unknown);

    expect(after.msgs).toBe(st.msgs);
    expect(after.agents).toBe(st.agents);
    expect(after.tools).toBe(st.tools);
    expect(after.totalTok).toBe(st.totalTok);
    expect(after.trimmed).toBe(st.trimmed);
    expect(after.lastSeq).toBe(99);
  });

  it('ignores an event it has already folded, so a replayed backlog cannot double count', () => {
    const evs = [usage('a', 10, 5)];
    const once = fold(evs);
    const twice = evs.reduce(reduce, once); // the hub replaying the same frames
    expect(twice.totalTok).toBe(once.totalTok);
    expect(twice.agents.a.tokens).toBe(once.agents.a.tokens);
    expect(twice.msgs.length).toBe(once.msgs.length);
  });

  it('mutates nothing it was handed', () => {
    const evs = feedAll(MAIN_FIXTURE, 'main');
    const before = structuredClone(initialState);
    let st = initialState;
    for (const e of evs) {
      const snapshot = structuredClone(st);
      const next = reduce(st, e);
      expect(st).toEqual(snapshot); // the input state is never written to
      st = next;
    }
    expect(initialState).toEqual(before);
    expect(initialState.msgs).toHaveLength(0);
  });
});

/**
 * A red chip used to be the end of the trail: the store counted the failure, the panel coloured
 * it, and nothing anywhere carried what the tool had actually said. The text has to reach the same
 * three places the call itself does — the message card it hangs on, the live strip, and the
 * pending list — because a result can arrive long after any of them was written.
 */
describe('reduce — a failure carries its reason', () => {
  const start = (agentId: string, tool: string, target: string, id: string, ts = 1000): Ev => ({
    kind: 'toolStart', ref: ref(agentId), tool, target, toolUseId: id, ts, seq: next(),
  });
  const result = (agentId: string, id: string, ok: boolean, error?: string, ts = 1200): Ev => ({
    kind: 'toolResult', ref: ref(agentId), toolUseId: id, ok, ...(error === undefined ? {} : { error }), ts, seq: next(),
  });
  const WHY = 'Exit code 127\n/usr/bin/bash: line 1: php: command not found';

  it('puts the reason on the chip, wherever that chip ended up', () => {
    const st = fold([
      text('a', 'running the importer'),
      start('a', 'Bash', 'php import.php', 'tu_e'),
      result('a', 'tu_e', false, WHY),
    ]);
    const onCard = st.msgs[0].tools[0];
    expect(onCard).toMatchObject({ ok: false, error: WHY, ms: 200 });
    // The live strip holds the same resolved call, not a stale copy of the one that was running.
    expect(st.tools.at(-1)).toMatchObject({ ok: false, error: WHY });
    expect(st.agents.a.errors).toBe(1);
  });

  it('reaches a call the agent had not spoken for yet', () => {
    // A turn that opens with a tool call has no card, so the call waits in `pending.tools` — and
    // its result can land before the agent ever says anything. The held copy has to be rewritten
    // too, or the chip appears without its reason once the agent finally speaks.
    const st = fold([start('a', 'Read', '/gone.ts', 'tu_p'), result('a', 'tu_p', false, 'File does not exist.')]);
    expect(st.tools.at(-1)).toMatchObject({ error: 'File does not exist.' });
    expect(st.pending.tools.a?.[0]).toMatchObject({ error: 'File does not exist.' });

    const spoken = fold([text('a', 'that file is gone')], st);
    expect(spoken.msgs.at(-1)?.tools[0]).toMatchObject({ ok: false, error: 'File does not exist.' });
  });

  it('says nothing about a call that worked', () => {
    const st = fold([text('a', 'listing'), start('a', 'Glob', '**/*.ts', 'tu_ok'), result('a', 'tu_ok', true)]);
    expect(st.msgs[0].tools[0]).toMatchObject({ ok: true });
    expect(st.msgs[0].tools[0].error).toBeUndefined();
  });

  it('still records a failure whose result carried no text', () => {
    // The field is optional on the wire, so `ok: false` with no reason is a state the panel has to
    // be able to draw — it must not read as a success.
    const st = fold([text('a', 'fetching'), start('a', 'WebFetch', 'https://x.test', 'tu_q'), result('a', 'tu_q', false)]);
    expect(st.msgs[0].tools[0]).toMatchObject({ ok: false });
    expect(st.msgs[0].tools[0].error).toBeUndefined();
    expect(st.agents.a.errors).toBe(1);
  });

  it('reads the reason end to end, from a real transcript line', () => {
    // Through the Normalizer rather than a hand-built event, so the two halves cannot drift.
    const n = new Normalizer('s', 'main');
    const evs = [
      ...n.feed({
        type: 'assistant',
        timestamp: '2026-08-03T09:00:00.000Z',
        message: {
          role: 'assistant',
          model: 'm',
          content: [
            { type: 'text', text: 'checking the file' },
            { type: 'tool_use', id: 'tu_x', name: 'Edit', input: { file_path: 'notes.md', old_string: 'a', new_string: 'b' } },
          ],
        },
      }),
      ...n.feed({
        type: 'user',
        timestamp: '2026-08-03T09:00:01.000Z',
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'tu_x',
              is_error: true,
              content: '<tool_use_error>String to replace not found in file.</tool_use_error>',
            },
          ],
        },
      }),
    ];
    const chip = fold(evs).msgs.flatMap((m) => m.tools).find((t) => t.id === 'tu_x');
    expect(chip).toMatchObject({ tool: 'Edit', target: 'notes.md', ok: false, error: 'String to replace not found in file.' });
  });
});

describe('reduce — feed cap', () => {
  // A long session streams far more turns than anyone scrolls back through, and every one of
  // them is an array entry re-rendered and a DOM node held alive. The feed is capped; what falls
  // off the top is counted rather than hidden.
  it('keeps the newest MSG_CAP messages and counts what it dropped', () => {
    const over = 40;
    const st = fold([...Array(MSG_CAP + over).keys()].map((i) => text('a', `line ${i}`, 1000 + i)));

    expect(st.msgs).toHaveLength(MSG_CAP);
    expect(st.trimmed).toBe(over);
    expect(st.msgs.at(-1)?.text).toBe(`line ${MSG_CAP + over - 1}`); // the newest arrival is kept
    expect(st.msgs[0].text).toBe(`line ${over}`); // …and the oldest survivor is the one after the cut
    expect(st.msgs.some((m) => m.text === `line ${over - 1}`)).toBe(false);
  });

  it('trims without disturbing ts order or renumbering ids', () => {
    const st = fold([...Array(MSG_CAP + 5).keys()].map((i) => text('a', `line ${i}`, 1000 + i)));

    const tss = st.msgs.map((m) => m.ts);
    expect([...tss].sort((a, b) => a - b)).toEqual(tss);
    expect(st.msgs[0].id).toBe(6); // ids are handed out from 1 and never reused
    expect(st.msgs.at(-1)?.id).toBe(MSG_CAP + 5);
  });

  it('leaves a feed under the cap completely alone', () => {
    const st = fold([...Array(MSG_CAP).keys()].map((i) => text('a', `line ${i}`, 1000 + i)));
    expect(st.msgs).toHaveLength(MSG_CAP);
    expect(st.trimmed).toBe(0);
    expect(st.msgs[0].text).toBe('line 0');
  });
});

/**
 * Pricing. The store used to hold one model per agent and price that agent's whole total with it,
 * which is wrong by the ratio between two rate cards the moment a session switches models — 9% of
 * real transcripts do, from a `/model` switch or an overload fallback, and between Opus and Haiku
 * that ratio is fifteen.
 */
const usageOf = (agentId: string, u: Partial<{ inTok: number; outTok: number; cacheRead: number; cacheWrite: number; model: string }>, ts = 1000): Ev => ({
  kind: 'usage',
  ref: ref(agentId),
  inTok: u.inTok ?? 0,
  outTok: u.outTok ?? 0,
  cacheRead: u.cacheRead ?? 0,
  cacheWrite: u.cacheWrite ?? 0,
  ...(u.model ? { model: u.model } : {}),
  ts,
  seq: next(),
});

describe('reduce — pricing across models', () => {
  it('bills each model for its own tokens', () => {
    const st = fold([
      agentSeen('a', 'claude-opus-5'),
      usageOf('a', { outTok: 1_000_000, model: 'claude-opus-5' }),
      // The same agent, after a /model switch. Priced at Opus this would read $75.
      usageOf('a', { outTok: 1_000_000, model: 'claude-haiku-4-5' }),
    ]);
    expect(st.cost).toBeCloseTo(75 + 5, 6);
    expect(st.costPartial).toBe(false);
  });

  it('keeps the tokens whole even though the dollars are split', () => {
    const st = fold([
      usageOf('a', { inTok: 10, outTok: 20, cacheRead: 30, cacheWrite: 40, model: 'claude-opus-5' }),
      usageOf('a', { inTok: 1, outTok: 2, cacheRead: 3, cacheWrite: 4, model: 'claude-sonnet-5' }),
    ]);
    expect(st.agents['a'].tokens).toBe(110);
    expect(st.totalTok).toBe(110);
  });

  it('marks the estimate a floor when one of an agent\'s models has no rate card', () => {
    const st = fold([
      usageOf('a', { outTok: 1_000_000, model: 'claude-opus-5' }),
      usageOf('a', { outTok: 1_000_000, model: 'some-model-from-the-future' }),
    ]);
    expect(st.cost).toBeCloseTo(75, 6); // the part that can be priced is still priced
    expect(st.costPartial).toBe(true); // and the HUD is told it is only part
  });

  /**
   * `<synthetic>` is not a model — it is the CLI's marker on lines it wrote itself, and every one
   * of them carries a usage object of four zeros. Left uncarded it latched as the agent's model,
   * priced the agent at nothing, and flipped the whole HUD into `≥` floor mode over tokens that
   * do not exist.
   */
  it('does not turn the estimate into a floor over a synthetic line', () => {
    const st = fold([
      usageOf('a', { outTok: 1_000_000, model: 'claude-opus-5' }),
      usageOf('a', { inTok: 0, outTok: 0, model: '<synthetic>' }),
    ]);
    expect(st.cost).toBeCloseTo(75, 6);
    expect(st.costPartial).toBe(false);
  });

  it('hands tokens counted before the model was known to the model that arrives', () => {
    // An opening turn names no model, so its usage has nowhere to go until one does.
    const st = fold([usageOf('a', { outTok: 1_000_000 }), agentSeen('a', 'claude-opus-5')]);
    expect(st.cost).toBeCloseTo(75, 6);
    expect(st.costPartial).toBe(false);
  });
});

describe('reduce — compaction summaries', () => {
  const summary = (t: string, ts = 1000): Ev => ({
    kind: 'userMessage', ref: ref('main'), text: t, source: 'compaction', ts, seq: next(),
  });

  it('never lets the CLI\'s own summary become the session task', () => {
    const st = fold([
      summary('This session is being continued from a previous conversation that ran out of context.'),
      userMessage('main', 'now make the tabs work', 2000),
    ]);
    expect(st.task).toBe('now make the tabs work');
  });

  it('keeps the summary in the feed, labelled, rather than hiding it', () => {
    const st = fold([summary('This session is being continued from a previous conversation.')]);
    const msg = st.msgs.find((m) => m.agentId === 'user');
    expect(msg?.source).toBe('compaction');
  });

  it('never lets harness machinery on the user lane become the session task', () => {
    // End to end on purpose — the raw line through the real Normalizer, its events through the
    // real fold — so this dies if either half regresses: the classifier calling the block human,
    // or the latch accepting a non-human source. A hand-built event with `source: 'reminder'`
    // already baked in would only ever test the second half.
    const n = new Normalizer('s', 'main');
    const raw = parseLine(
      JSON.stringify({
        type: 'user',
        timestamp: '2026-08-03T09:00:00.000Z',
        message: {
          role: 'user',
          content: '<task-notification>\n<task-id>abc</task-id>\nBackground task finished.\n</task-notification>',
        },
      }),
    );
    expect(raw).not.toBeNull();
    const st = fold([...n.feed(raw!), userMessage('main', 'now make the tabs work', 2000)]);
    expect(st.task).toBe('now make the tabs work');
    expect(st.msgs.find((m) => m.agentId === 'user' && m.text.startsWith('<task-notification>'))?.source).toBe(
      'reminder',
    );
  });
});

/**
 * "Has agents working" is the whole of the tab strip's reason to exist, so it is worth testing
 * what it refuses as much as what it accepts. The failure that matters is a false positive: a tab
 * strip that appears over two idle terminals is worse than no tab strip.
 */
describe('workingAgents', () => {
  const NOW = 1_000_000;
  const at = (agentId: string, ts: number): Ev[] => [
    { kind: 'agentSeen', ref: ref(agentId), ts, seq: next() },
    { kind: 'agentText', ref: ref(agentId), text: 'working on it', ts, seq: next() },
  ];

  it('does not count main — a session at an idle prompt has one and is doing nothing', () => {
    const st = fold(at('main', NOW));
    expect(workingAgents(st, NOW)).toHaveLength(0);
  });

  it('counts a subagent that has just done something', () => {
    const st = fold(at('abc123', NOW - 1000));
    expect(workingAgents(st, NOW).map((a) => a.id)).toEqual(['abc123']);
  });

  it('stops counting a subagent that has gone quiet', () => {
    const st = fold(at('abc123', NOW - WORKING_WINDOW_MS - 1));
    expect(workingAgents(st, NOW)).toHaveLength(0);
  });

  it('keeps counting a subagent that is silent because it is inside a long tool call', () => {
    // A Bash that compiles a project writes nothing while it runs. The 90-second window alone
    // would call this agent finished while it is doing the most work of the session.
    const quiet = NOW - WORKING_WINDOW_MS * 3;
    const st = fold([
      ...at('abc123', quiet),
      { kind: 'toolStart', ref: ref('abc123'), tool: 'Bash', toolUseId: 'tu1', ts: quiet, seq: next() },
    ]);
    expect(workingAgents(st, NOW).map((a) => a.id)).toEqual(['abc123']);
  });

  it('gives up on an open tool call eventually, rather than never', () => {
    // An unresolved call is not always real: a `tool_result` carried on a line over 1 MiB is
    // dropped unparsed, and an infinite grace would keep a dead session's tab on screen for ever.
    const ancient = NOW - OPEN_TOOL_GRACE_MS - 1;
    const st = fold([
      ...at('abc123', ancient),
      { kind: 'toolStart', ref: ref('abc123'), tool: 'Bash', toolUseId: 'tu1', ts: ancient, seq: next() },
    ]);
    expect(workingAgents(st, NOW)).toHaveLength(0);
  });

  it('does not count an agent that has finished', () => {
    const st = fold([
      ...at('abc123', NOW - 1000),
      { kind: 'agentDone', ref: ref('abc123'), ok: true, ts: NOW - 500, seq: next() },
    ]);
    expect(workingAgents(st, NOW)).toHaveLength(0);
  });

  it('reads a session that has only ever announced itself as nobody working', () => {
    // `sessionSeen` arrives for a session that is running and has written nothing. It must name
    // the session without claiming anything is happening in it.
    const st = fold([{ kind: 'sessionSeen', sessionId: 's', cwd: 'C:\\work', live: true, ts: NOW, seq: next() }]);
    expect(st.sessionId).toBe('s');
    expect(st.cwd).toBe('C:\\work');
    expect(workingAgents(st, NOW)).toHaveLength(0);
  });
});

describe('reduce — the spawn tree joins from either side', () => {
  const spawn = (parent: string, toolUseId: string, ts = 1000): Ev => ({
    kind: 'agentSpawn', ref: ref(parent), childAgentId: 'pending', prompt: 'go and look', toolUseId, ts, seq: next(),
  });
  const seenWithParent = (agentId: string, parentToolUseId: string, ts = 1000): Ev => ({
    kind: 'agentSeen', ref: ref(agentId), parentToolUseId, ts, seq: next(),
  });

  it('links the child when the spawn line is folded first', () => {
    const st = fold([spawn('main', 'tu9'), seenWithParent('kid', 'tu9')]);
    expect(st.agents['kid'].parentId).toBe('main');
  });

  it('links the child when the sidecar is folded first', () => {
    // Not a contrived order: the hub reads sidecars on their own 500ms timer, independent of the
    // main transcript's pump, so the child can genuinely introduce itself before the `Task` call
    // that made it. Handled on one side only, the edge was lost for good — the subagent rendered
    // as a root of the tree instead of under its parent.
    const st = fold([seenWithParent('kid', 'tu9'), spawn('main', 'tu9')]);
    expect(st.agents['kid'].parentId).toBe('main');
  });

  it('does not hand a child to the wrong parent', () => {
    const st = fold([seenWithParent('kid', 'tu9'), spawn('other', 'tuX'), spawn('main', 'tu9')]);
    expect(st.agents['kid'].parentId).toBe('main');
  });
});

describe('reduce — a finished agent stops waiting on its tools', () => {
  it('settles calls that will never report back, and says why', () => {
    const st = fold([
      text('abc', 'starting'),
      toolStart('abc', 'Bash', 'npm test'),
      { kind: 'agentDone', ref: ref('abc'), ok: true, ts: 2000, seq: next() },
    ]);
    // Zeroing `activeTools` alone left the tools panel counting this as RUNNING and its chip
    // spinning for the rest of the session — the app waiting on something that cannot arrive.
    const call = st.tools.find((t) => t.tool === 'Bash');
    expect(call?.ok).toBe(false);
    expect(call?.error).toContain('finished before');
    expect(Object.keys(st.pending.open)).toHaveLength(0);
    expect(st.agents['abc'].activeTools).toBe(0);
  });

  it('leaves the other agents\' calls alone', () => {
    const st = fold([
      text('abc', 'a'), toolStart('abc', 'Bash', 'x'),
      text('def', 'b'), toolStart('def', 'Read', 'y'),
      { kind: 'agentDone', ref: ref('abc'), ok: true, ts: 2000, seq: next() },
    ]);
    expect(st.tools.find((t) => t.tool === 'Read')?.ok).toBeUndefined();
  });
});

describe('agentLook', () => {
  it('is stable per id and keeps main on its own tint', () => {
    expect(agentLook('abc123')).toEqual(agentLook('abc123'));
    expect(agentLook('main').tint).not.toBe(agentLook('abc123').tint);
    expect(agentLook('zz9').tint).toMatch(/^#[0-9A-Fa-f]{6}$/);
  });
});
