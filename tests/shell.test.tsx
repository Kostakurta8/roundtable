/** @vitest-environment jsdom */

/**
 * The shell's panels, rendered for real in jsdom.
 *
 * Every test here started life as a screenshot of the packaged app doing something wrong: a feed
 * that stayed blank for seconds after load, a caption claiming a whole session while the hub had
 * dropped part of it, an OFFLINE pill with no sentence anywhere saying what to do about it. The
 * screenshots are in `qa/ui/`; these are the assertions that keep them from coming back.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import type { Ev } from '../shared/events';
import { Chat, foldSystem } from '../src/chat/Chat';
import { runSummary } from '../src/chat/MessageCard';
import { initialState, reduce, type RtState } from '../src/store';
import { Inspector } from '../src/ui/Inspector';
import { OfflineNote } from '../src/ui/OfflineNote';
import { Timeline } from '../src/ui/Timeline';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let SEQ = 0;
const ref = (agentId: string) => ({ sessionId: 's', agentId });
const agentSeen = (agentId: string, ts = 1000): Ev => ({ kind: 'agentSeen', ref: ref(agentId), ts, seq: ++SEQ });
const text = (agentId: string, t: string, ts: number): Ev => ({ kind: 'agentText', ref: ref(agentId), text: t, ts, seq: ++SEQ });
const fold = (evs: Ev[], from: RtState = initialState): RtState => evs.reduce(reduce, from);

let root: Root | null = null;
let host: HTMLDivElement | null = null;

const mount = (node: React.ReactNode): HTMLDivElement => {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root!.render(node));
  return host;
};
const rerender = (node: React.ReactNode): void => act(() => root!.render(node));

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

const chat = (state: RtState) => (
  <Chat state={state} title="TASK · x" live truncatedDropped={0} focusAgent={null} seekTs={null} />
);

describe('the feed only animates what arrives live', () => {
  /**
   * The packaged app came up with an empty feed. Every replayed card mounted with the entrance
   * animation, sixty of them at once, and Chromium ran them at a fraction of real time: at +1.5s
   * the cards in view still had `opacity: 0`, at +2s `0.49`. A backlog is history, not news — it
   * lands already there, and only a card that arrives after the panel is up gets the fade.
   */
  it('marks no card fresh when the backlog lands in one batch', () => {
    const evs: Ev[] = [agentSeen('a')];
    for (let i = 0; i < 30; i++) evs.push(text('a', `turn ${i}`, 1000 + i));
    const el = mount(chat(fold(evs)));
    expect(el.querySelectorAll('.msg').length).toBe(30);
    expect(el.querySelectorAll('.msg.fresh').length).toBe(0);
  });

  it('marks exactly the card that arrived after mount', () => {
    const evs: Ev[] = [agentSeen('a')];
    for (let i = 0; i < 30; i++) evs.push(text('a', `turn ${i}`, 1000 + i));
    const before = fold(evs);
    const el = mount(chat(before));

    const after = reduce(before, text('a', 'the live one', 2000));
    rerender(chat(after));

    const fresh = el.querySelectorAll('.msg.fresh');
    expect(fresh.length).toBe(1);
    expect(fresh[0].textContent).toContain('the live one');
    // And not the thirty that were already there.
    expect(el.querySelectorAll('.msg').length).toBe(31);
  });

  it('does not treat a reconnect replay as thirty live arrivals', () => {
    // A reconnect resets the store and replays the whole session in one batch, ids restarting.
    const el = mount(chat(fold([agentSeen('a'), text('a', 'first', 1000)])));
    const evs: Ev[] = [agentSeen('a')];
    for (let i = 0; i < 30; i++) evs.push(text('a', `turn ${i}`, 1000 + i));
    rerender(chat(fold(evs)));
    expect(el.querySelectorAll('.msg.fresh').length).toBe(0);
  });
});

describe('the activity strip says when it is not showing everything', () => {
  const bucket = (t: number) => ({ t, says: 1, tools: 0, thinks: 0, errors: 0 });
  const strip = (dropped: number) => (
    <Timeline buckets={[bucket(1000), bucket(2000), bucket(3000)]} firstTs={1000} lastTs={4000} turns={3} seekTs={null} dropped={dropped} onSeek={() => {}} />
  );

  it('calls an intact session whole', () => {
    const el = mount(strip(0));
    expect(el.textContent).toContain('whole session');
  });

  /**
   * The hub keeps the last 4 000 events of a session and says how many it dropped before the
   * replay. The strip counted buckets, saw fewer than its own cap, and printed "whole session"
   * over a history with a hole in it.
   */
  it('never calls a truncated replay whole', () => {
    const el = mount(strip(600));
    expect(el.textContent).not.toContain('whole session');
    expect(el.textContent).toMatch(/not replayed/);
  });
});

describe('the feed folds runs of system lines', () => {
  /**
   * A fan-out writes a spawn line and a prompt line per agent, so the turn that launched six scouts
   * was followed by twelve centred system lines restating its six `Task` chips, and the next thing
   * anybody said was a screen further down. A run of them is one line now — counted, and every line
   * one press away.
   */
  const fanOut = (): RtState => {
    const evs: Ev[] = [agentSeen('main'), text('main', 'fanning out', 1000)];
    for (const [i, id] of ['a1', 'a2', 'a3'].entries()) {
      evs.push({ kind: 'agentSpawn', ref: ref('main'), childAgentId: 'pending', prompt: `scout ${i}`, ts: 1100 + i, seq: ++SEQ });
      evs.push({ kind: 'userMessage', ref: ref(id), text: `scout ${i}`, ts: 1200 + i, seq: ++SEQ });
    }
    evs.push(text('main', 'collating', 2000));
    return fold(evs);
  };

  it('folds consecutive system lines, leaves a lone one alone, and keeps every message in order', () => {
    const msgs = fanOut().msgs;
    const items = foldSystem(msgs);
    const runs = items.filter((i) => i.kind === 'run');
    expect(runs).toHaveLength(1);
    // Nothing dropped and nothing reordered: flattening the items is the feed again.
    expect(items.flatMap((i) => (i.kind === 'run' ? i.msgs : [i.msg])).map((m) => m.id)).toEqual(msgs.map((m) => m.id));
    // A single system line is not worth a fold.
    const lone = foldSystem([msgs[0], msgs.find((m) => m.agentId === 'system')!, msgs[msgs.length - 1]]);
    expect(lone.every((i) => i.kind === 'one')).toBe(true);
  });

  it('says what the run holds, counting every line', () => {
    const run = foldSystem(fanOut().msgs).find((i) => i.kind === 'run');
    expect(run?.kind === 'run' && runSummary(run.msgs)).toBe('spawned 3 subagents · 3 prompts');
  });

  it('draws a run as one closed line that opens onto every line in it', () => {
    const el = mount(chat(fanOut()));
    const sum = el.querySelector<HTMLButtonElement>('.sys-sum');
    expect(sum?.textContent).toContain('spawned 3 subagents · 3 prompts');
    expect(sum?.getAttribute('aria-expanded')).toBe('false');
    expect(el.querySelectorAll('.sys-list .sys-line')).toHaveLength(0);
    act(() => sum!.click());
    expect(sum?.getAttribute('aria-expanded')).toBe('true');
    expect(el.querySelectorAll('.sys-list .sys-line')).toHaveLength(6);
  });

  /**
   * Seeking the strip to a system line inside a closed run scrolled to the closed fold — "spawned 3
   * subagents · 3 prompts ▸" — and nothing opened it, so the line the strip was clicked for was
   * never on screen. The run holding the target opens for the seek, and the scroll lands on the line.
   */
  it('opens the run a seek lands in, and scrolls to the line rather than the fold', () => {
    const state = fanOut();
    const line = state.msgs.find((m) => m.agentId === 'system' && m.ts === 1201)!;
    const scrolledTo: Element[] = [];
    const real = Element.prototype.scrollIntoView;
    // jsdom lays nothing out and has no `scrollIntoView`; this records where the feed asked to go.
    Element.prototype.scrollIntoView = function (this: Element) {
      scrolledTo.push(this);
    };
    try {
      const at = (seekTs: number | null) => (
        <Chat state={state} title="TASK · x" live truncatedDropped={0} focusAgent={null} seekTs={seekTs} />
      );
      const el = mount(at(null));
      expect(el.querySelector('.sys-sum')?.getAttribute('aria-expanded')).toBe('false');
      rerender(at(line.ts));
      const sum = el.querySelector<HTMLButtonElement>('.sys-sum')!;
      expect(sum.getAttribute('aria-expanded')).toBe('true');
      expect(scrolledTo).toHaveLength(1);
      expect(scrolledTo[0].matches(`.sys-line[data-mid="${line.id}"]`)).toBe(true);
      // Opened as the reader's own state: it can still be closed while the seek is held, and a
      // later render of the same seek does not force it back open under them.
      act(() => sum.click());
      expect(sum.getAttribute('aria-expanded')).toBe('false');
      rerender(at(line.ts));
      expect(sum.getAttribute('aria-expanded')).toBe('false');
    } finally {
      Element.prototype.scrollIntoView = real;
    }
  });

  it('opens itself while a search is on, so a match inside is not hidden behind the fold', () => {
    const el = mount(chat(fanOut()));
    const input = el.querySelector<HTMLInputElement>('input.search')!;
    act(() => {
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
      set.call(input, 'scout');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(el.querySelectorAll('.sys-list .sys-line').length).toBeGreaterThan(0);
  });
});

describe('the activity strip reads at any session length', () => {
  const bucket = (t: number, tools = 1) => ({ t, says: 0, tools, thinks: 0, errors: 0 });
  const strip = (n: number, onSeek: (ts: number) => void = () => {}) => (
    <Timeline
      buckets={Array.from({ length: n }, (_, i) => bucket(1000 + i * 1000))}
      firstTs={1000}
      lastTs={1000 + n * 1000}
      turns={n}
      seekTs={null}
      onSeek={onSeek}
    />
  );
  const plotOf = (el: HTMLElement) => el.querySelector<HTMLElement>('.tl-plot')!;

  it('shares the width among its columns, never fewer than twenty-four ways', () => {
    // Columns used to be capped at 14px and packed left: five slivers in a corner of the track.
    expect(plotOf(mount(strip(3))).style.gridTemplateColumns).toBe('repeat(24, minmax(0, 1fr))');
    act(() => root?.unmount());
    host?.remove();
    expect(plotOf(mount(strip(60))).style.gridTemplateColumns).toBe('repeat(60, minmax(0, 1fr))');
  });

  it('names the second under the keyboard as well as under the pointer', () => {
    const el = mount(strip(5));
    const bars = el.querySelectorAll<HTMLButtonElement>('.tl-bar');
    act(() => bars[2].focus());
    expect(el.querySelector('.tl-read-box')?.textContent).toBe(bars[2].getAttribute('aria-label'));
  });

  it('keeps one tab stop, moves along it with the arrows, and seeks on a press', () => {
    const seeks: number[] = [];
    const el = mount(strip(5, (ts) => seeks.push(ts)));
    const bars = () => Array.from(el.querySelectorAll<HTMLButtonElement>('.tl-bar'));
    expect(bars().filter((b) => b.tabIndex === 0)).toHaveLength(1);
    // The newest column holds the stop until the keyboard moves it.
    expect(bars()[4].tabIndex).toBe(0);
    act(() => bars()[4].focus());
    act(() => {
      plotOf(el).dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
    });
    expect(document.activeElement).toBe(bars()[3]);
    expect(bars()[3].tabIndex).toBe(0);
    act(() => bars()[3].click());
    expect(seeks).toEqual([4000]);
  });
});

describe('the inspector as a phone sheet', () => {
  /**
   * At 390×844 the inspector was a card pinned over the room, covering 220×285 of a 378×305 room:
   * the person just tapped was under the panel about them. It is a sheet over the dock there now,
   * and a sheet has to go away the ways a sheet does.
   */
  const state = fold([agentSeen('a')]);
  const sheet = (onClose: () => void, isSheet = true) => (
    <>
      <div className="office">
        <button type="button" className="actor">a person</button>
      </div>
      <nav className="tabs">
        <button type="button">CHAT</button>
      </nav>
      <Inspector state={state} agentId="a" now={2000} onClose={onClose} sheet={isSheet} />
    </>
  );
  const down = (el: Element) =>
    act(() => {
      el.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    });

  it('closes on a tap anywhere that is not it, except the room, which answers its own taps', () => {
    let closed = 0;
    const el = mount(sheet(() => closed++));
    expect(el.querySelector('.inspector.sheet .sheet-grab')).not.toBeNull();
    down(el.querySelector('.inspector h3')!);
    expect(closed).toBe(0);
    down(el.querySelector('.office .actor')!);
    expect(closed).toBe(0);
    down(el.querySelector('.tabs button')!);
    expect(closed).toBe(1);
  });

  it('closes on Escape from inside, and hands focus back to what opened it', () => {
    let closed = 0;
    host = document.createElement('div');
    document.body.appendChild(host);
    const opener = document.createElement('button');
    host.appendChild(opener);
    opener.focus();
    const into = document.createElement('div');
    host.appendChild(into);
    root = createRoot(into);
    act(() => root!.render(sheet(() => closed++)));
    const close = into.querySelector<HTMLButtonElement>('.inspector .close')!;
    act(() => close.focus());
    act(() => {
      close.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(closed).toBe(1);
    expect(document.activeElement).toBe(opener);
  });

  it('is still the card over the room on a wider stage, with no handle and no tap-away', () => {
    let closed = 0;
    const el = mount(sheet(() => closed++, false));
    expect(el.querySelector('.inspector.sheet')).toBeNull();
    expect(el.querySelector('.sheet-grab')).toBeNull();
    down(el.querySelector('.tabs button')!);
    expect(closed).toBe(0);
  });
});

describe('OFFLINE says what to do', () => {
  it('names the socket it is retrying and the command that brings the hub back', () => {
    const el = mount(<OfflineNote url="ws://127.0.0.1:7411/ws" />);
    expect(el.textContent).toContain('ws://127.0.0.1:7411/ws');
    expect(el.textContent).toMatch(/npx|npm start|start/i);
    expect(el.querySelector('[role="status"]')).not.toBeNull();
  });
});
