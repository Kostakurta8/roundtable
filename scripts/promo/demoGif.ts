/**
 * `media/roundtable-demo.gif`: the README's "whole app" clip, filmed and encoded in one command.
 *
 *   npm run build && npx tsx scripts/promo/demoGif.ts
 *   npx tsx scripts/promo/demoGif.ts --keep=<dir>   # also leave the raw take in <dir>
 *   npx tsx scripts/promo/demoGif.ts --cut=<dir>    # re-cut a kept take without filming again
 *
 * `CHROMIUM_PATH` points it at a browser other than Playwright's own.
 *
 * The first version of this clip was cut out of the trailer's take with ffmpeg, captions and all,
 * and it went stale the moment the shell changed: the room stopped filling its stage, the roster
 * became a strip, the feed learned to fold, and the GIF went on showing the old app. This makes the
 * next one a command rather than an afternoon — and one that needs nothing the package does not
 * already have. ffmpeg is not a dependency and is not on every machine that has this repo, so the
 * frames are Playwright screenshots, read back by the few dozen lines of PNG decoding below, and
 * encoded by the app's own `src/clip/gif.ts`, the same encoder the Share button and `--gif` use.
 *
 * What is filmed is `claude-roundtable --demo`, not a set built for the camera: `run()` from
 * `server/cli.ts` stages the demo room into a fresh temp directory and serves the built client,
 * exactly as the installed binary does, on a loopback port the operating system picks — so filming
 * never collides with an app already on 7411, or with anybody else's demo. The hub's timing is left
 * at its shipped defaults, as it is for every viewer of `--demo`.
 *
 * The beats are found, not assumed. A socket beside the page's hears the same events the page
 * does, and the cut hangs off the moments they arrived — the first spawn, the fan-out, the first
 * report, the two verdicts — the way `cut.ts` hangs the trailer off `marks.json`. A change to the
 * demo's schedule moves the marks, and the same clip comes out.
 *
 * The page is filmed at 960x640 and the GIF is that size, pixel for pixel. That is the narrowest
 * window that still lays the app out as it is used — room and feed side by side, the roster strip
 * under the room, the activity strip under both (at 900 it stacks; at 620 tall the strip goes) — and
 * only a little wider than the column GitHub gives a README image, so it is shrunk slightly there
 * rather than a lot. Filming wider and scaling down would resample every glyph and every pixel of
 * the room.
 */
import { chromium, type Page } from '@playwright/test';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import { inflateSync } from 'node:zlib';
import { WebSocket } from 'ws';
import { isEv } from '../../shared/events';
import { parseArgs, run } from '../../server/cli';
import { encodeGif, type RgbFrame } from '../../src/clip/gif';
import { DEMO_SESSIONS } from './demoRoom';

const VIEW = { width: 960, height: 640 };
/**
 * 12.5 fps, the timelapse's rate: smooth enough that a walk reads as a walk at 4x, and well clear of
 * the 2cs below which browsers stop honouring a GIF's delay at all.
 */
const FRAME_CS = 8;
const OUT = join('media', 'roundtable-demo.gif');
const CLIENT = join('dist', 'client');

type Mark = 'arrive' | 'fanout' | 'report' | 'refuted' | 'confirmed';
const MARKS: readonly Mark[] = ['arrive', 'fanout', 'report', 'refuted', 'confirmed'];

/**
 * The cut, as one speed ramp. From each key to the next the take plays `speed` times faster than it
 * happened; the last key is where the clip ends. Each key hangs off a mark, `at` seconds after it.
 *
 * One continuous timelapse rather than a string of shots: a jump cut in a room this small reads as
 * everybody teleporting. Walking runs fast, stretches where nothing moves but thought bubbles run
 * very fast, and the two verdicts run at the speed they happened, long enough to read. The elapsed
 * clock under the room keeps session time throughout, so nothing pretends the minute took twenty
 * seconds.
 *
 * The slow-downs are where a verdict's bubble appears in the room, which is when its speaker has
 * finished walking over to `main`: 3.7s after the line is written from the far desk, 3.1s from the
 * near one. Each then gets three seconds, which is the bubble typing itself out and a beat to read.
 */
type Key = { mark: Mark; at: number; speed: number };
const RAMP: readonly Key[] = [
  // `main` takes its desk, and three scouts walk in through the door and sit down.
  { mark: 'arrive', at: -0.7, speed: 4 },
  { mark: 'arrive', at: 9.5, speed: 12 },
  // The fan-out: the camera widens for the new desks as three more walk in.
  { mark: 'fanout', at: 0.4, speed: 4 },
  { mark: 'fanout', at: 8.4, speed: 12 },
  // One scout crosses the floor to report what it found.
  { mark: 'report', at: -0.2, speed: 2.4 },
  { mark: 'report', at: 5.5, speed: 10 },
  // REFUTED: the walk over, quickly, then the verdict in real time.
  { mark: 'refuted', at: 0.1, speed: 2.4 },
  { mark: 'refuted', at: 3.7, speed: 1 },
  { mark: 'refuted', at: 6.7, speed: 8 },
  // CONFIRMED, the same way round, and the clip ends on it.
  { mark: 'confirmed', at: 0.1, speed: 2.4 },
  { mark: 'confirmed', at: 3.1, speed: 1 },
  { mark: 'confirmed', at: 6.5, speed: 1 },
];
/** How long the last frame holds before the loop starts again: the second verdict, still up. */
const HOLD_CS = 150;

type Take = {
  /** Seconds from the stage being written, per frame, in the order the files are numbered. */
  frames: number[];
  marks: Partial<Record<Mark, number>>;
};

function freePort(): Promise<number> {
  return new Promise((ok, fail) => {
    const srv = createServer();
    srv.on('error', fail);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      srv.close(() => ok(port));
    });
  });
}

/**
 * Watches the hub's broadcast for the moments the cut hangs off.
 *
 * The same frames the page gets, from the same socket endpoint: when a verdict arrives here it is
 * arriving there, give or take one poll of the watcher. The first three spawns are the scouts, the
 * fourth is the fan-out, and the first thing a subagent says that is not a verdict is the report.
 */
function listen(port: number, t0: number, marks: Partial<Record<Mark, number>>): WebSocket {
  const sock = new WebSocket(`ws://127.0.0.1:${port}/ws`, { origin: `http://localhost:${port}` });
  let spawns = 0;
  const mark = (name: Mark): void => {
    if (marks[name] !== undefined) return;
    marks[name] = (Date.now() - t0) / 1000;
    console.log(`  ▸ ${name.padEnd(9)} @ ${marks[name]?.toFixed(1)}s`);
  };
  sock.on('message', (data) => {
    let msg: unknown;
    try {
      msg = JSON.parse(String(data));
    } catch {
      return;
    }
    if (!isEv(msg) || !('ref' in msg) || msg.ref.sessionId !== DEMO_SESSIONS[0]) return;
    if (msg.kind === 'agentSpawn') {
      spawns += 1;
      if (spawns === 1) mark('arrive');
      if (spawns === 4) mark('fanout');
    } else if (msg.kind === 'agentText' && msg.ref.agentId !== 'main') {
      if (msg.text.startsWith('REFUTED')) mark('refuted');
      else if (msg.text.startsWith('CONFIRMED')) mark('confirmed');
      else mark('report');
    }
  });
  return sock;
}

/** The raw take: a screenshot as often as the browser will give one, each stamped with its moment. */
async function film(keep: string | null): Promise<{ take: Take; pngs: Buffer[] }> {
  if (!existsSync(join(CLIENT, 'index.html'))) throw new Error(`no ${CLIENT}/index.html — run \`npm run build\` first`);
  const port = await freePort();
  const t0 = Date.now();
  const served = await run({ ...parseArgs(['--demo', '--no-open']), port }, resolve(CLIENT));
  console.log(`[film] --demo on 127.0.0.1:${port}, staged in ${served.root}`);
  const marks: Partial<Record<Mark, number>> = {};
  const sock = listen(port, t0, marks);

  const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
  const pngs: Buffer[] = [];
  const frames: number[] = [];
  try {
    const context = await browser.newContext({ viewport: VIEW, deviceScaleFactor: 1, colorScheme: 'light' });
    await context.addInitScript((pin: string) => {
      // The first-visit guide is the right thing for a first visit and the wrong thing for a clip
      // about everything else. The busy session rather than whichever transcript was touched last,
      // and an explicit theme, so the take does not depend on the host's dark-mode setting.
      localStorage.setItem('rt.guide', 'seen');
      localStorage.setItem('rt.pinned', pin);
      localStorage.setItem('roundtable.theme', 'day');
    }, DEMO_SESSIONS[0]);
    const page: Page = await context.newPage();
    await page.goto(`http://localhost:${port}/`);
    await page.locator('.topbar .pill-live').filter({ hasText: 'LIVE' }).waitFor({ timeout: 15_000 });
    // Straight to the protocol rather than `page.screenshot`, which waits on fonts and settles the
    // page before every shot: on a busy four-core machine that was the difference between 11 frames
    // a second and 18, and the verdicts play at 1x, where the GIF wants 12.5.
    const cdp = await context.newCDPSession(page);

    // Until the end of the cut, and a ceiling so a schedule change that loses a mark cannot film
    // for ever.
    const last = RAMP[RAMP.length - 1];
    const ceiling = Date.now() + 120_000;
    for (;;) {
      const before = Date.now();
      const shot = await cdp.send('Page.captureScreenshot', { format: 'png', optimizeForSpeed: true });
      const png = Buffer.from(shot.data, 'base64');
      // The middle of the call is the best guess at the moment the frame shows.
      frames.push(((before + Date.now()) / 2 - t0) / 1000);
      pngs.push(png);
      const end = marks[last.mark];
      if (end !== undefined && frames[frames.length - 1] > end + last.at + 0.5) break;
      if (Date.now() > ceiling) throw new Error(`no ${MARKS.filter((m) => marks[m] === undefined).join(', ')} mark in two minutes`);
    }
    await context.close();
  } finally {
    await browser.close();
    sock.close();
    await served.stop();
  }
  const span = frames[frames.length - 1] - frames[0];
  console.log(`[film] ${pngs.length} frames over ${span.toFixed(1)}s — ${(pngs.length / span).toFixed(1)} fps`);

  const take: Take = { frames, marks };
  if (keep) {
    mkdirSync(keep, { recursive: true });
    pngs.forEach((png, i) => writeFileSync(join(keep, `${String(i).padStart(5, '0')}.png`), png));
    writeFileSync(join(keep, 'take.json'), JSON.stringify(take, null, 2));
    console.log(`[film] take kept in ${keep}`);
  }
  return { take, pngs };
}

function readTake(dir: string): { take: Take; pngs: Buffer[] } {
  const take = JSON.parse(readFileSync(join(dir, 'take.json'), 'utf8')) as Take;
  const pngs = take.frames.map((_, i) => readFileSync(join(dir, `${String(i).padStart(5, '0')}.png`)));
  return { take, pngs };
}

/**
 * Just enough PNG to read Chromium's screenshots back: 8-bit RGB or RGBA, not interlaced, into the
 * packed `0xRRGGBB` the encoder takes. Anything else is refused rather than misread.
 */
function decodePng(png: Buffer): { width: number; height: number; px: RgbFrame } {
  if (png.readUInt32BE(0) !== 0x89504e47) throw new Error('PNG: no PNG signature');
  let width = 0;
  let height = 0;
  let bpp = 0;
  const idat: Buffer[] = [];
  for (let p = 8; p < png.length; ) {
    const len = png.readUInt32BE(p);
    const type = png.toString('ascii', p + 4, p + 8);
    const data = png.subarray(p + 8, p + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      const [depth, color, , , interlace] = [data[8], data[9], data[10], data[11], data[12]];
      if (depth !== 8 || (color !== 2 && color !== 6) || interlace !== 0) {
        throw new Error(`PNG: depth ${depth}, colour type ${color}, interlace ${interlace} — not a screenshot this reads`);
      }
      bpp = color === 6 ? 4 : 3;
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    p += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * bpp;
  const px = new Uint32Array(width * height);
  let line = new Uint8Array(stride);
  let prior = new Uint8Array(stride);
  for (let y = 0; y < height; y++) {
    const at = y * (stride + 1);
    const filter = raw[at];
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? line[i - bpp] : 0;
      const b = prior[i];
      const c = i >= bpp ? prior[i - bpp] : 0;
      let v = raw[at + 1 + i];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const pa = Math.abs(b - c);
        const pb = Math.abs(a - c);
        const pc = Math.abs(a + b - 2 * c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      line[i] = v & 255;
    }
    for (let x = 0, o = y * width; x < width; x++) {
      const i = x * bpp;
      px[o + x] = (line[i] << 16) | (line[i + 1] << 8) | line[i + 2];
    }
    [line, prior] = [prior, line];
  }
  return { width, height, px };
}

/**
 * The ramp, as the take's frames it shows: the nearest frame to each tick of the output clock.
 *
 * The clock is carried across keys rather than restarted at each, so a ramp with no gap in it has
 * no seam either — a tick that falls a fraction past a key is played at the next key's speed.
 */
function cut(take: Take): { pick: number[]; seconds: number } {
  const when = (k: Key): number => {
    const base = take.marks[k.mark];
    if (base === undefined) throw new Error(`cut: the take has no ${k.mark} mark`);
    return base + k.at;
  };
  const tick = FRAME_CS / 100;
  const pick: number[] = [];
  let nearest = 0;
  let t = when(RAMP[0]);
  for (let k = 0; k + 1 < RAMP.length; k++) {
    const { speed } = RAMP[k];
    const to = when(RAMP[k + 1]);
    const first = pick.length;
    for (; t < to; t += tick * speed) {
      while (nearest + 1 < take.frames.length && Math.abs(take.frames[nearest + 1] - t) <= Math.abs(take.frames[nearest] - t)) nearest++;
      while (nearest > 0 && Math.abs(take.frames[nearest - 1] - t) < Math.abs(take.frames[nearest] - t)) nearest--;
      pick.push(nearest);
    }
    const shown = (pick.length - first) * tick;
    console.log(`  ${RAMP[k].mark.padEnd(9)} ${when(RAMP[k]).toFixed(1)}–${to.toFixed(1)}s at ${speed}× → ${shown.toFixed(1)}s`);
  }
  return { pick, seconds: (pick.length * FRAME_CS + HOLD_CS - FRAME_CS) / 100 };
}

async function main(): Promise<void> {
  const flag = (name: string): string | null => {
    const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
    return hit ? hit.slice(name.length + 3) : null;
  };
  const reuse = flag('cut');
  const { take, pngs } = reuse ? readTake(reuse) : await film(flag('keep'));

  const { pick, seconds } = cut(take);
  const frames: RgbFrame[] = [];
  let size = { width: 0, height: 0 };
  const decoded = new Map<number, RgbFrame>();
  for (const i of pick) {
    let px = decoded.get(i);
    if (!px) {
      const png = decodePng(pngs[i]);
      size = { width: png.width, height: png.height };
      px = png.px;
      decoded.set(i, px);
    }
    frames.push(px);
  }
  const gif = encodeGif({ ...size, frames, delayCs: FRAME_CS, holdLastCs: HOLD_CS, scale: 1 });
  const out = flag('out') ?? OUT;
  writeFileSync(out, gif);
  console.log(`[gif] ${out} — ${size.width}×${size.height}, ${frames.length} frames, ${seconds.toFixed(1)} s, ${(gif.length / 1024 / 1024).toFixed(2)} MB`);
  // chokidar's poller is not ours to wait on, and the hub is already stopped.
  process.exit(0);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
