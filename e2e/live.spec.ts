/**
 * The one end-to-end proof: a line appended to a transcript on disk reaches both halves of the
 * UI — the office (a thought bubble over the actor) and the group chat (a card) — with nothing
 * stubbed between them. Disk → chokidar → normalizer → hub → WebSocket → store → mapping →
 * engine → DOM.
 *
 * The hub runs in this process rather than as a spawned `tsx server/index.ts`: it needs a
 * per-run `ROUNDTABLE_HOME`, a polling watcher (deterministic on Windows), and a teardown that
 * cannot leave an orphan node process behind. Vite is the only child process, and Playwright's
 * `webServer` owns its lifetime.
 */
import { expect, test } from '@playwright/test';
import { appendFileSync, copyFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { startServer, type StopServer } from '../server/hub';

/** The port the client hardcodes in `src/ws.ts`; the hub has to be here or nothing connects. */
const PORT = 7411;
/** Polling beats fs.watch for determinism on Windows, and 200ms fits inside the 5s budget. */
const WATCH = { usePolling: true, interval: 200 } as const;

/** The thinking block of the fixture's assistant line — bubble in the office, monologue in chat. */
const THOUGHT = 'scheduler.spec mixes timers';
/** Deliberately verdict-free ("CONFIRMED"/"REFUTED" would reroute this into a confront trip). */
const LIVE_TEXT = 'Narrowed it to the fake-timer window.';

const ARTIFACTS = resolve('e2e', 'artifacts');

let stop: StopServer | undefined;
let root = '';
let mainFile = '';

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

/** `tests/hub.test.ts`'s `makeRoot`, verbatim in layout: one session, one subagent. */
function makeRoot(): { root: string; mainFile: string } {
  const dir = mkdtempSync(join(tmpdir(), 'rt-e2e-'));
  const slugDir = join(dir, 'projects', 'demo');
  const subagentsDir = join(slugDir, 'fix-sess', 'subagents');
  mkdirSync(subagentsDir, { recursive: true });
  const main = join(slugDir, 'fix-sess.jsonl');
  copyFileSync(join('fixtures', 'main-session.jsonl'), main);
  copyFileSync(join('fixtures', 'agent-abc123.jsonl'), join(subagentsDir, 'agent-abc123.jsonl'));
  return { root: dir, mainFile: main };
}

test.beforeAll(async () => {
  ({ root, mainFile } = makeRoot());
  mkdirSync(ARTIFACTS, { recursive: true });
  try {
    stop = await startServer(root, PORT, { ...WATCH });
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
  await expect(page.locator('.hud-top .pill-live')).toHaveText(/LIVE/);

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

  // The room is a fixed 1600x900 stage scaled to the window, so a resize has to re-fit it —
  // 1000x700 fits by width (1000/1600), not height.
  await page.setViewportSize({ width: 1000, height: 700 });
  await expect
    .poll(() => page.locator('.scene').evaluate((el) => getComputedStyle(el).transform))
    .toContain('matrix(0.625');

  expect(consoleErrors, `console errors: ${consoleErrors.join(' | ')}`).toEqual([]);
});
