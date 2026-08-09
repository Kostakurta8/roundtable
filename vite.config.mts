import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { DEFAULT_PREVIEW_PORT, DEFAULT_WEB_PORT, PORT_ENV } from './shared/net';

/**
 * The ports are pinned, and `strictPort` is the point.
 *
 * The hub only accepts WebSocket handshakes whose `Origin` is one of the dev server's own
 * addresses — that gate is the only thing stopping any page the user has open from reading their
 * transcripts. Vite's default behaviour when 5173 is busy is to quietly move to 5174, which the
 * allowlist does not name: the app would come up looking perfectly normal and never connect, with
 * the real reason visible only as a rejected handshake. Failing to start is the honest outcome.
 *
 * The numbers come from `shared/net.ts` rather than being written here, because the gate on the
 * other side is built from the same constants. Two literals that must agree, in two files that
 * never mention each other, is the shape of a bug nobody finds: the symptom is `OFFLINE` in the
 * top bar with a hub that is up and a page that loaded.
 */
export default defineConfig({
  plugins: [react()],
  server: { port: DEFAULT_WEB_PORT, strictPort: true },
  preview: { port: DEFAULT_PREVIEW_PORT, strictPort: true },
  /*
   * One variable moves both halves.
   *
   * The hub reads `ROUNDTABLE_PORT` from its own environment, but the client cannot: only
   * `VITE_`-prefixed variables reach `import.meta.env`, and only from a `.env` file at that. So
   * a user who set `ROUNDTABLE_PORT=9000` would move the hub and leave the page dialling 7411 —
   * the app would load, look completely normal, and sit at `OFFLINE` for ever, which is the
   * least debuggable failure this project has.
   *
   * Forwarding it here is what makes the documented variable true for both. The empty-string
   * default is deliberate: `readPort` rejects it and falls back, so an unset variable is the
   * same as no override rather than the literal text `undefined`.
   */
  define: {
    'import.meta.env.VITE_ROUNDTABLE_PORT': JSON.stringify(process.env[PORT_ENV] ?? ''),
  },
});
