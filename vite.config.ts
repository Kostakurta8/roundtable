import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

/**
 * The ports are pinned, and `strictPort` is the point.
 *
 * The hub only accepts WebSocket handshakes whose `Origin` is one of the dev server's own
 * addresses — that gate is the only thing stopping any page the user has open from reading their
 * transcripts. Vite's default behaviour when 5173 is busy is to quietly move to 5174, which the
 * allowlist does not name: the app would come up looking perfectly normal and never connect, with
 * the real reason visible only as a rejected handshake. Failing to start is the honest outcome.
 */
export default defineConfig({
  plugins: [react()],
  server: { port: 5173, strictPort: true },
  preview: { port: 4173, strictPort: true },
});
