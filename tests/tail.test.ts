import { mkdtempSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MAX_BATCH_BYTES, Tailer } from '../server/tail';

/** A JSONL line guaranteed to be longer than one batch, so the tailer has to step over it. */
const oversizedLine = (): string =>
  `${JSON.stringify({ type: 'user', message: { role: 'user', content: 'x'.repeat(MAX_BATCH_BYTES) } })}\n`;

const freshFile = (name = 'a.jsonl'): string => join(mkdtempSync(join(tmpdir(), 'rt-')), name);

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

  // A skipped line is not a cosmetic loss: a `tool_result` big enough to trip this cap leaves the
  // chip it would have closed spinning for the rest of the session. The global counter cannot say
  // which session lost it, so the callback names the file — that is the only route to a session.
  it('names the file it stepped an oversized line over in', () => {
    const f = freshFile('big.jsonl');
    const after = '{"type":"user","uuid":"after"}';
    writeFileSync(f, `${oversizedLine()}${after}\n`);

    const skips: string[] = [];
    const t = new Tailer(undefined, (p) => skips.push(p));

    expect(t.readNew(f)).toEqual([]); // the whole first batch was one unterminated line
    expect(skips).toEqual([f]);
    expect(t.snapshot().skipped).toBe(1);

    // …and the tail resynchronizes on the next newline rather than wedging on the offset.
    expect(t.readNew(f).at(-1)).toBe(after);
    expect(skips).toHaveLength(1); // stepping over it is reported once, not once per read
  });

  it('does not report a short read mid-line as a skip', () => {
    const f = freshFile('partial.jsonl');
    writeFileSync(f, '{"type":"user"'); // writer is mid-line; the rest is still coming
    const skips: string[] = [];
    const t = new Tailer(undefined, (p) => skips.push(p));
    expect(t.readNew(f)).toEqual([]);
    expect(skips).toEqual([]);
    appendFileSync(f, '}\n');
    expect(t.readNew(f)).toEqual(['{"type":"user"}']);
  });

  it('rewinds to zero and names the file when a transcript is replaced', () => {
    const f = freshFile('rewound.jsonl');
    writeFileSync(f, '{"a":1}\n{"a":2}\n');
    const resets: string[] = [];
    const t = new Tailer((p) => resets.push(p));
    expect(t.readNew(f)).toEqual(['{"a":1}', '{"a":2}']);
    expect(t.offsetOf(f)).toBeGreaterThan(0);

    writeFileSync(f, '{"b":1}\n'); // shorter: a different file under the same name
    expect(t.readNew(f)).toEqual(['{"b":1}']); // read from zero, not from the stale offset
    expect(resets).toEqual([f]);
    expect(t.snapshot().resets).toBe(1);
  });
});
