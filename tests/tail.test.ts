import { mkdtempSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Tailer } from '../server/tail';

describe('Tailer', () => {
  it('returns only new complete lines per call', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rt-'));
    const f = join(dir, 'a.jsonl');
    writeFileSync(f, '{"a":1}\n');
    const t = new Tailer();
    expect(t.readNew(f)).toEqual(['{"a":1}']);
    appendFileSync(f, '{"b":2}\n{"c":');          // partial third line
    expect(t.readNew(f)).toEqual(['{"b":2}']);
    appendFileSync(f, '3}\n');
    expect(t.readNew(f)).toEqual(['{"c":3}']);
    expect(t.readNew(f)).toEqual([]);
  });
});
