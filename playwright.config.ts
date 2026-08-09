import { defineConfig } from '@playwright/test';
import { DEFAULT_WEB_PORT } from './shared/net';

/**
 * End-to-end config for the observer.
 *
 * Two servers are needed for a live run: the Vite dev server (the app) and the observer hub
 * (the event source). Only Vite is booted here — the hub is started *inside* the spec, in
 * process, because it needs a per-run `ROUNDTABLE_HOME` and a polling watcher, and because an
 * in-process hub cannot outlive the test run as an orphan the way a spawned `tsx` would.
 *
 * The browser talks to Vite over `localhost` on purpose: Vite binds `::1` as well as `127.0.0.1`
 * and resolves `localhost` either way, whereas the app's own WebSocket stays on `127.0.0.1:7411`
 * (`src/ws.ts`), which is exactly where the in-process hub binds.
 */
export default defineConfig({
  testDir: 'e2e',
  outputDir: 'e2e/artifacts/test-results',
  fullyParallel: false,
  // One worker: both servers are singletons on fixed ports, so parallel files would collide.
  workers: 1,
  timeout: 90_000,
  expect: { timeout: 5_000 },
  reporter: [['list']],
  use: {
    baseURL: `http://localhost:${DEFAULT_WEB_PORT}`,
    // The mockup's own basis, so an e2e screenshot is directly comparable to docs/mockup.
    viewport: { width: 1600, height: 900 },
    trace: 'off',
  },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
  webServer: {
    command: `npx vite --port ${DEFAULT_WEB_PORT} --strictPort`,
    url: `http://localhost:${DEFAULT_WEB_PORT}`,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
    stdout: 'ignore',
    stderr: 'pipe',
  },
});
