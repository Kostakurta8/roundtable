import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SHOWCASE_SESSION, stageShowcase } from '../scripts/promo/showcase';
import { CLIP_DEFAULTS, clipFrames, collectSession, renderClip } from '../server/clip';
import { makeClip, parseArgs } from '../server/cli';
import type { Ev } from '../shared/events';

/**
 * `--gif`, end to end against a staged session: the real hub reads it, the real engine replays it,
 * the real scene paints it. What these pin is the part that is new — which moments a clip shows,
 * and in what order — because the painting is already pinned pixel for pixel by the room tests.
 */

let root: string;
let evs: Ev[];

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'rt-clip-'));
  stageShowcase(root);
  evs = (await collectSession(root)).evs;
}, 60_000);

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('collectSession', () => {
  it('reads the whole session through the hub, children included', () => {
    const kinds = new Set(evs.map((e) => e.kind));
    for (const k of ['userMessage', 'agentSpawn', 'toolStart', 'fileEdit', 'agentText', 'agentDone'] as const) {
      expect(kinds.has(k), k).toBe(true);
    }
    const agents = new Set(evs.flatMap((e) => ('ref' in e ? [e.ref.agentId] : [])));
    expect(agents.size).toBe(25); // the orchestrator, 6 scouts, 9 builders, 9 verifiers
  });

  it('refuses a session that does not exist, by name', async () => {
    await expect(collectSession(root, 'nope')).rejects.toThrow(/no session starting with "nope"/);
  });
});

describe('renderClip', () => {
  it('plays a nine-minute session inside the clip, on the transcripts own clock', () => {
    const c = clipFrames(evs, CLIP_DEFAULTS);
    // The hub stamps a sidecar's `agentSeen` with the moment it read it. Sorted by that stamp, a
    // session from last week ended today, and every name arrived after its owner had left.
    expect(c.realMs).toBeGreaterThan(5 * 60_000);
    expect(c.realMs).toBeLessThan(15 * 60_000);
    expect(c.windowed).toBe(false);
    expect(c.agents).toBe(25);
    expect(c.clipMs).toBeLessThanOrEqual((CLIP_DEFAULTS.seconds + 7) * 1000);
    expect(c.frames.length).toBe(Math.round(c.clipMs / (c.delayCs * 10)));
    // A whole clip rendered, as the two CLI tests below render one: two seconds alone, and more
    // than vitest's default five once the other render suites share the runner's cores.
  }, 30_000);

  it('is deterministic: the same session makes the same file', () => {
    const a = renderClip(evs, { ...CLIP_DEFAULTS, seconds: 4 });
    const b = renderClip(evs, { ...CLIP_DEFAULTS, seconds: 4 });
    expect(a.gif.equals(b.gif)).toBe(true);
  }, 30_000);

  it('cuts a session too long for the clip to its busiest stretch, unless asked for all of it', () => {
    const cut = clipFrames(evs, { ...CLIP_DEFAULTS, seconds: 3 });
    expect(cut.windowed).toBe(true);
    expect(cut.shownFrom).toBeGreaterThan(evs.reduce((m, e) => Math.min(m, e.ts), Infinity));
    expect(cut.shownTo - cut.shownFrom).toBeLessThan(cut.realMs);
    const whole = clipFrames(evs, { ...CLIP_DEFAULTS, seconds: 3, full: true });
    expect(whole.windowed).toBe(false);
  });

  it('draws a bare clip that differs only where the transcripts wrote something', () => {
    const plain = clipFrames(evs, { ...CLIP_DEFAULTS, seconds: 4 });
    const bare = clipFrames(evs, { ...CLIP_DEFAULTS, seconds: 4, bare: true });
    expect(bare.frames.length).toBe(plain.frames.length);
    // The first frame holds the task on the whiteboard; bare must not.
    expect(bare.frames[0]).not.toEqual(plain.frames[0]);
  });
});

describe('--gif', () => {
  it('parses its options', () => {
    const o = parseArgs(['--gif', '--out', 'x.gif', '--session', 'abc', '--seconds', '12', '--bare', '--full'], {});
    expect(o).toMatchObject({ gif: true, out: 'x.gif', session: 'abc', seconds: 12, bare: true, full: true, unknown: null });
    expect(parseArgs(['--gif', '--seconds', '999'], {}).seconds).toBe(60);
    expect(parseArgs(['--gif', '--seconds', 'x'], {}).seconds).toBe(CLIP_DEFAULTS.seconds);
  });

  it('lets --demo win over --session, as it does over --root', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'rt-gifdemo-'));
    try {
      const msg = await makeClip(parseArgs(['--gif', '--demo', '--session', 'not-a-real-session', '--seconds', '3'], {}), cwd);
      expect(readFileSync(join(cwd, 'roundtable-demo.gif')).subarray(0, 6).toString('ascii')).toBe('GIF89a');
      expect(msg).toContain('the staged demo session');
      expect(msg).not.toContain('--bare'); // nothing of the user's is in a staged clip
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  }, 60_000);

  it('writes the file it names and says what is in it', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'rt-gifout-'));
    try {
      const msg = await makeClip({ ...parseArgs(['--gif', '--root', root, '--seconds', '4'], {}) }, cwd);
      const file = join(cwd, `roundtable-${SHOWCASE_SESSION.slice(0, 8)}.gif`);
      expect(readFileSync(file).subarray(0, 6).toString('ascii')).toBe('GIF89a');
      expect(msg).toContain(file);
      expect(msg).toMatch(/\d+ agents · [\d.]+M tokens · the busiest /);
      // A real session's clip carries its text, and the command says so before anybody posts it.
      expect(msg).toContain('--bare');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  }, 60_000);
});
