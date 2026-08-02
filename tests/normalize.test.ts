import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseLine } from '../server/parse';
import { Normalizer } from '../server/normalize';

const feedAll = (file: string, agentId: 'main' | string) => {
  const n = new Normalizer('fix-sess', agentId);
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .flatMap((l) => {
      const r = parseLine(l);
      return r ? n.feed(r) : [];
    });
};

describe('Normalizer', () => {
  it('normalizes the main fixture', () => {
    const evs = feedAll(join('fixtures', 'main-session.jsonl'), 'main');
    const kinds = evs.map((e) => e.kind);
    expect(kinds).toContain('userMessage');
    expect(kinds).toContain('thinking');
    expect(kinds).toContain('agentText');
    expect(evs.find((e) => e.kind === 'toolStart' && e.tool === 'Grep')).toBeTruthy();
    expect(evs.find((e) => e.kind === 'agentSpawn')).toBeTruthy(); // Task tool_use
    expect(evs.find((e) => e.kind === 'toolResult' && e.ok)).toBeTruthy();
    // Controller resolution: first line (user) has no model; the first assistant line
    // introduces 'claude-fable-5' later, which must land as a second agentSeen for the
    // same ref (client upserts on agentId, so a later, more-complete agentSeen is fine).
    expect(evs.find((e) => e.kind === 'agentSeen' && e.model === 'claude-fable-5')).toBeTruthy();
    const seqs = evs.map((e) => e.seq);
    expect([...seqs].sort((a, b) => a - b)).toEqual(seqs); // monotonic
  });

  it('normalizes a subagent fixture with its agentId', () => {
    const evs = feedAll(join('fixtures', 'agent-abc123.jsonl'), 'abc123');
    expect(evs.every((e) => 'ref' in e && e.ref.agentId === 'abc123')).toBe(true);
  });
});

describe('Normalizer edge cases', () => {
  it('falls back to a sensible ts when timestamp is missing', () => {
    const n = new Normalizer('s', 'main');
    const before = Date.now();
    const [seen] = n.feed({ type: 'user', message: { role: 'user', content: 'hi' } });
    const after = Date.now();
    expect(seen.ts).toBeGreaterThanOrEqual(before);
    expect(seen.ts).toBeLessThanOrEqual(after);
  });

  it('skips whitespace-only thinking blocks', () => {
    const n = new Normalizer('s', 'main');
    const evs = n.feed({
      type: 'assistant',
      timestamp: '2026-08-02T10:00:00.000Z',
      message: { role: 'assistant', content: [{ type: 'thinking', thinking: '   ' }] },
    });
    expect(evs.some((e) => e.kind === 'thinking')).toBe(false);
  });

  it('does not emit agentText for a text block on a non-assistant message', () => {
    const n = new Normalizer('s', 'main');
    const evs = n.feed({
      type: 'user',
      timestamp: '2026-08-02T10:00:00.000Z',
      message: { role: 'user', content: [{ type: 'text', text: 'not really agent text' }] },
    });
    expect(evs.some((e) => e.kind === 'agentText')).toBe(false);
  });

  it('keeps seq monotonic across two separate Normalizer instances', () => {
    const a = new Normalizer('s1', 'main');
    const b = new Normalizer('s2', 'main');
    const evsA = a.feed({
      type: 'user',
      timestamp: '2026-08-02T10:00:00.000Z',
      message: { role: 'user', content: 'hi' },
    });
    const evsB = b.feed({
      type: 'user',
      timestamp: '2026-08-02T10:00:01.000Z',
      message: { role: 'user', content: 'hello' },
    });
    expect(evsB[0].seq).toBeGreaterThan(evsA[evsA.length - 1].seq);
  });

  it('never throws on unknown line types or malformed content blocks', () => {
    const n = new Normalizer('s', 'main');
    expect(() =>
      n.feed({ type: 'file-history-snapshot', timestamp: '2026-08-02T10:00:00.000Z' }),
    ).not.toThrow();
    expect(() =>
      n.feed({
        type: 'assistant',
        timestamp: '2026-08-02T10:00:00.000Z',
        message: { role: 'assistant', content: [null, 42, { type: 'bogus' }] },
      }),
    ).not.toThrow();
  });
});
