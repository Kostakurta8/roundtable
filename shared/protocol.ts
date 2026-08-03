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

/**
 * One row of the roster the hub greets every new connection with.
 *
 * `name`, `status` and `live` come from `~/.claude/sessions/<pid>.json`, the registry the CLI
 * keeps of its own processes. They are optional because that registry only covers sessions the
 * CLI still knows about — historical transcripts have a file and nothing else, and the picker
 * shows them with the slug it has rather than pretending to know more.
 */
export type SessionSummary = {
  sessionId: string;
  slug: string;
  mtime: number;
  /** The working directory the session runs in, when the registry knows it. */
  cwd?: string;
  /** The CLI's own name for the session, e.g. `dev-67`. */
  name?: string;
  /** Whatever the CLI last wrote: `idle`, `running`, … */
  status?: string;
  /** True when the session is registered *and* something touched it recently. */
  live: boolean;
};

/** server → client, on connect: every session found on this machine, newest first. */
export type HelloMsg = {
  kind: 'hello';
  sessions: SessionSummary[];
  /** The directory being observed, so the UI can say what it is showing without guessing. */
  root: string;
};

/** server → client, whenever the roster changes, so the picker does not need a reload. */
export type RosterMsg = { kind: 'roster'; sessions: SessionSummary[] };

/** server → client, just before a backlog replay that can no longer offer the full history. */
export type BacklogTruncatedMsg = { kind: 'backlogTruncated'; dropped: number };

/** server → client, once a backlog replay has finished, so the client can stop showing a spinner. */
export type ReadyMsg = { kind: 'ready'; sessionId: string; replayed: number };

/**
 * server → client: this session's state is invalid — drop it, the replay that follows rebuilds it.
 *
 * A transcript that is truncated or replaced makes the hub start reading it from byte zero, and
 * every line it re-reads is published with a *fresh* `seq`. The client folds by `seq`, so its
 * idempotence guard cannot recognize a single one of them: without this frame the session is
 * counted twice — every message, every token, every dollar.
 */
export type ResetMsg = {
  kind: 'reset';
  sessionId: string;
  /**
   * `rewound` — the transcript was truncated or replaced under the hub.
   * `replay` — a backlog is about to be sent that may not continue what the client already has.
   *
   * The second is the routine one and it is sent before *every* replay. A client that switched
   * away from a session long enough for the hub to evict its watch, and then switched back, would
   * otherwise be handed the whole session a second time, re-read from byte zero with fresh `seq`
   * values that its idempotence guard has no way to recognize as a repeat.
   */
  reason: 'rewound' | 'replay';
};

/** server → client: the tail of this session is not complete, and why. */
export type TailNoticeMsg = {
  kind: 'notice';
  sessionId: string;
  /** Oversized lines skipped unparsed — each may have carried a tool_result. */
  skipped: number;
  /** True while a catch-up read has given up before reaching the end of a file. */
  behind: boolean;
};

export type ServerMsg =
  | HelloMsg
  | RosterMsg
  | BacklogTruncatedMsg
  | ReadyMsg
  | ResetMsg
  | TailNoticeMsg;

/** client → server: stream this session. Anything else the hub ignores. */
export type FollowCmd = { cmd: 'follow'; sessionId: string };

/** client → server: stop streaming, without dropping the socket (the picker is open, say). */
export type UnfollowCmd = { cmd: 'unfollow' };

export type ClientCmd = FollowCmd | UnfollowCmd;
