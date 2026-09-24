/** @vitest-environment jsdom */

/**
 * The card's caption on the hosted demo, in a file of its own because `feedFrom` is for the life of
 * the page: once a recording is feeding it, every test after would be looking at the demo.
 *
 * A caption is posted under the poster's own name. "My session" about a staged one would be theirs
 * to retract, so over a recording the card's line says whose it is — nobody's — and points at the
 * page it came from, as the GIF's does.
 */
import { describe, expect, it } from 'vitest';
import type { CardStats } from '../src/clip/card';
import { cardCaption } from '../src/ui/ShareDialog';
import { feedFrom, isRecorded } from '../src/ws';

const STATS: CardStats = {
  agents: 25,
  spawned: 24,
  peak: 8,
  totalTok: 14_829_413,
  cost: 28.08,
  costPartial: false,
  durationMs: 566_894,
  confirmed: 8,
  refuted: 1,
  busiest: { name: 'main', tokens: 2_353_930 },
  task: 'migrate billing off the old job queue',
};

describe('the card caption', () => {
  it('is the poster’s own session when a hub is feeding the page', () => {
    expect(isRecorded()).toBe(false);
    expect(cardCaption(STATS)).toMatch(/^My Claude Code session in numbers: 24 subagents \(8 at once\), 14\.83M tokens, 9m 26s/);
    expect(cardCaption(STATS)).toContain('npx https://github.com/Kostakurta8/roundtable/releases/latest/download/roundtable.tgz --card');
  });

  it('is nobody’s over a recording, and links the page it came from', () => {
    feedFrom(() => () => {});
    expect(isRecorded()).toBe(true);
    for (const line of [cardCaption(STATS), cardCaption(null)]) {
      expect(line).not.toMatch(/\bmy\b/i);
      expect(line).toContain('staged replay');
      expect(line).toContain('https://kostakurta8.github.io/roundtable/');
      expect(line).not.toContain('npx');
    }
    expect(cardCaption(STATS)).toContain('24 subagents (8 at once), 14.83M tokens, 9m 26s');
  });

  it('never carries the task or an agent’s name, in either mode', () => {
    expect(cardCaption(STATS)).not.toContain(STATS.task!);
    expect(cardCaption({ ...STATS, busiest: { name: 'Scout the ledger', tokens: 9 } })).not.toContain('Scout');
  });
});
