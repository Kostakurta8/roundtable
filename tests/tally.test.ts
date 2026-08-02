import { describe, expect, it } from 'vitest';
import { tally } from '../src/chat/MessageCard';

/**
 * Chips are a log of tool calls in the order they happened. Collapsing repeats is a display
 * convenience and must never reorder that log: only a consecutive run of the same label may
 * become one chip, because only a consecutive run actually happened consecutively.
 */
describe('tally', () => {
  it('collapses an adjacent run into one chip with its count', () => {
    expect(tally(['Read src/a.ts', 'Read src/a.ts', 'Read src/a.ts', 'Bash'])).toEqual([
      'Read src/a.ts ×3',
      'Bash',
    ]);
  });

  it('keeps non-adjacent repeats apart, in the order they happened', () => {
    // Bare labels (Bash, TodoWrite — no file or pattern to name) make this the common case.
    expect(tally(['Bash', 'Read src/b.ts', 'Bash'])).toEqual(['Bash', 'Read src/b.ts', 'Bash']);
  });

  it('counts each run on its own when a label comes back later', () => {
    expect(tally(['Bash', 'Bash', 'Read src/b.ts', 'Bash', 'Bash', 'Bash'])).toEqual([
      'Bash ×2',
      'Read src/b.ts',
      'Bash ×3',
    ]);
  });

  it('leaves single occurrences and an empty list alone', () => {
    expect(tally(['Grep retryWithBackoff'])).toEqual(['Grep retryWithBackoff']);
    expect(tally([])).toEqual([]);
  });

  it('never drops a call: the counts always add back up to the input length', () => {
    const chips = ['Bash', 'Bash', 'Read x', 'Grep y', 'Grep y', 'Bash', 'Read x', 'Read x'];
    const total = tally(chips).reduce((n, label) => {
      const m = /×(\d+)$/.exec(label);
      return n + (m ? Number(m[1]) : 1);
    }, 0);
    expect(total).toBe(chips.length);
  });
});
