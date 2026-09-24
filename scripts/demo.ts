/**
 * `npm run demo`: the demo room, beside Vite, from a clone.
 *
 * The room itself lives in `./promo/demoRoom.ts` so that the installed binary can stage the same
 * thing with `claude-roundtable --demo`. What is left here is the part that belongs to the dev
 * setup: the hub on 7411, the synthetic root in a fresh directory under the OS temp directory, and
 * taking both down on `Ctrl+C`. `Ctrl+C` deletes the staged root on the way out.
 */
import { rmSync } from 'node:fs';
import { startServer } from '../server/hub';
import { newDemoRoot, stageDemoRoom } from './promo/demoRoom';

const PORT = 7411;

async function main(): Promise<void> {
  // A directory of this run's own, not a fixed path: `claude-roundtable --demo` stages the same room,
  // and with one shared directory whichever of the two exited first deleted the other's.
  const root = newDemoRoot();
  const room = stageDemoRoom(root, (line) => console.log(`[demo] ${line}`));

  let stop: (() => Promise<void>) | undefined;
  try {
    stop = await startServer(root, PORT, { usePolling: true, interval: 200 });
  } catch (err) {
    room.stop();
    // Fresh every run, so a failed start that kept it would leave one more behind each time.
    rmSync(root, { recursive: true, force: true });
    // The one failure worth explaining rather than stack-tracing: the app is already running.
    console.error(
      `\n[demo] could not take port ${PORT}. Roundtable is probably already running in another terminal — ` +
        `stop it (by port, the servers outlive the npm wrapper) and try again.\n`,
    );
    throw err;
  }
  console.log(`[demo] hub on ${PORT}, watching the synthetic root ${root}`);
  console.log('[demo] open http://localhost:5173 — this is a staged session, not one of yours');

  const shutdown = (): void => {
    room.stop();
    void stop?.().finally(() => {
      rmSync(root, { recursive: true, force: true });
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
