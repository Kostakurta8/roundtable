/** Entry point: serve the observer hub on loopback for the Vite client to connect to. */
import { startServer } from './hub';
import { claudeRoot } from './sessions';

const PORT = 7411;
const root = claudeRoot();

startServer(root, PORT).then(
  () => {
    console.log(`[roundtable] observing ${root} — ws://127.0.0.1:${PORT}/ws`);
  },
  (err: unknown) => {
    console.error(`[roundtable] failed to start on port ${PORT}:`, err);
    process.exitCode = 1;
  },
);
