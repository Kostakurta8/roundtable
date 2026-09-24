/** @vitest-environment jsdom */

/**
 * The seam the hosted demo plugs into: `useRtStream` fed by `feedFrom` instead of a socket.
 *
 * `tests/demo.test.ts` proves the player delivers the right frames at the right times. This proves
 * the other half — that the stream treats them exactly as it treats a hub's, all the way through a
 * loop restart: the recording is the committed one, played through the real hook into the real
 * store, and the second pass has to rebuild each session rather than stack on top of the first.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEMO_SPEED, HOLD_MS, parseRecording } from '../src/demo/playback';
import { demoPace, playDemo } from '../src/demo/source';
import { displayPhase, MAIN, roster, workingAgents } from '../src/store';
import { DEMO_CAPTION, caption } from '../src/ui/ShareDialog';
import { TopBar } from '../src/ui/TopBar';
import { feedFrom, useRtStream, type EvSink, type RtStream } from '../src/ws';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// One pass, on the page's clock: the recording's own length, at whatever speed the page plays it.
const SPAN = parseRecording(JSON.parse(readFileSync(join('src', 'demo', 'recording.json'), 'utf8'))).span / DEMO_SPEED;
/** The showcase, and the small session beside it that gives the page its tabs. */
const A = '9b1c2d3e-4f50-4617-8a9b-0c1d2e3f4a5b';
const B = '4e7a0c19-2b8d-4f63-9a15-7c3e8d2b6f01';

let latest: RtStream | null = null;
const resets: (string | null)[] = [];
const sink: EvSink = { ev: () => {}, reset: (id) => resets.push(id) };

function Probe() {
  latest = useRtStream(null, sink);
  return null;
}

let root: Root | null = null;
let host: HTMLDivElement | null = null;

/** Time passes in steps, as it does for a page: each step lets React commit what the timers queued. */
const advance = (ms: number, step = 250): void => {
  for (let done = 0; done < ms; done += step) act(() => vi.advanceTimersByTime(Math.min(step, ms - done)));
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-09-24T12:00:00Z'));
  // A socket would be a bug here: there is no hub, and there must be no attempt to reach one.
  vi.stubGlobal('WebSocket', function NoSocket() {
    throw new Error('the demo opened a WebSocket');
  });
  feedFrom(playDemo);
  resets.length = 0;
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root!.render(<Probe />));
});

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  latest = null;
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('the stream, fed by the demo recording', () => {
  it('is connected from the first frame, with both sessions and no socket', () => {
    advance(500);
    expect(latest!.connected).toBe(true);
    expect(latest!.sessions.map((s) => s.name)).toEqual(['billing-3', 'invoices-web-4']);
    expect(Object.keys(latest!.states).sort()).toEqual([A, B].sort());
    expect(latest!.replaying[A]).toBe(false);
  });

  it('says every event happened now, not when it was recorded', () => {
    const start = Date.now();
    advance(20_000);
    const a = latest!.states[A];
    expect(a.lastTs).toBeGreaterThan(start);
    expect(a.lastTs).toBeLessThanOrEqual(Date.now());
    expect(latest!.sessions[0].mtime).toBeGreaterThan(start - 1000);
  });

  it('starts over after the hold, rebuilding each session instead of adding to it', () => {
    advance(SPAN);
    const first = latest!.states[A];
    const agents = Object.keys(first.agents).length;
    expect(agents).toBeGreaterThan(15);
    expect(first.totalTok).toBeGreaterThan(0);

    // Held on the last moment: nothing moves, nothing is reset.
    advance(HOLD_MS - 500);
    expect(latest!.states[A]).toBe(first);
    // Opening the stream, then the hub's own reset before each session's backlog, as recorded.
    expect(resets).toEqual([null, A, B]);

    // Into the second pass: each room told to reset, the fold started again from the top.
    advance(2000);
    // The player's rewind for each session, then the recording's own resets again.
    expect(resets).toEqual([null, A, B, A, B, A, B]);
    const early = latest!.states[A];
    expect(Object.keys(early.agents).length).toBeLessThan(agents);
    expect(early.totalTok).toBeLessThan(first.totalTok);

    // And at the end of the second pass, the same session as the first, counted once.
    advance(SPAN);
    const second = latest!.states[A];
    expect(Object.keys(second.agents).length).toBe(agents);
    expect(second.totalTok).toBe(first.totalTok);
    expect(second.cost).toBeCloseTo(first.cost, 10);
    expect(second.lastSeq).toBeGreaterThan(first.lastSeq);
    expect(second.lastTs).toBeGreaterThan(first.lastTs);
  });

  /**
   * The panels judge "working" against `Date.now()`, with windows sized for a real session's pace.
   * The timelapse moves faster than any real session, so it has to land on the right side of both:
   * people at their desks read as working while they are, and as finished once they have gone.
   */
  it('shows people working mid-run and nobody left working at the end, by the panels’ own clock', () => {
    advance(30_000);
    const mid = latest!.states[A];
    const busy = workingAgents(mid, Date.now());
    expect(busy.length).toBeGreaterThanOrEqual(4);
    // Between two tools the store itself says idle; what must not happen is the clock saying it.
    for (const a of busy) expect(displayPhase(a, Date.now()).phase).toBe(a.phase);
    expect(busy.some((a) => a.phase !== 'idle')).toBe(true);

    advance(SPAN - 30_000);
    const end = latest!.states[A];
    expect(workingAgents(end, Date.now())).toEqual([]);
    const left = roster(end).filter((a) => a.id !== MAIN);
    expect(left.length).toBe(24);
    for (const a of left) expect(displayPhase(a, Date.now()).phase).toBe('done');
  });

  it('stops playing when the stream is torn down', () => {
    advance(2000);
    act(() => root!.unmount());
    root = null;
    const before = resets.length;
    advance(SPAN + HOLD_MS + 5000, 5000);
    expect(resets.length).toBe(before);
  });
});

describe('the status pill, over a recording', () => {
  // What a screen reader hears is the text, not what CSS paints over it: the pill has to *say* it.
  it('says REPLAY, not LIVE', () => {
    const noop = (): void => {};
    const box = document.createElement('div');
    document.body.appendChild(box);
    const r = createRoot(box);
    act(() =>
      r.render(
        <TopBar
          sessions={[]}
          sessionId={null}
          onPick={noop}
          connected
          replaying={false}
          totalTok={0}
          cost={0}
          costPartial={false}
          agents={0}
          theme={{ choice: 'auto', resolved: 'light', set: noop, cycle: noop }}
          dockOpen
          onToggleDock={noop}
          onOpenPalette={noop}
          onOpenHelp={noop}
          seekTs={null}
          onResumeLive={noop}
          onRescan={noop}
        />,
      ),
    );
    expect(box.querySelector('.pill-live')?.textContent).toBe('REPLAY');
    act(() => r.unmount());
    box.remove();
  });
});

describe('the banner, over the committed recording', () => {
  // A timelapse labelled with a speed factor would let a visitor believe the rest is real time.
  it('calls the replay a timelapse and says the silences were shortened', () => {
    const pace = demoPace();
    expect(pace.label).toBe('TIMELAPSE');
    expect(pace.title).toMatch(/silences .* shortened/);
    expect(pace.title).not.toMatch(/\d×/);
  });
});

describe('the share caption, over a recording', () => {
  // Posted under somebody's own name: "my subagents" about a staged session would be theirs to retract.
  it('says the clip is a staged replay, and links the page it came from', () => {
    expect(caption()).toBe(DEMO_CAPTION);
    expect(DEMO_CAPTION).not.toMatch(/\bmy\b/i);
    expect(DEMO_CAPTION).toContain('staged replay');
    expect(DEMO_CAPTION).toContain('https://kostakurta8.github.io/roundtable/');
  });
});
