import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inflateSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SHOWCASE_SESSION, stageShowcase } from '../scripts/promo/showcase';
import { collectSession } from '../server/clip';
import { makeCard, parseArgs } from '../server/cli';
import { renderCard } from '../src/clip/card';

/**
 * `--card`, end to end against a staged session: the real hub reads it and the dialog's own
 * renderer draws it. What is new here is only the file — so what is pinned is that the PNG holds
 * exactly the pixels `renderCard` makes of the same events, which is the promise that the terminal
 * and the Share dialog make the same card.
 */

let root: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'rt-cardcli-'));
  stageShowcase(root);
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

/** A truecolour PNG's size and pixels, read back with nothing but zlib — filter 0 on every row. */
function readPng(buf: Buffer): { width: number; height: number; rgba: Buffer } {
  expect(buf.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  let o = 8;
  let width = 0;
  let height = 0;
  const idat: Buffer[] = [];
  while (o < buf.length) {
    const len = buf.readUInt32BE(o);
    const type = buf.subarray(o + 4, o + 8).toString('ascii');
    const body = buf.subarray(o + 8, o + 8 + len);
    if (type === 'IHDR') {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
    } else if (type === 'IDAT') idat.push(body);
    o += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const rgba = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) raw.copy(rgba, y * width * 4, y * (width * 4 + 1) + 1, (y + 1) * (width * 4 + 1));
  return { width, height, rgba };
}

describe('--card', () => {
  it('writes the card the dialog would make of the same session, and says what is on it', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'rt-cardout-'));
    try {
      const msg = await makeCard(parseArgs(['--card', '--root', root], {}), cwd);
      const file = join(cwd, `roundtable-${SHOWCASE_SESSION.slice(0, 8)}-card.png`);
      const png = readPng(readFileSync(file));
      expect([png.width, png.height]).toEqual([1200, 630]);
      const same = renderCard((await collectSession(root)).evs, { bare: false });
      expect(png.rgba.equals(Buffer.from(same.rgba.buffer))).toBe(true);
      expect(msg).toContain(file);
      expect(msg).toMatch(/1200×630 · \d+ KB · 24 subagents \(\d+ at once\), [\d.]+M tokens, \d+m \d\ds · est \$/);
      // A real session's card carries its text, and the command says so before anybody posts it.
      expect(msg).toContain('--bare');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  }, 60_000);

  it('lets --demo win over --session, and names the file for the demo', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'rt-carddemo-'));
    try {
      const msg = await makeCard(parseArgs(['--card', '--demo', '--bare', '--session', 'not-a-real-session'], {}), cwd);
      expect(readPng(readFileSync(join(cwd, 'roundtable-demo-card.png'))).width).toBe(1200);
      expect(msg).toContain('the staged demo session');
      expect(msg).not.toContain('Look before you post'); // nothing of the user's is on a staged card
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  }, 60_000);
});
