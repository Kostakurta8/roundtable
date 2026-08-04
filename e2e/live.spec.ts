/**
 * The one end-to-end proof: a line appended to a transcript on disk reaches both halves of the
 * UI — the office (a thought bubble over the actor) and the group chat (a card) — with nothing
 * stubbed between them. Disk → chokidar → normalizer → hub → WebSocket → store → mapping →
 * engine → DOM.
 *
 * Everything here is asserted against the DOM and driven through real input. That is not a style
 * preference: the room is a canvas, and the only reason any of it can be tested at all is the
 * transparent layer of real elements `PixelOffice` hangs over the picture. So the questions this
 * file asks are the ones a person at the keyboard would ask — is the thing I can see the thing I
 * can click, does the camera answer the arrow keys, does the scrubber come back — and it asks
 * them with hit tests, key presses and clicks rather than by reading component state, which would
 * pass just as happily with the accessibility layer nailed to the wrong corner of the stage.
 *
 * The hub runs in this process rather than as a spawned `tsx server/index.ts`: it needs a
 * per-run `ROUNDTABLE_HOME`, a polling watcher (deterministic on Windows), and a teardown that
 * cannot leave an orphan node process behind. Vite is the only child process, and Playwright's
 * `webServer` owns its lifetime.
 */
import { expect, test, type Page } from '@playwright/test';
import { appendFileSync, copyFileSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { startServer, type StopServer } from '../server/hub';
// The floor plan's own number, imported rather than transcribed: the last test here is entirely
// about what happens when there are more agents than chairs, and a copy of `13` in this file would
// stop meaning that the day somebody adds a desk. `engine.ts` imports nothing but types, so this
// costs the test process no DOM and no bundler.
import { MAX_SEATS } from '../src/office/engine';

/** The port the client hardcodes in `src/ws.ts`; the hub has to be here or nothing connects. */
const PORT = 7411;
/** Polling beats fs.watch for determinism on Windows, and 200ms fits inside the 5s budget. */
const WATCH = { usePolling: true, interval: 200 } as const;

/** The thinking block of the fixture's assistant line — bubble in the office, monologue in chat. */
const THOUGHT = 'scheduler.spec mixes timers';
/** Deliberately verdict-free ("CONFIRMED"/"REFUTED" would reroute this into a confront trip). */
const LIVE_TEXT = 'Narrowed it to the fake-timer window.';
/**
 * Deliberately a verdict, and deliberately from `main`.
 *
 * `mapping.ts` drops a verdict-free line from main outright (nobody walks a note to their own
 * desk), so a plain sentence from main is never *spoken* in the room at all. A verdict becomes a
 * `confront`, and a confront addressed to main by main is said where main sits — no walk, no
 * arrival, no several-second wait for the sentence to cross the floor. That is what makes it the
 * honest input for testing the live region: what is announced is the settled line and nothing else.
 */
const VERDICT_TEXT = 'CONFIRMED: the fake timer never advances.';
/** What the crier has to say for it, exactly once. `main` has no sidecar, so its label is its id. */
const VERDICT_CRY = `main says: ${VERDICT_TEXT}`;

/** How many agents the last test leaves standing outside. Three, so a single miscount is visible. */
const BENCHED = 3;
/** `fixtures/` already supplies `main` and one subagent; this is the shortfall the crowd test writes. */
const EXTRA_AGENTS = MAX_SEATS + BENCHED - 2;

const ARTIFACTS = resolve('e2e', 'artifacts');

let stop: StopServer | undefined;
let root = '';
let mainFile = '';
let subagentsDir = '';

/** The same shape `fixtures/main-session.jsonl` uses, with a thinking block and a text block. */
const liveLine = (): string =>
  `${JSON.stringify({
    type: 'assistant',
    uuid: 'live-1',
    parentUuid: 'a2',
    sessionId: 'fix-sess',
    timestamp: new Date().toISOString(),
    message: {
      role: 'assistant',
      model: 'claude-fable-5',
      content: [
        { type: 'thinking', thinking: THOUGHT, signature: 'sig' },
        { type: 'text', text: LIVE_TEXT },
      ],
      usage: { input_tokens: 12, output_tokens: 90, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    },
  })}\n`;

/** One assistant line carrying a verdict and nothing else. */
const verdictLine = (): string =>
  `${JSON.stringify({
    type: 'assistant',
    uuid: 'live-2',
    parentUuid: 'live-1',
    sessionId: 'fix-sess',
    timestamp: new Date().toISOString(),
    message: {
      role: 'assistant',
      model: 'claude-fable-5',
      content: [{ type: 'text', text: VERDICT_TEXT }],
      usage: { input_tokens: 4, output_tokens: 20, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    },
  })}\n`;

/**
 * A whole subagent transcript, in one line.
 *
 * One line is all it takes to be a person: the Normalizer announces its agent on the first line of
 * any file it is handed, whatever that line says, and `agentSeen` is what the office seats. These
 * agents exist only to fill chairs, so they say one thing and stop.
 */
const benchAgent = (agentId: string): string =>
  `${JSON.stringify({
    parentUuid: null,
    isSidechain: true,
    agentId,
    type: 'user',
    sessionId: 'fix-sess',
    // Inside the fixture's own minute on purpose: a timestamp of *now* would add a column to the
    // activity strip, and the scrub test above is written against the columns the fixture makes.
    timestamp: '2026-08-02T10:00:17.000Z',
    cwd: 'C:\\demo',
    version: '2.1.220',
    message: { role: 'user', content: 'wait for a chair' },
  })}\n`;

/**
 * Marks a copied fixture as having just been written.
 *
 * `copyFileSync` preserves the source's timestamps on Windows, so a transcript copied out of
 * `fixtures/` arrives claiming it was last written whenever that file was committed. The hub reads
 * a subagent's mtime to decide whether it has gone quiet and finished, so without this every agent
 * in a freshly built root is *already* eligible to be reported done — and walks out of the room
 * before the first assertion runs. That is what it looked like: all six of these failing at once,
 * on counts, on ghosts, on hit tests, with nothing wrong in the renderer at all.
 */
function freshen(file: string): void {
  const now = new Date();
  utimesSync(file, now, now);
}

/** `tests/hub.test.ts`'s `makeRoot`, verbatim in layout: one session, one subagent. */
function makeRoot(): { root: string; mainFile: string; subagentsDir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'rt-e2e-'));
  const slugDir = join(dir, 'projects', 'demo');
  const subagents = join(slugDir, 'fix-sess', 'subagents');
  mkdirSync(subagents, { recursive: true });
  const main = join(slugDir, 'fix-sess.jsonl');
  copyFileSync(join('fixtures', 'main-session.jsonl'), main);
  freshen(main);
  const agent = join(subagents, 'agent-abc123.jsonl');
  copyFileSync(join('fixtures', 'agent-abc123.jsonl'), agent);
  freshen(agent);
  return { root: dir, mainFile: main, subagentsDir: subagents };
}

// ------------------------------------------------------------------ hit testing

type Hits = {
  total: number;
  /** Marks whose own centre resolves to themselves. */
  own: number;
  /** Marks whose centre resolves to *another* person standing in front of them. */
  occluded: string[];
  /** Marks whose centre resolves to something that is not a person at all. Always a bug. */
  outside: string[];
};

/**
 * What a click at each actor's centre actually hits.
 *
 * This is the contract `pixel.css` states in prose and nothing else checks: the actor layer sits
 * above the canvas, the desks, the fixtures and the camera controls, so the person you can see is
 * the person you can click. Two different failures hide behind the same symptom, so they are
 * counted separately — landing on another *actor* is honest (two agents in the break corner really
 * do stand in front of each other, and `place` deliberately stacks them by depth so the nearer one
 * wins), while landing on the canvas, a desk or the zoom buttons means the layer is not where it
 * claims to be and the room is unclickable in that spot.
 */
async function hits(page: Page): Promise<Hits> {
  return page.evaluate(() => {
    const marks = Array.from(document.querySelectorAll('.actor[data-agent]')) as HTMLElement[];
    const out = { total: marks.length, own: 0, occluded: [] as string[], outside: [] as string[] };
    for (const mark of marks) {
      const r = mark.getBoundingClientRect();
      const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
      const owner = hit === null ? null : hit.closest('.actor[data-agent]');
      const id = mark.dataset.agent ?? '?';
      if (owner === mark) out.own += 1;
      else if (owner instanceof HTMLElement) out.occluded.push(`${id} behind ${owner.dataset.agent ?? '?'}`);
      else out.outside.push(`${id} hit ${hit === null ? 'nothing' : hit.className || hit.tagName}`);
    }
    return out;
  });
}

/**
 * Whether the canvas's backing store matches the box it is drawn into, at device resolution.
 *
 * The CSS size of the canvas is guaranteed by `width: 100%` and proves nothing; the *buffer* is
 * written by hand in `measure()` and is exactly what a missed `ResizeObserver` callback leaves
 * stale — a room that keeps drawing at the old resolution and is quietly resampled by the browser,
 * which for pixel art is the whole ballgame.
 */
async function backingStore(page: Page): Promise<string> {
  return page.evaluate(() => {
    const wrap = document.querySelector('.office.pixel');
    const canvas = document.querySelector('canvas.pixel-canvas');
    if (!(wrap instanceof HTMLElement) || !(canvas instanceof HTMLCanvasElement)) return 'no room';
    const r = wrap.getBoundingClientRect();
    // The same clamp and rounding `PixelOffice.measure` uses, because the claim is that the two
    // agree — not that the buffer is any particular size.
    const dpr = Math.min(3, Math.max(1, window.devicePixelRatio || 1));
    const w = Math.max(1, Math.round(r.width));
    const h = Math.max(1, Math.round(r.height));
    const want = `${Math.round(w * dpr)}x${Math.round(h * dpr)}`;
    const got = `${canvas.width}x${canvas.height}`;
    return got === want ? 'exact' : `${got}, wanted ${want}`;
  });
}

// -------------------------------------------------------------------- the camera

const roundedX = async (page: Page, selector: string): Promise<number> => {
  const box = await page.locator(selector).boundingBox();
  return box === null ? Number.NaN : Math.round(box.x);
};

/**
 * Where something is once the camera has stopped moving.
 *
 * The camera eases toward what it was asked for — a fifth of the remaining distance per frame —
 * so a single measurement taken right after a key press is a number from halfway through an
 * animation and comparing two of them proves nothing. Two agreeing samples is the cheapest honest
 * definition of "it has arrived".
 */
async function settledX(page: Page, selector: string): Promise<number> {
  let last = Number.NaN;
  await expect
    .poll(
      async () => {
        const now = await roundedX(page, selector);
        const same = Number.isFinite(now) && now === last;
        last = now;
        return same;
      },
      { intervals: [200], timeout: 10_000 },
    )
    .toBe(true);
  return last;
}

// --------------------------------------------------------------------- the crier

/** Records every distinct thing the live region is ever set to, from now on. */
async function watchCrier(page: Page): Promise<void> {
  await page.evaluate(() => {
    const el = document.querySelector('.rt-crier');
    if (el === null) throw new Error('no .rt-crier in the room');
    const said: string[] = [];
    (window as unknown as { __said: string[] }).__said = said;
    new MutationObserver(() => said.push(el.textContent ?? '')).observe(el, {
      childList: true,
      characterData: true,
      subtree: true,
    });
  });
}

const crierSaid = (page: Page): Promise<string[]> =>
  page.evaluate(() => (window as unknown as { __said?: string[] }).__said ?? []);

// ------------------------------------------------------------------------ setup

test.beforeAll(async () => {
  ({ root, mainFile, subagentsDir } = makeRoot());
  mkdirSync(ARTIFACTS, { recursive: true });
  try {
    // The quiet sweep is disabled for the whole run. These tests are about the renderer — who is
    // on the floor, where their labels land, what the camera does — and the fixture agents have to
    // stay put for all of it. Left at its default the suite would carry a hidden 45-second deadline
    // measured from `beforeAll`, and the last test to run would be the first to flake.
    stop = await startServer(root, PORT, { ...WATCH, quietMs: 10 * 60_000 });
  } catch (err) {
    throw new Error(
      `could not bind the observer hub on ${PORT} — is "npm run dev" already running? (${String(err)})`,
    );
  }
});

test.afterAll(async () => {
  await stop?.();
  if (root) rmSync(root, { recursive: true, force: true });
});

/** The state every test starts from: the app up, the socket open, and the backlog fully folded. */
async function openRoom(page: Page): Promise<void> {
  await page.goto('/');
  // The pill reads LOADING while the backlog is still arriving, so waiting for LIVE is also
  // waiting for the whole of history to have been folded — every count below is then a count of
  // the finished room rather than of a room halfway through being replayed.
  await expect(page.locator('.topbar .pill-live')).toHaveText('LIVE');
}

test('a live transcript append reaches the office and the chat', async ({ page }) => {
  const consoleErrors: string[] = [];
  page.on('console', (m) => {
    // A headed browser asks for /favicon.ico and logs the 404; the app has no icon and does not
    // need one, so that request is the one console error this assertion is not about.
    if (m.type() === 'error' && !m.text().includes('favicon')) consoleErrors.push(m.text());
  });

  await page.goto('/');

  // The app follows the newest session by itself; the backlog replay proves it picked ours.
  await expect(page.locator('.msg-card', { hasText: 'find the flaky test' })).toBeVisible();
  // The pill lives in the top bar, which is a `<header class="topbar panel">` — the `.hud-top`
  // this line used to name was deleted with the DOM room, and because the suite could never bind
  // its port nobody ever saw the selector fail.
  await expect(page.locator('.topbar .pill-live')).toHaveText('LIVE');

  // The office is populated from the same replay: main at its desk, the subagent at a pod.
  await expect(page.locator('.actor')).toHaveCount(2);

  // The backlog carries this very thought, so its bubble has to expire before the append —
  // otherwise the assertion below could be satisfied by history instead of by live streaming.
  await expect(page.locator('.think.on')).toHaveCount(0, { timeout: 15_000 });

  appendFileSync(mainFile, liveLine());

  // The office half: the thought bubble, which is on screen for five seconds only.
  await expect(page.locator('.actor .think.on').filter({ hasText: THOUGHT })).toBeVisible();

  // The chat half: a card for the same turn, with the thought filed under its monologue. The
  // backlog carries a monologue with this text too, so the assertion is scoped to the new card.
  const liveCard = page.locator('.msg-card', { hasText: LIVE_TEXT });
  await expect(liveCard).toBeVisible();
  await expect(liveCard.locator('.monologue-body')).toHaveText(THOUGHT);

  await page.screenshot({ path: join(ARTIFACTS, 'live-office.png'), fullPage: true });

  expect(consoleErrors, `console errors: ${consoleErrors.join(' | ')}`).toEqual([]);
});

test('the accessibility layer stays over the sprites it labels, and survives a resize', async ({ page }) => {
  await openRoom(page);
  await expect(page.locator('.actor')).toHaveCount(2);

  // Both people are individually reachable at rest. Two is the whole cast here and neither of them
  // is in the break corner, which is the one place in the room where agents legitimately stand in
  // front of each other — so in *this* room every centre must resolve to its own mark, and
  // anything under `occluded` would mean two marks piled on one spot rather than honest depth.
  //
  // "At rest" is what the polling is for, and it is not a formality: everybody walks in from the
  // door, so for the first ten seconds of a replayed session two people really are standing on the
  // same square of floor, and a single sample taken then would be testing the walk rather than the
  // layer.
  await expect.poll(async () => hits(page), { timeout: 25_000 }).toEqual({
    total: 2,
    own: 2,
    occluded: [],
    outside: [],
  });

  await expect.poll(async () => backingStore(page)).toBe('exact');

  // The room is a canvas fitted to its stage, so what a resize has to do is resize the *drawing
  // surface* and then re-place every mark against the new blit. Comparing the canvas's CSS width
  // to the stage's — which is what this used to assert — only re-states `width: 100%`; these two
  // are the things the renderer can actually get wrong, and the second one is the one that makes
  // the room unusable rather than merely blurry.
  await page.setViewportSize({ width: 1000, height: 700 });

  await expect.poll(async () => backingStore(page), { timeout: 15_000 }).toBe('exact');
  await expect.poll(async () => hits(page), { timeout: 25_000 }).toEqual({
    total: 2,
    own: 2,
    occluded: [],
    outside: [],
  });
});

test('the crier announces a settled line exactly once', async ({ page }) => {
  await openRoom(page);
  await expect(page.locator('.actor')).toHaveCount(2);

  await watchCrier(page);
  appendFileSync(mainFile, verdictLine());

  // Drawn as a bubble over main, and said out loud to anyone not looking at the room. Both, from
  // the same `ActorState.say` — the bubble is what the live region is a transcript *of*, so
  // asserting them together is what makes "announces what was said" mean anything.
  await expect(page.locator('.actor[data-agent="main"] .say.on')).toHaveText(VERDICT_TEXT);

  await expect.poll(async () => (await crierSaid(page)).filter((s) => s.includes(VERDICT_CRY)).length, {
    timeout: 20_000,
  }).toBe(1);

  // The whole risk here is a *second* announcement, and a second announcement cannot be waited for
  // — only outlasted. Six seconds outlives the bubble's own five, so this covers the likeliest
  // shape of the bug: the line expiring and being announced again on its way out.
  await page.waitForTimeout(6000);
  const said = await crierSaid(page);
  expect(
    said.filter((s) => s.includes(VERDICT_CRY)),
    `the live region said it more than once: ${JSON.stringify(said)}`,
  ).toHaveLength(1);
});

test('the camera answers the keyboard', async ({ page }) => {
  await openRoom(page);

  const room = page.locator('.office.pixel');
  const zoomLabel = page.locator('.cam-z');
  // The roundtable rather than a person: it is painted at a fixed spot in the buffer, so its
  // position on screen moves when — and only when — the camera does. An actor's mark would move
  // because the actor walked, which is exactly the thing this test must not be able to mistake for
  // a working camera.
  const table = '.fixture-table';

  await expect(zoomLabel).toHaveText(/^1\.0/);
  await room.focus();

  // `=` rather than `+`, which is the same case in the room's handler and needs no shift.
  await page.keyboard.press('=');
  await page.keyboard.press('=');
  await page.keyboard.press('=');
  // 1.25³ = 1.95. The readout is the camera's *target*, written the instant the key is pressed,
  // while the camera itself is still easing toward it.
  await expect(zoomLabel).toHaveText(/^2\.0/);

  const home = await settledX(page, table);

  // Panning is only observable once the view is smaller than the room: at 1× `clampCam` pins the
  // camera to the room's own centre and an arrow key is correctly a no-op, which is why the zoom
  // above is a precondition and not a second assertion.
  for (let i = 0; i < 4; i++) await page.keyboard.press('ArrowLeft');
  const panned = await settledX(page, table);
  expect(panned - home, `the room did not move: ${home} → ${panned}`).toBeGreaterThan(40);

  for (let i = 0; i < 4; i++) await page.keyboard.press('ArrowRight');
  const back = await settledX(page, table);
  expect(Math.abs(back - home), `the pan did not reverse: ${home} → ${panned} → ${back}`).toBeLessThanOrEqual(2);
});

test('scrubbing the timeline and resuming live round-trips', async ({ page }) => {
  await openRoom(page);
  await expect(page.locator('.actor')).toHaveCount(2);

  // `⏵ resume live` lives in `.dock-foot`, which `.app.dock-hidden .dock { display: none }` hides
  // wholesale — so pressing `B`, or a window 620px tall or shorter, strands the room in the past
  // with no way back. That is a known bug and somebody else's to fix; this test simply never
  // presses `B`, and would go on passing after the control moves somewhere it cannot be hidden.
  // Looked up by its name rather than by where it happens to sit, so this keeps passing on the day
  // somebody moves it out of the dock — which is the fix. `.first()` below for the same reason: a
  // second copy of the control somewhere unhideable is an improvement, not a failure.
  const resume = page.getByRole('button', { name: /resume live/i });
  await expect(resume).toHaveCount(0);

  // Clicked rather than tabbed to, because there is nothing to tab to: the bars are bare `div`s
  // with an `onClick`, no `tabIndex` and no key handler, under a `role="img"` that makes the whole
  // plot presentational. The app's only time-travel affordance is mouse-only. Also a known bug,
  // also not this file's to fix — but a test that pretended to reach it with the keyboard would be
  // asserting an affordance that does not exist.
  await page.locator('.tl-bar').first().click();
  await expect(resume.first()).toBeVisible();

  // The earliest column is the second the session's first assistant turn landed in — 10:00:05 in
  // `fixtures/main-session.jsonl`, eleven seconds before the subagent's sidecar says a word. So
  // the room at that moment held exactly one person, and the office rebuilding it from the command
  // log rather than approximating it from totals is the whole claim replay makes.
  await expect(page.locator('.actor')).toHaveCount(1);

  await resume.first().click();
  await expect(resume).toHaveCount(0);
  // Back to now, and specifically back to the *live* engine's cast rather than to whatever the
  // replay left in the DOM — the room the viewer wandered away from is still running.
  await expect(page.locator('.actor')).toHaveCount(2);
});

test('the off-site strip names the agents the room has no chair for', async ({ page }) => {
  // Deliberately last: this leaves the session with more agents than the floor plan seats, and
  // every count above is a count of the two-person room the fixtures describe.
  for (let i = 0; i < EXTRA_AGENTS; i++) {
    const id = `wait${String(i).padStart(2, '0')}`;
    writeFileSync(join(subagentsDir, `agent-${id}.jsonl`), benchAgent(id));
  }

  await openRoom(page);

  // Nobody is ever turned out of a chair to make room, so the floor fills to its capacity and the
  // rest queue. The hub finds new sidecars on a 500ms rescan, so this is worth waiting for.
  await expect(page.locator('.actor')).toHaveCount(MAX_SEATS, { timeout: 20_000 });

  // Not a decoration: the strip is a list, each waiting agent is an item in it, and each item
  // carries the name the ten pixels of head above it cannot. This is the assertion that the canvas
  // alone cannot satisfy however well it draws them.
  const strip = page.getByRole('list', { name: 'waiting for a desk' });
  await expect(strip.getByRole('listitem')).toHaveCount(BENCHED);

  const first = page.locator('.ghost').first();
  await expect(first).toHaveAttribute('aria-label', /waiting for a desk/);

  // A `div` only takes focus if somebody gave it a `tabIndex`, so this fails outright if the mark
  // is ever demoted to decoration.
  await first.focus();
  await expect(first).toBeFocused();

  // And it sits over the band the canvas paints it in, rather than merely existing somewhere on
  // the stage: the strip is the bottom 26 of 270 buffer rows and the blit is bottom-aligned, so a
  // mark anywhere but the foot of the room is a mark over the wrong pixels.
  const room = await page.locator('.office.pixel').boundingBox();
  const ghost = await first.boundingBox();
  expect(room).not.toBeNull();
  expect(ghost).not.toBeNull();
  expect(ghost!.y + ghost!.height).toBeGreaterThan(room!.y + room!.height * 0.8);

  // The floor is crowded now, so `own` is allowed to be short of `total` — that is what the depth
  // stacking is for. What is never allowed is a mark whose own centre lands on the canvas, a desk
  // or the camera controls, because that is a person nobody can click.
  const crowded = await hits(page);
  expect(crowded.outside, `marks outside the actor layer: ${crowded.outside.join(', ')}`).toEqual([]);

  await page.screenshot({ path: join(ARTIFACTS, 'offsite-strip.png'), fullPage: true });
});
