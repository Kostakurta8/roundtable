import { describe, expect, it } from 'vitest';
import { tally } from '../src/chat/MessageCard';
import type { RtTool } from '../src/store';

/**
 * Chips are a log of tool calls in the order they happened. Collapsing repeats is a display
 * convenience and must never reorder that log: only a consecutive run of the same label may
 * become one chip, because only a consecutive run actually happened consecutively.
 */

let n = 0;
const make = (
  label: string,
  ok: boolean | undefined,
  ms: number | undefined,
  lines: { added?: number; removed?: number } = {},
): RtTool => ({
  id: `t${++n}`,
  agentId: 'a',
  tool: label.split(' ')[0],
  label,
  ts: 1_700_000_000_000 + n,
  ok,
  ms,
  ...lines,
});

/** A finished call — the common case, and what the runs are built from. */
const call = (label: string, ms = 10): RtTool => make(label, true, ms);
/** A call that has started and not come back: no outcome, no duration. */
const running = (label: string): RtTool => make(label, undefined, undefined);
const failed = (label: string, ms = 10): RtTool => make(label, false, ms);

const labels = (tools: RtTool[]): string[] =>
  tally(tools).map((g) => (g.n > 1 ? `${g.label} ×${g.n}` : g.label));

describe('tally', () => {
  it('collapses an adjacent run into one chip with its count', () => {
    expect(labels([call('Read src/a.ts'), call('Read src/a.ts'), call('Read src/a.ts'), call('Bash')])).toEqual([
      'Read src/a.ts ×3',
      'Bash',
    ]);
  });

  it('keeps non-adjacent repeats apart, in the order they happened', () => {
    // Bare labels (Bash, TodoWrite — no file or pattern to name) make this the common case.
    expect(labels([call('Bash'), call('Read src/b.ts'), call('Bash')])).toEqual([
      'Bash',
      'Read src/b.ts',
      'Bash',
    ]);
  });

  it('counts each run on its own when a label comes back later', () => {
    const tools = [call('Bash'), call('Bash'), call('Read src/b.ts'), call('Bash'), call('Bash'), call('Bash')];
    expect(labels(tools)).toEqual(['Bash ×2', 'Read src/b.ts', 'Bash ×3']);
  });

  it('leaves single occurrences and an empty list alone', () => {
    expect(labels([call('Grep retryWithBackoff')])).toEqual(['Grep retryWithBackoff']);
    expect(tally([])).toEqual([]);
  });

  it('never drops a call: the counts always add back up to the input length', () => {
    const tools = [
      call('Bash'),
      call('Bash'),
      call('Read x'),
      call('Grep y'),
      call('Grep y'),
      call('Bash'),
      call('Read x'),
      call('Read x'),
    ];
    expect(tally(tools).reduce((sum, g) => sum + g.n, 0)).toBe(tools.length);
  });

  /**
   * Outcome is part of the identity of a run. A call that is still open and one that came back
   * are drawn differently and must not merge, or a finished chip would silently absorb a running
   * one and the feed would claim work had completed that had not.
   */
  it('does not merge a running call into a finished run of the same label', () => {
    const groups = tally([call('Bash'), call('Bash'), running('Bash')]);
    expect(groups.map((g) => [g.label, g.n, g.ok])).toEqual([
      ['Bash', 2, true],
      ['Bash', 1, undefined],
    ]);
  });

  it('keeps a failed call out of a successful run', () => {
    const groups = tally([call('Bash'), failed('Bash'), call('Bash')]);
    expect(groups.map((g) => g.ok)).toEqual([true, false, true]);
  });

  it('sums the duration of a merged run, and reports none while any call is open', () => {
    expect(tally([call('Read a', 20), call('Read a', 30)])[0].ms).toBe(50);
    expect(tally([running('Read a'), running('Read a')])[0].ms).toBeUndefined();
  });

  /**
   * The line counts a file edit reports, on the chip that stands for it.
   *
   * Same rule as the duration, for the same reason: a total assembled from some of a run's calls
   * is not that run's total, and a chip reading `+12` for two edits of which only one was
   * countable states a measurement nobody made. Absent stays absent — it means "not knowable",
   * never zero.
   */
  const edit = (label: string, added: number, removed: number): RtTool => make(label, true, 10, { added, removed });

  it('sums the lines a merged run added and removed', () => {
    const [g] = tally([edit('Edit src/a.ts', 12, 3), edit('Edit src/a.ts', 4, 0)]);
    expect([g.added, g.removed]).toEqual([16, 3]);
  });

  it('reports no count for a run where one call could not be counted', () => {
    const [g] = tally([edit('Edit src/a.ts', 12, 3), call('Edit src/a.ts')]);
    expect(g.added).toBeUndefined();
    expect(g.removed).toBeUndefined();
  });

  it('carries a lone edit\'s counts through untouched, including a genuine zero', () => {
    const [g] = tally([edit('Write src/new.ts', 40, 0)]);
    expect([g.added, g.removed]).toEqual([40, 0]);
  });

  it('leaves a call that changed no file with no counts at all', () => {
    const [g] = tally([call('Bash npm test')]);
    expect(g.added).toBeUndefined();
    expect(g.removed).toBeUndefined();
  });
});
