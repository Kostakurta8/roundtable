import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { collectStats, formatStats, readTranscript } from '../server/stats';

/** One assistant line, written the way a transcript writes it. */
const assistant = (id: string, usage: Record<string, number>, content: unknown[] = [], stamp = '2026-09-18T10:00:00.000Z') =>
  JSON.stringify({ type: 'assistant', timestamp: stamp, uuid: `u-${id}-${Math.random()}`, message: { id, usage, content } });

const hookLine = (name: string, type: string, toolUseID: string) =>
  JSON.stringify({ type: 'attachment', uuid: `h-${Math.random()}`, attachment: { type, hookName: name, hookEvent: 'PostToolUse', toolUseID } });

function stageRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'rt-stats-'));
  const slug = join(root, 'projects', 'demo');
  const session = join(slug, 'sess-1');
  mkdirSync(join(session, 'subagents', 'workflows', 'wf_1'), { recursive: true });

  // Parent: one response written as three lines repeating the same complete usage object, plus
  // one hook firing written as the two records it really is.
  writeFileSync(
    join(slug, 'sess-1.jsonl'),
    [
      assistant('msg_parent', { output_tokens: 300, cache_read_input_tokens: 9_000 }, [{ type: 'thinking' }], '2026-09-18T10:00:00.000Z'),
      assistant('msg_parent', { output_tokens: 300, cache_read_input_tokens: 9_000 }, [{ type: 'tool_use' }], '2026-09-18T10:00:05.000Z'),
      assistant('msg_parent', { output_tokens: 300, cache_read_input_tokens: 9_000 }, [{ type: 'text' }], '2026-09-18T10:00:09.000Z'),
      hookLine('PostToolUse:Edit', 'hook_success', 'toolu_1'),
      hookLine('PostToolUse:Edit', 'hook_additional_context', 'toolu_1'),
    ].join('\n') + '\n',
  );

  // A task child that worked: two distinct responses, a cold start on the first.
  writeFileSync(
    join(session, 'subagents', 'agent-aaa.jsonl'),
    [
      assistant('msg_c1', { output_tokens: 500, cache_creation_input_tokens: 40_000 }, [{ type: 'tool_use' }], '2026-09-18T10:00:00.000Z'),
      assistant('msg_c2', { output_tokens: 700, cache_creation_input_tokens: 10 }, [{ type: 'tool_use' }, { type: 'tool_use' }], '2026-09-18T10:10:00.000Z'),
    ].join('\n') + '\n',
  );

  // A workflow child that produced nothing at all — the silent class.
  writeFileSync(
    join(session, 'subagents', 'workflows', 'wf_1', 'agent-bbb.jsonl'),
    [
      JSON.stringify({ type: 'user', timestamp: '2026-09-18T10:00:00.000Z', message: { content: 'go' } }),
      JSON.stringify({ type: 'user', timestamp: '2026-09-18T13:00:00.000Z', message: { content: 'still nothing' } }),
    ].join('\n') + '\n',
  );

  // The workflow's own journal, which is not an agent and must not be counted as one.
  writeFileSync(
    join(session, 'subagents', 'workflows', 'wf_1', 'journal.jsonl'),
    [JSON.stringify({ type: 'launched' }), JSON.stringify({ type: 'result' })].join('\n') + '\n',
  );
  return root;
}

describe('readTranscript', () => {
  it('deduplicates usage on message.id and keeps the per-line sum for comparison', () => {
    const root = stageRoot();
    const s = readTranscript(join(root, 'projects', 'demo', 'sess-1.jsonl'));
    expect(s.responses).toBe(1);
    expect(s.usageLines).toBe(3);
    expect(s.output).toBe(300); // not 900
    expect(s.outputPerLine).toBe(900);
    expect(s.seconds).toBe(9);
  });

  it('reports the first response cache creation as the cold start', () => {
    const root = stageRoot();
    const s = readTranscript(join(root, 'projects', 'demo', 'sess-1', 'subagents', 'agent-aaa.jsonl'));
    expect(s.firstResponseCacheCreation).toBe(40_000);
    expect(s.toolCalls).toBe(3);
    expect(s.output).toBe(1_200);
  });

  it('survives a file that is not there and a half-written last line', () => {
    expect(readTranscript(join(tmpdir(), 'rt-stats-nope', 'missing.jsonl')).responses).toBe(0);
    const root = mkdtempSync(join(tmpdir(), 'rt-stats-partial-'));
    const file = join(root, 'partial.jsonl');
    writeFileSync(file, assistant('msg_a', { output_tokens: 10 }) + '\n{"type":"assist');
    expect(readTranscript(file).output).toBe(10);
  });
});

describe('collectStats', () => {
  it('counts agents, not journals, and splits the two tiers', () => {
    const s = collectStats(stageRoot());
    expect(s.children).toBe(2);
    expect(s.childrenByTier).toEqual({ task: 1, workflow: 1 });
    expect(s.runsWithSubagents).toBe(1);
    expect(s.transcripts).toBe(1);
  });

  it('gives the child share of output and the cold-start average', () => {
    const s = collectStats(stageRoot());
    expect(s.output.parent).toBe(300);
    expect(s.output.children).toBe(1_200);
    expect(s.output.childSharePct).toBe(80);
    expect(s.coldStartAvg).toBe(20_000); // 40,000 over two children
  });

  it('names the silent children', () => {
    const s = collectStats(stageRoot());
    expect(s.silent).toEqual({ count: 1, pct: 50 });
  });

  it('reports the per-line over-count rather than quietly fixing it', () => {
    const s = collectStats(stageRoot());
    expect(s.perLine.lines).toBe(5);
    expect(s.perLine.responses).toBe(3);
    expect(s.perLine.summed).toBe(2_100);
    expect(s.perLine.deduped).toBe(1_500);
    expect(s.perLine.overcountPct).toBe(40);
  });

  it('counts a hook firing once although it writes two records', () => {
    const s = collectStats(stageRoot());
    expect(s.hooks.records).toBe(2);
    expect(s.hooks.firings).toBe(1);
    expect(s.hooks.byName).toEqual([['PostToolUse:Edit', 1]]);
  });

  it('splits the per-line over-count by tier, because it is not evenly spread', () => {
    const s = collectStats(stageRoot());
    // The staged parent repeats one response over three lines; the staged children write one
    // line each, which is the shape the real corpus has and the reason the split is printed.
    expect(s.perLineByTier.parent.overcountPct).toBe(200);
    expect(s.perLineByTier.children.overcountPct).toBe(0);
  });

  it('reports the child share within fan-out runs separately from the machine-wide one', () => {
    const s = collectStats(stageRoot());
    // Here every session spawned subagents, so the two agree; they diverge on a real machine
    // where most sessions never fan out, and reporting only one of them misleads either way.
    expect(s.childShareWithinFanOutPct).toBe(80);
    expect(s.output.childSharePct).toBe(80);
  });

  it('returns zeroes for a root with nothing in it', () => {
    const s = collectStats(mkdtempSync(join(tmpdir(), 'rt-stats-empty-')));
    expect(s).toMatchObject({ transcripts: 0, children: 0, runsWithSubagents: 0 });
    expect(s.output.childSharePct).toBe(0);
  });
});

describe('formatStats', () => {
  it('prints the numbers and the caveat that absence is not proof', () => {
    const root = stageRoot();
    const text = formatStats(collectStats(root), root);
    expect(text).toContain('2 children');
    expect(text).toContain('80% of the output of the runs that spawned them');
    expect(text).toContain('children are 80% of all output');
    expect(text).toContain('main transcripts +200%, subagent transcripts +0%');
    expect(text).toContain('never registered');
    expect(text).toContain('Nothing was written and nothing left this machine.');
  });
});
