import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
describe('fixtures', () => {
  it('every fixture line is valid JSON', () => {
    for (const f of [join('fixtures', 'main-session.jsonl'), join('fixtures', 'agent-abc123.jsonl')])
      for (const line of readFileSync(f, 'utf8').split('\n').filter(Boolean))
        expect(() => JSON.parse(line)).not.toThrow();
  });
});
