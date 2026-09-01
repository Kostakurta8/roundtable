/**
 * `npm run demo`: the demo room, beside Vite, from a clone.
 *
 * The room itself lives in `./promo/demoRoom.ts` so that the installed binary can stage the same
 * thing with `claude-roundtable --demo`. What is left here is the part that belongs to the dev
 * setup: the hub on 7411, the synthetic root under the OS temp directory, and taking both down on
 * `Ctrl+C`. `Ctrl+C` deletes the staged root on the way out.
 */
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer } from '../server/hub';
import { stageDemoRoom } from './promo/demoRoom';

const PORT = 7411;
/** Under the OS temp directory, so there is no path by which the demo could reach a real transcript. */
const ROOT = join(tmpdir(), 'roundtable-demo-root');

async function main(): Promise<void> {
  const room = stageDemoRoom(ROOT, (line) => console.log(`[demo] ${line}`));

  let stop: (() => Promise<void>) | undefined;
  try {
    stop = await startServer(ROOT, PORT, { usePolling: true, interval: 200 });
  } catch (err) {
    room.stop();
    // The one failure worth explaining rather than stack-tracing: the app is already running.
    console.error(
      `\n[demo] could not take port ${PORT}. Roundtable is probably already running in another terminal — ` +
        `stop it (by port, the servers outlive the npm wrapper) and try again.\n`,
    );
    throw err;
  }
  console.log(`[demo] hub on ${PORT}, watching the synthetic root ${ROOT}`);
  console.log('[demo] open http://localhost:5173 — this is a staged session, not one of yours');

  const shutdown = (): void => {
    room.stop();
    void stop?.().finally(() => {
      rmSync(ROOT, { recursive: true, force: true });
      process.exit(0);
    });
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
