/**
 * The session card's numbers, and the picture they are printed on.
 *
 * The card makes claims in public under somebody's name, so what is pinned here is that each claim
 * is one the app already makes: the totals are the store's fold of the same events, spelled by the
 * top bar's own formatters, `≥` included; the two figures the app does not print — how many
 * subagents at once, and for how long — are what the room and the clip's clock say; and a bare card
 * carries nothing typed into a transcript, which is tested the only way that proves it: rewrite
 * every word of the session and get the same pixels back.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { AgentRef, Ev } from '../shared/events';
import { Normalizer } from '../server/normalize';
import { parseLine } from '../server/parse';
import { CARD_H, CARD_SCALE, CARD_W, cardStats, clock, costText, renderCard, tokText } from '../src/clip/card';
import { initialState, reduce, type RtState } from '../src/store';
import { money, tokens } from '../src/ui/format';

const S = 'sess-card-0001';
/** One event before the hub numbers it — `Omit` taken kind by kind, so each keeps its own fields. */
type Draft = { [K in Ev['kind']]: Omit<Extract<Ev, { kind: K }>, 'seq'> }[Ev['kind']];
const ref = (agentId: string): AgentRef => ({ sessionId: S, agentId });

/** The events of a small session, in the order a hub would deliver them, with fresh `seq`s. */
function session(over: { cModel?: string; text?: (s: string) => string } = {}): Ev[] {
  const t = over.text ?? ((s: string) => s);
  const sonnet = 'claude-sonnet-5';
  const haiku = 'claude-haiku-4-5';
  const draft: Draft[] = [
    // The hub's own clock, stamped the day the page opened; a card that counted from it would say
    // the session ran until now.
    { kind: 'sessionSeen', sessionId: S, cwd: '/w', live: false, ts: 9_000_000_000_000 },
    { kind: 'userMessage', ref: ref('main'), text: t('ship the billing migration and prove it'), source: 'human', ts: 1_000 },
    { kind: 'usage', ref: ref('main'), inTok: 1_000, outTok: 200, cacheRead: 5_000, cacheWrite: 0, model: sonnet, ts: 1_500 },
    { kind: 'agentSpawn', ref: ref('main'), childAgentId: 'pending', prompt: t('scout the ledger'), toolUseId: 'tu-a', ts: 1_900 },
    { kind: 'agentSeen', ref: ref('a1'), label: t('Scout the ledger'), parentToolUseId: 'tu-a', model: haiku, ts: 2_000 },
    { kind: 'agentSpawn', ref: ref('main'), childAgentId: 'pending', prompt: t('scout the queue'), toolUseId: 'tu-b', ts: 2_900 },
    { kind: 'agentSeen', ref: ref('b2'), label: t('Scout the queue'), parentToolUseId: 'tu-b', model: haiku, ts: 3_000 },
    { kind: 'toolStart', ref: ref('a1'), tool: 'Read', target: t('src/ledger.ts'), toolUseId: 'r-1', ts: 3_500 },
    { kind: 'toolResult', ref: ref('a1'), toolUseId: 'r-1', ok: true, ts: 3_700 },
    { kind: 'usage', ref: ref('a1'), inTok: 8_000, outTok: 2_000, model: haiku, ts: 4_000 },
    { kind: 'usage', ref: ref('b2'), inTok: 40_000, outTok: 10_000, model: haiku, ts: 4_500 },
    { kind: 'agentText', ref: ref('b2'), text: `CONFIRMED: ${t('the ack path is idempotent')}`, ts: 5_000 },
    { kind: 'agentText', ref: ref('a1'), text: `REFUTED: ${t('retries charge twice')}`, ts: 5_200 },
    // Not a verdict: the feed's test is a whole word, and so is the card's.
    { kind: 'agentText', ref: ref('a1'), text: `UNREFUTED ${t('and UNCONFIRMED so far')}`, ts: 5_300 },
    { kind: 'agentDone', ref: ref('a1'), ok: true, ts: 6_000 },
    { kind: 'agentDone', ref: ref('b2'), ok: true, ts: 6_500 },
    { kind: 'agentSpawn', ref: ref('main'), childAgentId: 'pending', prompt: t('verify the fix'), toolUseId: 'tu-c', ts: 7_900 },
    { kind: 'agentSeen', ref: ref('c3'), label: t('Verify the fix'), parentToolUseId: 'tu-c', model: over.cModel ?? haiku, ts: 8_000 },
    { kind: 'usage', ref: ref('c3'), inTok: 900, outTok: 100, model: over.cModel ?? haiku, ts: 8_500 },
    { kind: 'agentDone', ref: ref('c3'), ok: true, ts: 9_000 },
  ];
  return draft.map((e, i) => ({ ...e, seq: i + 1 }) as Ev);
}

const foldOf = (evs: readonly Ev[]): RtState => evs.reduce(reduce, initialState);

/** A whole session: the orchestrator's transcript and its subagent's, through the real normalizer. */
function fixtureSession(): Ev[] {
  const feed = (file: string, agentId: string): Ev[] => {
    const n = new Normalizer('fix-sess', agentId);
    return readFileSync(join(__dirname, '..', 'fixtures', file), 'utf8')
      .split('\n')
      .filter(Boolean)
      .flatMap((l) => {
        const r = parseLine(l);
        return r ? n.feed(r) : [];
      });
  };
  return [...feed('main-session.jsonl', 'main'), ...feed('agent-abc123.jsonl', 'abc123')];
}

describe('the numbers', () => {
  const evs = session();
  const stats = cardStats(evs);

  it('counts the subagents the session spawned, and main apart from them', () => {
    expect(stats.agents).toBe(4); // what the top bar calls AGENTS: main and three
    expect(stats.spawned).toBe(3);
  });

  it('counts as at once only the subagents that were in the room together', () => {
    // a1 and b2 overlap; c3 arrives after both have finished.
    expect(stats.peak).toBe(2);
  });

  it('totals every token billed, cache included, exactly as the store does', () => {
    expect(stats.totalTok).toBe(6_200 + 10_000 + 50_000 + 1_000);
    expect(stats.totalTok).toBe(foldOf(evs).totalTok);
    expect(tokText(stats)).toBe(tokens(foldOf(evs).totalTok));
  });

  it('names the agent that billed the most, by the name the roster gives it', () => {
    expect(stats.busiest).toEqual({ name: 'Scout the queue', tokens: 50_000 });
  });

  it('runs from the first transcript line to the last, not to when the hub happened to look', () => {
    expect(stats.durationMs).toBe(8_000);
  });

  it('counts verdicts by the feed’s own whole-word test', () => {
    expect(stats.confirmed).toBe(1);
    expect(stats.refuted).toBe(1);
  });

  it('counts an event the hub delivered twice once, as the store does', () => {
    const again = [...evs, ...evs.filter((e) => e.kind === 'agentText' || e.kind === 'usage')];
    const twice = cardStats(again);
    expect(twice.confirmed).toBe(1);
    expect(twice.totalTok).toBe(stats.totalTok);
  });

  it('carries the task the whiteboard shows', () => {
    expect(stats.task).toBe('ship the billing migration and prove it');
  });

  it('is the store’s figure for the whole fixture session, not a count of its own', () => {
    const fx = fixtureSession();
    const s = foldOf(fx);
    const c = cardStats(fx);
    expect(c.agents).toBe(s.order.length);
    expect(c.totalTok).toBe(s.totalTok);
    expect(c.cost).toBe(s.cost);
    expect(c.costPartial).toBe(s.costPartial);
  });
});

describe('the estimate', () => {
  it('is spelled as the top bar spells it', () => {
    const s = cardStats(session());
    expect(s.costPartial).toBe(false);
    expect(costText(s)).toBe(money(foldOf(session()).cost));
    expect(costText(s)).not.toContain('≥');
  });

  it('says it is a floor, with ≥, when some tokens have no rate card', () => {
    const evs = session({ cModel: 'mystery-model-9' });
    const s = cardStats(evs);
    expect(s.costPartial).toBe(true);
    expect(s.cost).toBe(foldOf(evs).cost);
    expect(costText(s)).toBe(`≥${money(foldOf(evs).cost)}`);
  });

  it('never prints a figure the top bar would not', () => {
    expect(costText({ cost: 0, costPartial: true })).toBe('≥$0.00');
    expect(costText({ cost: 0.004, costPartial: false })).toBe('<$0.01');
    expect(costText({ cost: 12.345, costPartial: false })).toBe('$12.35');
  });
});

describe('a bare card', () => {
  it('names no agent and carries no task', () => {
    const s = cardStats(session(), { bare: true });
    expect(s.task).toBeNull();
    // b2 was the second subagent into the room, and that is all a bare card says about it.
    expect(s.busiest).toEqual({ name: 'agent 2', tokens: 50_000 });
    expect(JSON.stringify(s)).not.toMatch(/scout|ledger|queue|billing|verify/i);
  });

  it('is the same picture whatever the transcripts said', () => {
    // Every word typed into the session rewritten, and nothing else: the verdict keywords stay,
    // because whether a turn is a verdict is a count the card prints, not text it shows.
    const garble = (s: string): string => s.replace(/[a-z]/gi, 'x');
    const a = renderCard(session(), { bare: true });
    const b = renderCard(session({ text: garble }), { bare: true });
    expect(Buffer.from(b.rgba.buffer).equals(Buffer.from(a.rgba.buffer))).toBe(true);
    // And the same rewrite does show on a card that keeps the text, or the test proves nothing.
    const c = renderCard(session(), { bare: false });
    const d = renderCard(session({ text: garble }), { bare: false });
    expect(Buffer.from(d.rgba.buffer).equals(Buffer.from(c.rgba.buffer))).toBe(false);
  });
});

describe('the picture', () => {
  const card = renderCard(session());

  it('is 1200x630, opaque', () => {
    expect([card.width, card.height]).toEqual([CARD_W * CARD_SCALE, CARD_H * CARD_SCALE]);
    expect([card.width, card.height]).toEqual([1200, 630]);
    expect(card.rgba.length).toBe(1200 * 630 * 4);
    for (let i = 3; i < card.rgba.length; i += 4) if (card.rgba[i] !== 255) throw new Error(`pixel ${(i - 3) / 4} is not opaque`);
  });

  it('is pixel art scaled by a whole number: every 2x2 block is one colour', () => {
    const px = new Uint32Array(card.rgba.buffer);
    for (let y = 0; y < card.height; y += 2) {
      for (let x = 0; x < card.width; x += 2) {
        const c = px[y * card.width + x];
        if (px[y * card.width + x + 1] !== c || px[(y + 1) * card.width + x] !== c || px[(y + 1) * card.width + x + 1] !== c) {
          throw new Error(`the block at ${x},${y} is not one colour`);
        }
      }
    }
  });

  it('is the same card every time for the same session', () => {
    const again = renderCard(session());
    expect(Buffer.from(again.rgba.buffer).equals(Buffer.from(card.rgba.buffer))).toBe(true);
  });

  it('draws a session with no subagents at all, and one with no events', () => {
    const solo = session().filter((e) => !('ref' in e) || e.ref.agentId === 'main');
    const s = renderCard(solo).stats;
    expect([s.spawned, s.peak, s.confirmed + s.refuted]).toEqual([0, 0, 0]);
    expect(renderCard([]).stats.busiest).toBeNull();
  });
});

describe('the card\'s numbers, as the pixel font can spell them', () => {
  // Two misreadings found by looking at a rendered card: `$1.31` drawn in the font's 3x5 `$` read
  // as `¢1.31`, and `29.8s` read as `29.85` because the font's S is two pixels from its 5.
  it('writes a duration as a clock, with nothing a 3x5 font can confuse with a digit', () => {
    expect(clock(29_800)).toBe('0:30');
    expect(clock(774_000)).toBe('12:54');
    expect(clock(3_723_000)).toBe('1:02:03');
    expect(clock(0)).toBe('0:00');
    expect(clock(-5)).toBe('0:00');
    for (const ms of [999, 61_000, 5_999_000]) expect(clock(ms)).toMatch(/^[\d:]+$/);
  });
});
