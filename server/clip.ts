/**
 * `--gif`: one session, as a looping timelapse of the office, written to a file you can post.
 *
 * This file is the half that only a terminal can do: reading a whole session off disk. The half
 * that turns events into frames and frames into a GIF is `src/clip/render.ts`, which the share
 * dialog also runs in a browser worker — so it is re-exported from here rather than restated, and
 * `--gif` and the app's Share button make the same file out of the same events.
 *
 * This adds no second reading of the transcripts. The events come from the hub itself, started
 * in-process on a loopback port nobody else is told about and followed by a socket exactly as the
 * page follows it.
 *
 * **Nothing is written except the file you asked for.** The hub it starts is read-only in the same
 * way the app's is — that is the same code — and it binds loopback on a port chosen here and closed
 * before this returns.
 */
import { createServer } from 'node:net';
import { WebSocket } from 'ws';
import { isEv, type Ev } from '../shared/events';
import type { ServerMsg, SessionSummary } from '../shared/protocol';
import { CLIP_DEFAULTS, renderClip as renderBytes, type ClipOptions, type ClipResult as ClipBytes } from '../src/clip/render';
import { startServer } from './hub';

export {
  CLIP_DEFAULTS,
  CLIP_MAX_SCALE,
  CLIP_MAX_SECONDS,
  clipFrames,
  REPO_LINE,
  type ClipFrames,
  type ClipOptions,
} from '../src/clip/render';

/** The clip as the CLI holds it: the same bytes the browser gets, in a `Buffer` for `writeFileSync`. */
export type ClipResult = Omit<ClipBytes, 'gif'> & { gif: Buffer };

export function renderClip(evs: readonly Ev[], opts: ClipOptions = CLIP_DEFAULTS): ClipResult {
  const c = renderBytes(evs, opts);
  return { ...c, gif: Buffer.from(c.gif.buffer, c.gif.byteOffset, c.gif.byteLength) };
}

// --------------------------------------------------------------- collecting a session

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

export type Collected = {
  session: SessionSummary;
  /** Every session the hub could see, newest first — for saying what else could have been picked. */
  sessions: SessionSummary[];
  evs: Ev[];
};

/**
 * After the backlog's `ready`, how long to keep listening for the events the hub derives on its
 * own schedule rather than off a line — chiefly an agent the transcript never says has stopped,
 * which the hub's rescan declares finished from the file's own mtime.
 */
const SETTLE_AFTER_READY_MS = 1500;

/** A hard ceiling on the whole read, so a hub that never says `ready` cannot hang the command. */
const COLLECT_TIMEOUT_MS = 120_000;

/** `pick` is a session id, or a prefix of one; absent means the most recently written session. */
export async function collectSession(root: string, pick?: string): Promise<Collected> {
  const port = await freePort();
  const stop = await startServer(root, port, {
    // The whole session, not the page's rolling window: a clip of the last four thousand events of
    // a long run would start in the middle of it with people already at their desks.
    backlogLimit: 5_000_000,
    onError: () => {},
  });
  try {
    return await new Promise<Collected>((resolve, reject) => {
      const sock = new WebSocket(`ws://127.0.0.1:${port}/ws`);
      const evs: Ev[] = [];
      let chosen: SessionSummary | null = null;
      let all: SessionSummary[] = [];
      let settle: NodeJS.Timeout | null = null;
      const fail = (err: Error): void => {
        clearTimeout(timer);
        if (settle) clearTimeout(settle);
        sock.terminate();
        reject(err);
      };
      const timer = setTimeout(() => fail(new Error('the observer did not finish reading the session in time')), COLLECT_TIMEOUT_MS);
      const finish = (): void => {
        clearTimeout(timer);
        sock.close();
        resolve({ session: chosen!, sessions: all, evs });
      };

      sock.on('error', (err) => fail(err));
      sock.on('message', (data) => {
        let msg: unknown;
        try {
          msg = JSON.parse(String(data));
        } catch {
          return;
        }
        if (isEv(msg)) {
          if (chosen && evSessionOf(msg) === chosen.sessionId) evs.push(msg);
          return;
        }
        const m = msg as ServerMsg;
        if (m.kind === 'hello') {
          all = [...m.sessions].sort((a, b) => b.mtime - a.mtime);
          const found = pick ? all.find((s) => s.sessionId === pick) ?? all.find((s) => s.sessionId.startsWith(pick)) : all[0];
          if (!found) {
            fail(new Error(pick ? `no session starting with "${pick}" under ${m.root}` : `no Claude Code sessions under ${m.root}`));
            return;
          }
          chosen = found;
          sock.send(JSON.stringify({ cmd: 'follow', sessionId: found.sessionId }));
          return;
        }
        if (m.kind === 'reset' && chosen && m.sessionId === chosen.sessionId) {
          evs.length = 0; // a replay is about to start from the top; anything before it is stale
          return;
        }
        if (m.kind === 'ready' && chosen && m.sessionId === chosen.sessionId) {
          if (settle) clearTimeout(settle);
          settle = setTimeout(finish, SETTLE_AFTER_READY_MS);
        }
      });
    });
  } finally {
    await stop();
  }
}

const evSessionOf = (ev: Ev): string => ('ref' in ev ? ev.ref.sessionId : ev.sessionId);
