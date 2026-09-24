import { describe, expect, it } from 'vitest';
import type { Ev } from '../shared/events';
import { EV_KEEP, evLog } from '../src/ui/evlog';
import type { EvSink } from '../src/ws';

/**
 * The page's copy of each session's raw events, which the Share dialog renders from.
 *
 * It sits in front of the office's sink, so the two ways it can hurt are both silent: swallow an
 * event and a person vanishes from the room, keep one across a replay and it is in the clip twice.
 */

let SEQ = 0;
const said = (sessionId: string, text: string): Ev => ({
  kind: 'agentText',
  ref: { sessionId, agentId: 'main' },
  text,
  ts: 1000 + SEQ,
  seq: ++SEQ,
});

function recorder(): EvSink & { got: Ev[]; resets: (string | null)[] } {
  const got: Ev[] = [];
  const resets: (string | null)[] = [];
  return { got, resets, ev: (ev) => got.push(ev), reset: (id) => resets.push(id) };
}

describe('evLog', () => {
  it('hands every event and every reset on, unchanged and in order', () => {
    const inner = recorder();
    const log = evLog(() => inner);
    const a = said('s1', 'one');
    const b = said('s2', 'two');
    log.sink.ev(a);
    log.sink.ev(b);
    log.sink.reset('s1');
    log.sink.reset(null);
    expect(inner.got).toEqual([a, b]);
    expect(inner.resets).toEqual(['s1', null]);
  });

  it('keeps each session apart, oldest first', () => {
    const log = evLog(() => recorder());
    const evs = [said('s1', 'a'), said('s2', 'b'), said('s1', 'c')];
    for (const ev of evs) log.sink.ev(ev);
    expect(log.events('s1').map((e) => (e.kind === 'agentText' ? e.text : ''))).toEqual(['a', 'c']);
    expect(log.events('s2')).toHaveLength(1);
    expect(log.events('nobody')).toEqual([]);
  });

  it('hands out a copy, so a render in progress never sees the session grow under it', () => {
    const log = evLog(() => recorder());
    log.sink.ev(said('s1', 'a'));
    const snap = log.events('s1');
    log.sink.ev(said('s1', 'b'));
    expect(snap).toHaveLength(1);
    expect(log.events('s1')).toHaveLength(2);
  });

  it('forgets a session the hub is about to replay, and everything on a reconnect', () => {
    const log = evLog(() => recorder());
    log.sink.ev(said('s1', 'a'));
    log.sink.ev(said('s2', 'b'));
    log.sink.reset('s1');
    expect(log.events('s1')).toEqual([]);
    expect(log.events('s2')).toHaveLength(1);
    log.sink.reset(null);
    expect(log.events('s2')).toEqual([]);
  });

  it('caps a session and counts what fell off, rather than growing for as long as the tab is open', () => {
    const log = evLog(() => recorder());
    for (let i = 0; i < EV_KEEP + 30; i++) log.sink.ev(said('s1', `t${i}`));
    const kept = log.events('s1');
    expect(kept).toHaveLength(EV_KEEP);
    expect(log.lost('s1')).toBe(30);
    expect(kept[0].kind === 'agentText' && kept[0].text).toBe('t30'); // the oldest go first
    log.sink.reset('s1');
    expect(log.lost('s1')).toBe(0);
  });

  it('holds one budget across sessions, trimming the least recently active first', () => {
    const log = evLog(() => recorder(), 5);
    for (const t of ['a1', 'a2', 'a3']) log.sink.ev(said('idle', t));
    for (const t of ['b1', 'b2', 'b3']) log.sink.ev(said('busy', t));
    // Six events against a budget of five: the idle session gives up its oldest, the busy one
    // keeps all of its own.
    expect(log.events('idle').map((e) => (e as Ev & { text: string }).text)).toEqual(['a2', 'a3']);
    expect(log.lost('idle')).toBe(1);
    expect(log.events('busy')).toHaveLength(3);
    // The idle session writes again and becomes the recent one; now the other pays.
    log.sink.ev(said('idle', 'a4'));
    expect(log.events('busy').map((e) => (e as Ev & { text: string }).text)).toEqual(['b2', 'b3']);
    expect(log.lost('busy')).toBe(1);
    // A reset hands its events back to the budget rather than leaking the count.
    log.sink.reset('busy');
    for (const t of ['a5', 'a6']) log.sink.ev(said('idle', t));
    expect(log.events('idle')).toHaveLength(5);
    expect(log.lost('idle')).toBe(1);
  });

  it('reads the wrapped sink at each event, so the shell may hand it a new one', () => {
    let inner = recorder();
    const log = evLog(() => inner);
    log.sink.ev(said('s1', 'a'));
    const first = inner;
    inner = recorder();
    log.sink.ev(said('s1', 'b'));
    expect(first.got).toHaveLength(1);
    expect(inner.got).toHaveLength(1);
  });
});
