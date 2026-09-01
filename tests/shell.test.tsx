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
import { Chat } from '../src/chat/Chat';
import { initialState, reduce, type RtState } from '../src/store';
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

describe('OFFLINE says what to do', () => {
  it('names the socket it is retrying and the command that brings the hub back', () => {
    const el = mount(<OfflineNote url="ws://127.0.0.1:7411/ws" />);
    expect(el.textContent).toContain('ws://127.0.0.1:7411/ws');
    expect(el.textContent).toMatch(/npx|npm start|start/i);
    expect(el.querySelector('[role="status"]')).not.toBeNull();
  });
});
