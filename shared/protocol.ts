/**
 * The observer wire protocol: every frame that crosses the WebSocket, in one place.
 *
 * These types live here rather than in `server/hub.ts` because both halves need them and the
 * client must never reach into the server: `server/hub.ts` imports `node:fs`, `chokidar` and
 * `ws`, so a single value import — or `verbatimModuleSyntax` erasing the `import type` that is
 * all that keeps them apart today — would pull the whole hub into the browser bundle. `shared/`
 * is the one direction that is always safe: the server may import it, the client may import it,
 * and it imports nothing but itself.
 *
 * Event frames are the other half of the protocol and are defined in `./events`.
 */

/** One row of the roster the hub greets every new connection with. */
export type SessionSummary = { sessionId: string; slug: string; mtime: number };

/** server → client, on connect: every session found on this machine, newest first. */
export type HelloMsg = { kind: 'hello'; sessions: SessionSummary[] };

/** server → client, just before a backlog replay that can no longer offer the full history. */
export type BacklogTruncatedMsg = { kind: 'backlogTruncated'; dropped: number };

/** client → server: stream this session. Anything else the hub ignores. */
export type FollowCmd = { cmd: 'follow'; sessionId: string };
