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
  /** Where `name` came from — `user` means somebody typed it, and it then outranks everything. */
  nameSource?: string;
  /**
   * The CLI's own topic title for the session, the one it also puts on the terminal tab.
   *
   * Written to the transcript as `ai-title` and rewritten as the conversation moves, so it says
   * what the session is about *now* rather than what it opened with. This is what makes a tab
   * readable without anybody naming anything: `dev-60` and `dev-cb` become "Refine the landing
   * page intro" and "Track down the flaky scheduler test".
   */
  title?: string;
  /**
   * One line that tells this session apart from its neighbours, when its name cannot.
   *
   * The CLI names a session after the directory it runs in plus a counter, so every session
   * started from the same place is `dev-52`, `dev-70`, `dev-ef` — six tabs that differ by
   * two hex characters and by nothing a person can use. What distinguishes them is what they were
   * asked to do, so this carries the session's opening human turn, clipped. Absent when the
   * session has not been asked anything yet, which is itself worth showing as absent rather than
   * filled in with a guess.
   */
  label?: string;
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

/**
 * client → server: look for sessions that have started since you last checked, now.
 *
 * Not a repair for anything — the hub sweeps for new sessions on its own every few seconds, and
 * attaches whatever is running without being asked. This is for the person watching: starting a
 * second session in another window and then staring at a screen that has not caught up yet is a
 * few seconds of not knowing whether the thing is broken. A button that answers immediately is
 * worth more than the seconds it saves.
 */
export type RescanCmd = { cmd: 'rescan' };

export type ClientCmd = FollowCmd | UnfollowCmd | RescanCmd;
