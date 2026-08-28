/**
 * Where the two halves meet: the loopback port, the socket URL, and the origins the hub trusts.
 *
 * These were four literals in four files — `server/index.ts` bound 7411, `src/ws.ts` dialled it,
 * `e2e/live.spec.ts` waited on it, and `server/hub.ts` held a hand-written list of the four page
 * origins allowed to connect. Nothing tied them together, so moving the hub off 7411 meant finding
 * every copy, and getting it wrong produced the least debuggable failure the app has: a hub that is
 * up, a page that loads, and `OFFLINE` in the top bar for ever, because the socket was dialling
 * somewhere else or the Origin gate was still naming the old dev port.
 *
 * Pure by construction: no `process`, no `import.meta`. The server reads its own environment and
 * the client reads Vite's, and both hand the answer to the same builders — `shared/` is imported by
 * both halves, and a module that reaches for `process.env` cannot be imported by a browser bundle
 * while one that reaches for `import.meta.env` cannot be imported by `tsx`.
 */

/** The hub's port when nothing overrides it. Chosen high and unassigned; nothing else wants it. */
export const DEFAULT_HUB_PORT = 7411;

/** Vite's dev port, and its preview port. `strictPort` is load-bearing — see `vite.config.ts`. */
export const DEFAULT_WEB_PORT = 5173;
export const DEFAULT_PREVIEW_PORT = 4173;

/** Loopback, always. The observer reads one machine's transcripts: its own. */
export const HUB_HOST = '127.0.0.1';

export const WS_PATH = '/ws';

/** The environment variable both halves read, so there is one name to document and to type. */
export const PORT_ENV = 'ROUNDTABLE_PORT';

/**
 * A port out of an environment string, or the fallback.
 *
 * Deliberately strict. An unusable value falls back rather than throwing, because the alternative
 * is an app that refuses to start over a typo in an optional variable — but "unusable" includes
 * `0`, which is a *valid* argument to `listen` meaning "any free port". Honouring that would bind
 * a port the client has no way to learn, which is the OFFLINE-forever failure again, arrived at by
 * a different road.
 */
export function readPort(raw: string | undefined, fallback: number): number {
  if (typeof raw !== 'string') return fallback;
  const t = raw.trim();
  if (!/^\d+$/.test(t)) return fallback;
  const n = Number(t);
  return n >= 1 && n <= 65_535 ? n : fallback;
}

export const hubWsUrl = (port: number = DEFAULT_HUB_PORT): string => `ws://${HUB_HOST}:${port}${WS_PATH}`;

/**
 * The page origins the hub's `Origin` gate accepts, derived from the ports the app actually serves.
 *
 * Both spellings of loopback, because Vite binds `::1` and resolves `localhost` either way, so
 * which one the browser sends depends on how the user typed the address.
 */
export const pageOrigins = (
  web: number = DEFAULT_WEB_PORT,
  preview: number = DEFAULT_PREVIEW_PORT,
): string[] => [
  `http://localhost:${web}`,
  `http://127.0.0.1:${web}`,
  `http://localhost:${preview}`,
  `http://127.0.0.1:${preview}`,
];

/**
 * The origins of the packaged app, where the hub serves the built client from its own port.
 *
 * Installed from npm there is no Vite: the page and the socket come from the same server, so the
 * browser sends `http://localhost:7411` as the Origin of a handshake to `ws://127.0.0.1:7411/ws`.
 * That origin is not any of `pageOrigins()`, and a gate that does not name it rejects the app's
 * own page — the OFFLINE-forever failure, reached by the one road the dev setup never travels.
 */
export const appOrigins = (hub: number = DEFAULT_HUB_PORT): string[] => [
  `http://localhost:${hub}`,
  `http://127.0.0.1:${hub}`,
];

/**
 * Every origin the hub trusts: the dev server's, and its own when it is serving the page.
 *
 * Takes the hub's *actual* port rather than the default, because the gate has to move with the
 * server it guards. `ROUNDTABLE_PORT=9000` moves the page too, and an allowlist still naming 7411
 * would refuse the only page there is.
 */
export const allowedOrigins = (
  hub: number = DEFAULT_HUB_PORT,
  web: number = DEFAULT_WEB_PORT,
  preview: number = DEFAULT_PREVIEW_PORT,
): string[] => [...pageOrigins(web, preview), ...appOrigins(hub)];
