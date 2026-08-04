/**
 * The take.
 *
 * One continuous Playwright recording of the real app, driven by transcript lines this process
 * writes to a synthetic root (`stage.ts`). Every beat in `docs/promo/PLAN.md` happens once, in
 * order, and the moment each one starts is written to `marks.json` — so cutting the trailer is
 * arithmetic on that file rather than somebody scrubbing a timeline by eye, and a retake is
 * `npx tsx scripts/promo/record.ts` rather than an improvisation.
 *
 * Why one take and not one recording per beat: a `BrowserContext` per beat would reload the page
 * each time, and a reload replays the whole backlog — the entire cast walks in through the door
 * again before anything else can happen. That is a nice shot exactly once. It is also the reason
 * the room accumulates here: agents arrive and are never reset, which is what a session actually
 * looks like.
 *
 * Requirements: Vite on 5173 (`npx vite --port 5173 --strictPort`) and **nothing** on 7411 — this
 * process owns the hub, pointed at the staged root instead of `~/.claude`.
 */
import { chromium, type Page } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { startServer } from '../../server/hub';
import { MODEL, MODEL_ALT, Stage, say, task, thinking, toolUse } from './stage';

const PORT = 7411;
const APP = 'http://localhost:5173';

const OUT = join(homedir(), 'Desktop', 'roundtable promo');
const RAW = join(OUT, 'raw');
const STILLS = join(OUT, 'presskit', 'stills');
const ROOT = join(
  homedir(),
  'AppData',
  'Local',
  'Temp',
  'claude',
  'C--Users-dev',
  'fb9550e1-3336-40fc-9408-dfdacb7b6e58',
  'scratchpad',
  'promo-root',
);

/**
 * Shortened from `AGENT_QUIET_MS = 45_000`. Declared in PLAN.md: it changes how long an agent's
 * transcript must be still before the hub believes it stopped, and nothing else. The behaviour on
 * camera — finishing means giving up the chair and leaving — is the shipped behaviour.
 */
const QUIET_MS = 8_000;
/** Same reasoning for an agent that stops mid-tool; 45s of nobody moving is not a trailer. */
const OPEN_GRACE_MS = 20_000;

const A = 'obs-7f2a91';
const B = 'obs-9c4d20';

/**
 * Agent ids are hex-ish on purpose.
 *
 * `mapping.ts:130` routes a verdict to whichever roster id appears in its text, matched on
 * word boundaries. Ids like `docs` or `perf` would make "REFUTED: the docs are stale" walk to the
 * wrong desk — an English word for an id is a trap the real CLI does not set, and the trailer
 * should not set it either. What the room actually prints is the sidecar's `description`.
 */
const AGENTS = [
  { id: 'a7f2c1', desc: 'map the retry paths', type: 'Explore' },
  { id: 'b3e94d', desc: 'hunt races in the scheduler', type: 'general-purpose' },
  { id: 'c81a05', desc: 'read the backoff implementation', type: 'Explore' },
  { id: 'd5f620', desc: 'profile the cold start', type: 'general-purpose' },
  { id: 'e04b7c', desc: 'sweep the type errors', type: 'general-purpose' },
  { id: 'f19d38', desc: 'review the auth middleware', type: 'code-reviewer' },
] as const;

/** The overflow. `MAX_SEATS` is 13 (`src/office/engine.ts:260`), so this puts four outside. */
const CROWD = Array.from({ length: 11 }, (_, i) => ({
  id: `c${String(i + 20).padStart(2, '0')}a`,
  desc: ['verify a finding', 'refute a finding', 'check one call site'][i % 3],
  type: 'general-purpose',
}));

const marks: { name: string; at: number }[] = [];
let t0 = 0;
const mark = (name: string): void => {
  const at = (Date.now() - t0) / 1000;
  marks.push({ name, at });
  console.log(`  ▸ ${name.padEnd(18)} @ ${at.toFixed(1)}s`);
};

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Drives the room's own camera.
 *
 * The alternative — cropping the finished video and scaling back up — is a fake zoom that softens
 * every glyph in the UI. This is the real one: the camera eases toward its target a fifth of the
 * remaining distance per frame, so the move is smooth by itself and everything stays rendered at
 * full resolution. It is also a feature, so filming it is filming the product.
 *
 * `=` rather than `+`: same key in the room's handler, and it needs no shift.
 */
async function camera(page: Page, key: '=' | '-' | 'Home', times = 1): Promise<void> {
  for (let i = 0; i < times; i++) {
    await page.locator('.office.pixel').press(key);
    await wait(140);
  }
  const z = await page.locator('.cam-z').textContent();
  console.log(`  · camera ${key}×${times} → ${z?.trim() ?? '?'}`);
}

async function shot(page: Page, name: string): Promise<void> {
  // `scale: 'css'` so a still is 1920×1080 rather than the 3840×2160 the 2× backing store would
  // give — the press kit wants the delivered size, and the room is drawn at integer scale either
  // way.
  await page.screenshot({ path: join(STILLS, `${name}.png`), scale: 'css' });
  console.log(`  · still ${name}`);
}

async function main(): Promise<void> {
  for (const d of [OUT, RAW, STILLS]) mkdirSync(d, { recursive: true });

  // ---------------------------------------------------------------- the set, before the hub
  const stage = new Stage(ROOT);
  stage.addSession({ sessionId: A, slug: 'C--work-pathfinder', cwd: 'C:\\work\\pathfinder', name: 'pathfinder-1' });
  stage.addSession({
    sessionId: B,
    slug: 'C--work-pathfinder-api',
    cwd: 'C:\\work\\pathfinder-api',
    name: 'pathfinder-api-2',
  });
  stage.register(A, process.pid);
  stage.register(B, process.pid);

  stage.human(A, 'audit the release branch before we ship — I want a verdict on every risk you find');
  stage.assistant(
    A,
    [
      thinking('the retry path is the one nobody has read since it was written'),
      say('Fanning out: scouts first, then a verifier on anything they claim.'),
      toolUse('tu-grep-1', 'Grep', { pattern: 'retryWithBackoff', path: 'src' }),
    ],
    { tokens: { in: 4200, out: 380, cacheRead: 18_000 } },
  );
  stage.toolResult(A, 'tu-grep-1', '11 matches across 4 files');
  stage.assistant(
    A,
    AGENTS.slice(0, 3).map((a, i) => task(`tu-task-${i + 1}`, a.desc, a.type)),
    { tokens: { in: 5100, out: 260, cacheRead: 22_000 } },
  );
  AGENTS.slice(0, 3).forEach((a, i) => {
    stage.spawn(A, a.id, { toolUseId: `tu-task-${i + 1}`, description: a.desc, agentType: a.type, prompt: a.desc });
  });

  stage.human(B, 'get the contract tests green on the api branch');
  stage.assistant(B, [say('Reading the failing contract first.'), toolUse('tb-1', 'Read', { file_path: 'api/contract.ts' })], {
    model: MODEL,
    tokens: { in: 2800, out: 190 },
  });

  const aliveA: string[] = AGENTS.slice(0, 3).map((a) => a.id);
  const aliveB: string[] = [];

  // ---------------------------------------------------------------------------- the hub
  const stop = await startServer(ROOT, PORT, {
    usePolling: true,
    interval: 200,
    quietMs: QUIET_MS,
    openGraceMs: OPEN_GRACE_MS,
    onError: (err, ctx) => console.error(`[hub] ${ctx}:`, err),
  });
  console.log(`[hub] observing the staged root ${ROOT}`);

  // Registrations go stale after 90s (`LIVE_WINDOW_MS`) and the take is longer than that, so the
  // tab strip would vanish mid-shot without this. The keepalive beside it is what stops the rest
  // of the cast walking out while a beat about somebody else plays; see `Stage.keepAlive`.
  const ticker = setInterval(() => {
    stage.heartbeat(process.pid);
    stage.keepAlive(A, aliveA);
    stage.keepAlive(B, aliveB);
  }, 3000);

  // ------------------------------------------------------------------------- the camera
  const browser = await chromium.launch();
  const context = await browser.newContext({
    viewport: { width: 1920, height: 1080 },
    // 1080 / 270 = 4, and at 2× the 480×270 buffer lands on an exact 8× integer scale, so the
    // pixel art is never resampled on its way to the file.
    deviceScaleFactor: 2,
    colorScheme: 'light',
    recordVideo: { dir: RAW, size: { width: 1920, height: 1080 } },
  });
  await context.addInitScript((pin: string) => {
    // Deterministic boot: the pinned session rather than whichever transcript was touched last,
    // and an explicit theme so `auto` cannot make the take depend on the host's dark-mode setting.
    localStorage.setItem('rt.pinned', pin);
    localStorage.setItem('roundtable.theme', 'day');
  }, A);

  const page = await context.newPage();
  page.setDefaultTimeout(30_000);
  t0 = Date.now();
  await page.goto(APP);
  await page.locator('.topbar .pill-live').filter({ hasText: 'LIVE' }).waitFor();
  mark('connected');

  // ---------------------------------------------------------------- 1. cold open
  await page.locator('.actor').nth(3).waitFor();
  await wait(4000);
  stage.agentSays(A, AGENTS[0].id, [thinking('the backoff and the request timeout share one clock')]);
  stage.agentSays(A, AGENTS[1].id, [toolUse('t-b-1', 'Grep', { pattern: 'setTimeout', path: 'src/scheduler' })]);
  stage.agentSays(A, AGENTS[2].id, [toolUse('t-c-1', 'Read', { file_path: 'src/scheduler/retry.ts' })]);
  mark('cold-open');
  await wait(11_000);

  // ---------------------------------------------------------------- 2. fan-out
  stage.assistant(
    A,
    AGENTS.slice(3).map((a, i) => task(`tu-task-${i + 4}`, a.desc, a.type)),
    { tokens: { in: 6400, out: 340, cacheRead: 31_000 } },
  );
  AGENTS.slice(3).forEach((a, i) => {
    stage.spawn(A, a.id, { toolUseId: `tu-task-${i + 4}`, description: a.desc, agentType: a.type, prompt: a.desc });
    aliveA.push(a.id);
  });
  mark('fanout');
  await page.locator('.actor').nth(6).waitFor();
  await wait(9000);
  stage.agentSays(A, AGENTS[3].id, [thinking('cold start is dominated by one synchronous read')]);
  stage.agentSays(A, AGENTS[4].id, [toolUse('t-e-1', 'Bash', { command: 'npx tsc --noEmit' })]);
  stage.agentSays(A, AGENTS[5].id, [toolUse('t-f-1', 'Read', { file_path: 'src/auth/middleware.ts' })]);
  mark('working');
  await wait(9000);

  // The push in. Two steps is 1.25² = 1.56×, which still holds main's desk and the spot a visitor
  // stands on, so the walk that follows is framed rather than merely closer.
  await camera(page, '=', 2);
  mark('zoomin');
  await wait(4000);

  // ---------------------------------------------------------------- 3. reporting back
  stage.agentToolResult(A, AGENTS[1].id, 't-b-1', '11 matches');
  stage.agentSays(A, AGENTS[1].id, [say('Three suites touch the retry path and two of them share a fixture.')], {
    tokens: { in: 3100, out: 410 },
  });
  mark('deliver');
  await wait(13_000);

  // ---------------------------------------------------------------- 4. the verdicts
  // Deliberately still 1.6×, not 2×. A third zoom step frames the speaker beautifully and pushes
  // the top line of their speech bubble outside the room's viewport — so the shot captioned
  // "Red is REFUTED" had the word REFUTED cropped off. The bubble is drawn above the speaker's
  // head, so the tightest usable zoom is the one that still has headroom.
  stage.agentToolResult(A, AGENTS[2].id, 't-c-1', 'read 240 lines');
  stage.agentSays(A, AGENTS[2].id, [say('REFUTED: the scheduler suite is not flaky. Its fixture leaks a fake timer.')], {
    tokens: { in: 5200, out: 520 },
  });
  mark('refuted');
  await wait(12_000);

  stage.agentToolResult(A, AGENTS[5].id, 't-f-1', 'read 96 lines');
  stage.agentSays(A, AGENTS[5].id, [say('CONFIRMED: the token expiry check uses < where it needs <=.')], {
    tokens: { in: 4400, out: 470 },
  });
  mark('confirmed');
  await wait(11_000);

  // The pull out. Three steps back to 1.0× plus `Home` to re-centre: the shot starts on two people
  // arguing about one line and ends on the whole floor. That reveal is the best move the room can
  // make, and it costs four keystrokes.
  await camera(page, '-', 2);
  await camera(page, 'Home');
  mark('zoomout');
  await wait(5000);

  // ---------------------------------------------------------------- 5. finishing means leaving
  // An agent holding an open tool call is *not* quiet — an unresolved call buys it a longer
  // silence on purpose (`server/hub.ts:823`), because a five-minute build looks exactly like an
  // agent that has stopped. So the type sweep's call is closed first; after that the only
  // evidence the hub has is the file's mtime, and these two simply stop being touched. Nothing is
  // written and nothing is deleted.
  //
  // Nothing may be written to them again either: `think`/`tool`/`edit`/`spawn`/`prompt` for a
  // retired agent walks it back in through the door (`src/office/engine.ts:673`), which is
  // correct behaviour and would ruin the shot.
  stage.agentToolResult(A, AGENTS[4].id, 't-e-1', 'no type errors');
  for (const gone of [AGENTS[2].id, AGENTS[4].id]) {
    const i = aliveA.indexOf(gone);
    if (i >= 0) aliveA.splice(i, 1);
  }
  mark('leaving');
  // 8s of quiet, then `DONE_LINGER_MS` (1800 + up to 4200 of per-id jitter), then the walk to the
  // door — up to about 21s all told for a far-bank desk.
  await wait(23_000);

  // ---------------------------------------------------------------- 6. more agents than chairs
  stage.assistant(
    A,
    CROWD.map((c, i) => task(`tu-crowd-${i}`, c.desc, c.type)),
    { tokens: { in: 7100, out: 640, cacheRead: 44_000 } },
  );
  CROWD.forEach((c, i) => {
    stage.spawn(A, c.id, { toolUseId: `tu-crowd-${i}`, description: c.desc, agentType: c.type, prompt: c.desc });
    aliveA.push(c.id);
  });
  mark('crowd');
  await page.locator('.ghost').first().waitFor();
  await wait(10_000);

  const ghost = page.locator('.ghost').first();
  await ghost.hover();
  mark('peek');
  await wait(4500);
  await ghost.click();
  mark('inspect');
  await wait(5000);
  await shot(page, 'timeline-crowd');
  await page.locator('.office.pixel').press('Escape');
  await wait(1500);

  // ---------------------------------------------------------------- 7. rewind
  await page.locator('.tl-bar').first().click();
  mark('scrub');
  await wait(9000);
  await page.getByRole('button', { name: /resume live/i }).first().click();
  mark('resume');
  await wait(7000);
  await shot(page, 'day');

  // ---------------------------------------------------------------- 8. two sessions
  stage.assistant(B, [task('tb-task-1', 'reproduce the contract failure', 'general-purpose')], {
    model: MODEL,
    tokens: { in: 3300, out: 210 },
  });
  stage.spawn(B, 'aa5501', {
    toolUseId: 'tb-task-1',
    description: 'reproduce the contract failure',
    agentType: 'general-purpose',
    prompt: 'reproduce the contract failure',
  });
  aliveB.push('aa5501');
  stage.agentSays(B, 'aa5501', [toolUse('tb-a-1', 'Bash', { command: 'npm run test:contract' })], { model: MODEL_ALT });

  await page.locator('.session-tabs').waitFor();
  mark('tabs');
  await wait(5000);
  // By name, never by index. The strip is ordered by the live roster, which re-sorts as sessions
  // are touched — so `nth(1)` was a different session before and after the switch, and the whole
  // back half of the first take was recorded against the wrong room without erroring once.
  await page.getByRole('tab', { name: /pathfinder-api-2/ }).click();
  mark('tab-switch');
  await wait(9000);
  await page.getByRole('tab', { name: /pathfinder-1/ }).click();
  // Assert the room actually came back, rather than assuming the click landed where it looked.
  await page.locator('.session-tab.on', { hasText: 'pathfinder-1' }).waitFor();
  await wait(6000);

  // ---------------------------------------------------------------- 9. the numbers
  stage.assistant(A, [say('Collating what came back.')], { tokens: { in: 9700, out: 880, cacheRead: 96_000, cacheWrite: 12_000 } });
  mark('numbers');
  await wait(9000);

  // ---------------------------------------------------------------- 10. night, and the help
  await page.locator('.office.pixel').press('t');
  mark('night');
  await wait(9000);
  await shot(page, 'night');

  await page.locator('.office.pixel').press('?');
  const help = page.locator('[role="dialog"]');
  if ((await help.count()) === 0) {
    console.log('  ! `?` did not open the help — falling back to the top-bar button');
    await page.getByRole('button', { name: /what am I looking at/i }).click();
  }
  await help.first().waitFor();
  mark('help');
  await wait(10_000);
  await shot(page, 'help');
  await page.keyboard.press('Escape');
  await wait(2000);

  // ---------------------------------------------------------------- 11. panels, for the stills
  await page.locator('.office.pixel').press('t'); // back to day for the panel stills
  await wait(3000);
  await page.locator('.office.pixel').press('1');
  await wait(3000);
  await shot(page, 'feed');
  await page.locator('.office.pixel').press('2');
  await wait(3000);
  await shot(page, 'agents-panel');
  mark('end');
  await wait(3000);

  // ---------------------------------------------------------------------------- wrap
  clearInterval(ticker);
  const video = page.video();
  await context.close(); // the video is only finalized on close
  const file = video ? await video.path() : '';
  await browser.close();
  await stop();

  writeFileSync(join(OUT, 'marks.json'), JSON.stringify({ video: file, marks, recordedAt: new Date().toISOString() }, null, 2));
  console.log(`\n[take] ${file}`);
  console.log(`[take] marks written to ${join(OUT, 'marks.json')}`);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
