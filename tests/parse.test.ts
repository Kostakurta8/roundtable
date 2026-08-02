import { describe, expect, it } from 'vitest';
import { parseLine } from '../server/parse';

describe('parseLine', () => {
  it('parses a known line and keeps fields', () => {
    const l = parseLine('{"type":"assistant","sessionId":"s","message":{"role":"assistant"}}');
    expect(l?.type).toBe('assistant');
    expect(l?.sessionId).toBe('s');
  });

  it('returns null on garbage and on non-objects', () => {
    expect(parseLine('not json')).toBeNull();
    expect(parseLine('42')).toBeNull();
  });
});
