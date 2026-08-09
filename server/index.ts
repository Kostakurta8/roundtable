/** Entry point: serve the observer hub on loopback for the Vite client to connect to. */
import { DEFAULT_HUB_PORT, PORT_ENV, readPort } from '../shared/net';
import { startServer } from './hub';
import { claudeRoot } from './sessions';

// The one place the port is decided, and the same builders the client uses to find it. A literal
// here was a literal the client had no way to learn about: the hub would be up, the page would
// load, and the top bar would say OFFLINE for ever.
const PORT = readPort(process.env[PORT_ENV], DEFAULT_HUB_PORT);
const root = claudeRoot();

startServer(root, PORT, {
  // The hub stays console-silent by design; surfacing its failures is this entry point's job.
  onError: (err, ctx) => {
    console.error(`[roundtable] ${ctx}:`, err);
  },
}).then(
  () => {
    console.log(`[roundtable] observing ${root} — ws://127.0.0.1:${PORT}/ws`);
  },
  (err: unknown) => {
    // The overwhelmingly likely cause is a second copy of the app, and the raw errno does not say
    // so. Without the hub there is nothing to observe — the page would load and sit at OFFLINE
    // forever — so this exits rather than leaving a UI that cannot possibly work. `concurrently -k`
    // takes the dev server down with it.
    const busy = (err as { code?: string } | null)?.code === 'EADDRINUSE';
    if (busy) {
      console.error(
        `[roundtable] port ${PORT} is already in use — Roundtable is probably already running.\n` +
          `             Open http://localhost:5173, or stop the other copy and try again.`,
      );
    } else {
      console.error(`[roundtable] failed to start on port ${PORT}:`, err);
    }
    process.exit(1);
  },
);
