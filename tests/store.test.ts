import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Ev } from '../shared/events';
import { Normalizer } from '../server/normalize';
import { parseLine } from '../server/parse';
import { agentLook, initialState, reduce, type RtState } from '../src/store';

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
    expect(st.msgs.flatMap((m) => m.chips)).toContain('Grep retryWithBackoff');

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
    expect(a?.chips).toEqual(['Grep retryWithBackoff', 'Bash npm test']);
    expect(st.msgs.find((m) => m.agentId === 'b')?.chips).toEqual([]);
    expect(st.agents.a.status).toContain('Bash');
  });

  it('repeats a genuinely repeated tool call — chips are a log, not a set', () => {
    const st = fold([text('a', 'rerunning'), toolStart('a', 'Bash', 'npm test'), toolStart('a', 'Bash', 'npm test')]);
    expect(st.msgs[0].chips).toEqual(['Bash npm test', 'Bash npm test']);
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

    expect(fold(evs).msgs[0].chips).toEqual(['Edit src/retry.ts']);
  });

  it('keeps the precise tool name when a Write reports a file edit', () => {
    // Write emits toolStart 'Write <path>' and fileEdit 'Edit <path>' — two different labels for
    // one action, so equal-label dedup would not have been enough.
    expect(fold(editLine('Write', 'src/new.ts')).msgs[0].chips).toEqual(['Write src/new.ts']);
  });

  it('still reports a file edit in the agent status', () => {
    const st = fold([text('a', 'writing'), fileEdit('a', 'src/x.ts')]);
    expect(st.msgs[0].chips).toEqual([]); // the chip is the tool call's, not this event's
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

  it('returns the same state object for an unknown event kind', () => {
    const st = fold([text('a', 'hi')]);
    const unknown = { kind: 'quantumFlux', ref: ref('a'), ts: 1, seq: 99 } as unknown as Ev;
    expect(reduce(st, unknown)).toBe(st);
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

describe('agentLook', () => {
  it('is stable per id and keeps main on its own tint', () => {
    expect(agentLook('abc123')).toEqual(agentLook('abc123'));
    expect(agentLook('main').tint).not.toBe(agentLook('abc123').tint);
    expect(agentLook('zz9').tint).toMatch(/^#[0-9A-Fa-f]{6}$/);
  });
});
