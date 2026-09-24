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
import { playDemo } from '../src/demo/source';
import { feedFrom, useRtStream, type EvSink, type RtStream } from '../src/ws';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// The page plays the recording faster than it was made, so one pass takes this long on its clock.
const SPAN = parseRecording(JSON.parse(readFileSync(join('src', 'demo', 'recording.json'), 'utf8'))).span / DEMO_SPEED;
const A = 'demo-7f2a91';
const B = 'demo-9c4d20';

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
    expect(latest!.sessions.map((s) => s.name)).toEqual(['pathfinder-1', 'pathfinder-api-2']);
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

  it('stops playing when the stream is torn down', () => {
    advance(2000);
    act(() => root!.unmount());
    root = null;
    const before = resets.length;
    advance(SPAN + HOLD_MS + 5000, 5000);
    expect(resets.length).toBe(before);
  });
});
