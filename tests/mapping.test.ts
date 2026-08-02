import { describe, expect, it } from 'vitest';
import type { Ev } from '../shared/events';
import { mapEvent } from '../src/office/mapping';

// --- hand-built events, one factory per Ev kind ------------------------------------------
const ref = (agentId: string) => ({ sessionId: 's', agentId });
let SEQ = 0;
const next = () => ++SEQ;

const evAgentSeen = (agentId: string, ts = 1000): Ev => ({
  kind: 'agentSeen', ref: ref(agentId), ts, seq: next(),
});
const evThinking = (agentId: string, text: string, ts = 1000): Ev => ({
  kind: 'thinking', ref: ref(agentId), text, ts, seq: next(),
});
const evToolStart = (agentId: string, tool: string, target?: string, ts = 1000): Ev => ({
  kind: 'toolStart', ref: ref(agentId), tool, target, toolUseId: `tu${SEQ}`, ts, seq: next(),
});
const evText = (agentId: string, text: string, ts = 1000): Ev => ({
  kind: 'agentText', ref: ref(agentId), text, ts, seq: next(),
});
const evUsage = (agentId: string, inTok: number, outTok: number, ts = 1000): Ev => ({
  kind: 'usage', ref: ref(agentId), inTok, outTok, ts, seq: next(),
});
const evUserMessage = (agentId: string, text: string, ts = 1000): Ev => ({
  kind: 'userMessage', ref: ref(agentId), text, ts, seq: next(),
});
const evToolResult = (agentId: string, ok: boolean, ts = 1000): Ev => ({
  kind: 'toolResult', ref: ref(agentId), toolUseId: `tu${SEQ}`, ok, ts, seq: next(),
});
const evFileEdit = (agentId: string, path: string, ts = 1000): Ev => ({
  kind: 'fileEdit', ref: ref(agentId), path, ts, seq: next(),
});
const evAgentSpawn = (agentId: string, childAgentId: string, prompt: string, ts = 1000): Ev => ({
  kind: 'agentSpawn', ref: ref(agentId), childAgentId, prompt, ts, seq: next(),
});
const evSessionSeen = (sessionId: string, ts = 1000): Ev => ({
  kind: 'sessionSeen', sessionId, cwd: '/proj', live: true, ts, seq: next(),
});

describe('mapEvent — agentSeen', () => {
  it('maps to ensureActor for that agent', () => {
    expect(mapEvent(evAgentSeen('abc123'))).toEqual([{ op: 'ensureActor', agentId: 'abc123' }]);
  });
});

describe('mapEvent — thinking', () => {
  it('passes short text through unchanged', () => {
    expect(mapEvent(evThinking('a', 'weighing options'))).toEqual([
      { op: 'think', agentId: 'a', text: 'weighing options' },
    ]);
  });

  it('truncates to the first 90 characters', () => {
    const long = 'x'.repeat(150);
    expect(mapEvent(evThinking('a', long))).toEqual([{ op: 'think', agentId: 'a', text: long.slice(0, 90) }]);
  });
});

describe('mapEvent — toolStart', () => {
  it('joins tool and target into the workBurst label', () => {
    expect(mapEvent(evToolStart('a', 'Grep', 'retryWithBackoff'))).toEqual([
      { op: 'workBurst', agentId: 'a', label: 'Grep retryWithBackoff' },
    ]);
  });

  it('trims the trailing space when there is no target', () => {
    expect(mapEvent(evToolStart('a', 'Bash'))).toEqual([{ op: 'workBurst', agentId: 'a', label: 'Bash' }]);
  });
});

describe('mapEvent — agentText, no verdict', () => {
  it('a subagent delivers the first sentence to main', () => {
    expect(mapEvent(evText('abc123', 'Found the bug. It is in retry.ts.'))).toEqual([
      { op: 'deliver', agentId: 'abc123', to: 'main', text: 'Found the bug.' },
    ]);
  });

  it('main emits nothing — it cannot deliver to itself, and chat already shows it', () => {
    expect(mapEvent(evText('main', 'All good here, moving on.'))).toEqual([]);
  });

  it('lowercase prose is not a verdict', () => {
    expect(mapEvent(evText('sub', 'confirmed the fix by hand.'))).toEqual([
      { op: 'deliver', agentId: 'sub', to: 'main', text: 'confirmed the fix by hand.' },
    ]);
  });
});

describe('mapEvent — agentText, verdicts (confront)', () => {
  it('REFUTED maps to verdict err', () => {
    expect(mapEvent(evText('b', '✕ REFUTED — still 6 red.'))).toEqual([
      { op: 'confront', agentId: 'b', to: 'main', text: '✕ REFUTED — still 6 red.', verdict: 'err' },
    ]);
  });

  it('CONFIRMED maps to verdict ok', () => {
    expect(mapEvent(evText('a', '✓ CONFIRMED — 50/50 green.'))).toEqual([
      { op: 'confront', agentId: 'a', to: 'main', text: '✓ CONFIRMED — 50/50 green.', verdict: 'ok' },
    ]);
  });

  it('REFUTED wins when both markers are present', () => {
    expect(mapEvent(evText('c', 'CONFIRMED by a, then REFUTED by b.'))).toEqual([
      { op: 'confront', agentId: 'c', to: 'main', text: 'CONFIRMED by a, then REFUTED by b.', verdict: 'err' },
    ]);
  });

  it('a main agentText can confront too — verdicts are not subagent-only', () => {
    expect(mapEvent(evText('main', 'REFUTED — the cache path was stale.'))).toEqual([
      { op: 'confront', agentId: 'main', to: 'main', text: 'REFUTED — the cache path was stale.', verdict: 'err' },
    ]);
  });

  it('confront replaces deliver — a subagent verdict does not also produce a deliver', () => {
    const cmds = mapEvent(evText('abc123', 'REFUTED — the fix regressed.'));
    expect(cmds).toHaveLength(1);
    expect(cmds[0].op).toBe('confront');
  });

  it('extracts the first sentence even when the bare marker comes later in the text', () => {
    // Mirrors the approved mockup's real shape: the finding first, the marker last.
    const t = '50/50 green with the window fix. CONFIRMED.';
    expect(mapEvent(evText('verifya', t))).toEqual([
      { op: 'confront', agentId: 'verifya', to: 'main', text: '50/50 green with the window fix.', verdict: 'ok' },
    ]);
  });

  describe('roster target resolution', () => {
    it('falls back to main with no roster given', () => {
      expect(mapEvent(evText('reviewer', 'REFUTED the claim.'))).toEqual([
        { op: 'confront', agentId: 'reviewer', to: 'main', text: 'REFUTED the claim.', verdict: 'err' },
      ]);
    });

    it('falls back to main when no roster id is named in the text', () => {
      const roster = new Set(['scout', 'writer']);
      expect(mapEvent(evText('reviewer', 'REFUTED the claim.'), roster)).toEqual([
        { op: 'confront', agentId: 'reviewer', to: 'main', text: 'REFUTED the claim.', verdict: 'err' },
      ]);
    });

    it('targets the roster agent named in the text', () => {
      const roster = new Set(['scout', 'writer']);
      expect(mapEvent(evText('reviewer', 'scout REFUTED the earlier finding.'), roster)).toEqual([
        {
          op: 'confront',
          agentId: 'reviewer',
          to: 'scout',
          text: 'scout REFUTED the earlier finding.',
          verdict: 'err',
        },
      ]);
    });

    it('never lets "main" shadow a named agent, even when main is seen first in the roster', () => {
      // main is almost always the first roster entry (first agent seen), and the bare word
      // "main" turns up inside ordinary text ("main branch") — if that counted as a match it
      // would win before the loop ever reached a genuinely named later agent.
      const roster = new Set(['main', 'scout']);
      expect(mapEvent(evText('reviewer', 'scout REFUTED it during the main test run.'), roster)).toEqual([
        {
          op: 'confront',
          agentId: 'reviewer',
          to: 'scout',
          text: 'scout REFUTED it during the main test run.',
          verdict: 'err',
        },
      ]);
    });

    // Real agent ids are hex-like, and verdict prose in this domain routinely carries commit
    // SHAs, artifact ids, and other alphanumeric tokens — a bare substring check would let a
    // roster id fire from inside a longer run of letters/digits it was never actually named in.
    describe('word-boundary matching (not a bare substring test)', () => {
      it('does not match a roster id embedded inside a longer alphanumeric token', () => {
        const roster = new Set(['ok']);
        expect(mapEvent(evText('reviewer', 'okay, REFUTED — see the log.'), roster)).toEqual([
          {
            op: 'confront',
            agentId: 'reviewer',
            to: 'main',
            text: 'okay, REFUTED — see the log.',
            verdict: 'err',
          },
        ]);
      });

      it('does not match a roster id embedded inside a longer hex-like token', () => {
        const roster = new Set(['abc123']);
        expect(mapEvent(evText('reviewer', 'REFUTED by xabc1234def, recheck.'), roster)).toEqual([
          {
            op: 'confront',
            agentId: 'reviewer',
            to: 'main',
            text: 'REFUTED by xabc1234def, recheck.',
            verdict: 'err',
          },
        ]);
      });

      it('matches a roster id flanked by a space and the start of the text', () => {
        const roster = new Set(['abc123']);
        expect(mapEvent(evText('reviewer', 'abc123 REFUTED the claim.'), roster)).toEqual([
          {
            op: 'confront',
            agentId: 'reviewer',
            to: 'abc123',
            text: 'abc123 REFUTED the claim.',
            verdict: 'err',
          },
        ]);
      });

      it('matches a roster id flanked by the end of the text', () => {
        const roster = new Set(['abc123']);
        expect(mapEvent(evText('reviewer', 'the claim was REFUTED by abc123'), roster)).toEqual([
          {
            op: 'confront',
            agentId: 'reviewer',
            to: 'abc123',
            text: 'the claim was REFUTED by abc123',
            verdict: 'err',
          },
        ]);
      });

      it('matches a roster id flanked by punctuation', () => {
        const roster = new Set(['abc123']);
        expect(mapEvent(evText('reviewer', 'REFUTED (abc123) — recheck.'), roster)).toEqual([
          {
            op: 'confront',
            agentId: 'reviewer',
            to: 'abc123',
            text: 'REFUTED (abc123) — recheck.',
            verdict: 'err',
          },
        ]);
      });
    });
  });
});

describe('mapEvent — first-sentence extraction', () => {
  it('stops at the first period, keeping it', () => {
    expect(mapEvent(evText('sub', 'Found it. Details follow in the report.'))).toEqual([
      { op: 'deliver', agentId: 'sub', to: 'main', text: 'Found it.' },
    ]);
  });

  it('stops at ! or ? the same way', () => {
    expect(mapEvent(evText('sub', 'Wait! Is this right? Not sure.'))).toEqual([
      { op: 'deliver', agentId: 'sub', to: 'main', text: 'Wait!' },
    ]);
  });

  it('stops at the first newline, excluding it', () => {
    expect(mapEvent(evText('sub', 'No terminator here\nsecond line'))).toEqual([
      { op: 'deliver', agentId: 'sub', to: 'main', text: 'No terminator here' },
    ]);
  });

  it('is the whole text when there is no terminator at all and it fits', () => {
    expect(mapEvent(evText('sub', 'short and sweet'))).toEqual([
      { op: 'deliver', agentId: 'sub', to: 'main', text: 'short and sweet' },
    ]);
  });

  it('caps at ~120 chars when there is no terminator at all', () => {
    const long = 'a'.repeat(200);
    expect(mapEvent(evText('sub', long))).toEqual([
      { op: 'deliver', agentId: 'sub', to: 'main', text: 'a'.repeat(120) },
    ]);
  });

  it('caps at ~120 chars even when the terminator comes later', () => {
    const long = `${'a'.repeat(150)}. tail`;
    expect(mapEvent(evText('sub', long))).toEqual([
      { op: 'deliver', agentId: 'sub', to: 'main', text: 'a'.repeat(120) },
    ]);
  });
});

describe('mapEvent — usage', () => {
  it('formats token counts under 1000 as a plain number', () => {
    expect(mapEvent(evUsage('a', 10, 20))).toEqual([{ op: 'status', agentId: 'a', text: '30 tok' }]);
  });

  it('formats token counts at or above 1000 in one-decimal k-notation', () => {
    expect(mapEvent(evUsage('a', 5000, 3000))).toEqual([{ op: 'status', agentId: 'a', text: '8.0k tok' }]);
  });
});

describe('mapEvent — kinds the office does not react to directly', () => {
  it('userMessage → []', () => {
    expect(mapEvent(evUserMessage('main', 'find the flaky test'))).toEqual([]);
  });

  it('toolResult → []', () => {
    expect(mapEvent(evToolResult('a', true))).toEqual([]);
  });

  it('fileEdit → []', () => {
    expect(mapEvent(evFileEdit('a', 'src/x.ts'))).toEqual([]);
  });

  it('agentSpawn → []', () => {
    expect(mapEvent(evAgentSpawn('main', 'pending', 'scout the suites'))).toEqual([]);
  });

  it('sessionSeen → [] (this kind carries no ref at all)', () => {
    expect(mapEvent(evSessionSeen('s1'))).toEqual([]);
  });

  it('an unrecognized future kind → []', () => {
    const unknown = { kind: 'quantumFlux', ref: ref('a'), ts: 1, seq: 99 } as unknown as Ev;
    expect(mapEvent(unknown)).toEqual([]);
  });
});

describe('mapEvent — purity', () => {
  it('never mutates the roster it is given', () => {
    const roster = new Set(['scout']);
    const before = [...roster];
    mapEvent(evText('reviewer', 'scout REFUTED it.'), roster);
    expect([...roster]).toEqual(before);
  });

  it('returns a fresh array each call for the same inputs', () => {
    const a = mapEvent(evThinking('x', 'hi'));
    const b = mapEvent(evThinking('x', 'hi'));
    expect(a).toEqual(b);
    expect(a).not.toBe(b);
  });

  it('an explicit empty roster behaves the same as the default (omitted) roster', () => {
    const withDefault = mapEvent(evText('reviewer', 'REFUTED it.'));
    const withEmpty = mapEvent(evText('reviewer', 'REFUTED it.'), new Set());
    expect(withDefault).toEqual(withEmpty);
  });
});
