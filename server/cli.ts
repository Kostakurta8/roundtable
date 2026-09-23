/**
 * The installed entry point: one command that serves both halves.
 *
 * `npm start` runs two processes — the hub, and Vite serving the client. A published package has
 * no Vite, so the hub serves the built client itself over the same port, and this is the argument
 * parsing and start-up around that. `bin/roundtable.mjs` is the executable; everything it decides
 * is decided here, where the type checker and the test suite can see it.
 *
 * No process is spawned from this file. Opening a browser is the launcher's job, and its own
 * paragraph in SECURITY.md, precisely so that `server/` keeps the property that it never shells
 * out — the hub reads transcripts, and a program that reads transcripts should not be able to run
 * anything.
 */
import { rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { stageDemoRoom } from '../scripts/promo/demoRoom';
import { stageShowcase } from '../scripts/promo/showcase';
import { DEFAULT_HUB_PORT, HUB_HOST, PORT_ENV, readPort } from '../shared/net';
import { CLIP_DEFAULTS, CLIP_MAX_SECONDS, collectSession, renderClip } from './clip';
import { startServer, type StopServer } from './hub';
import { claudeRoot } from './sessions';

export type CliOptions = {
  /** Where the hub listens, and therefore where the page is served. */
  port: number;
  /** The `~/.claude` to observe. Overridable so a demo root can be watched instead. */
  root: string;
  /** Whether the launcher should open a browser. */
  open: boolean;
  /** Print usage and exit, rather than starting anything. */
  help: boolean;
  /** Print the version and exit. */
  version: boolean;
  /**
   * Observe a staged session instead of a real directory.
   *
   * The first run is the product's front door, and on a machine that has never run Claude Code
   * it opens on an empty office. This writes a synthetic root under the OS temp directory — the
   * same one `npm run demo` stages from a clone — and points the hub at that. It never reads
   * `~/.claude`; `root` is overridden so nothing else can be pointed at, either.
   */
  demo: boolean;
  /**
   * Print what the transcripts already on disk say about this machine's fan-out, and exit.
   *
   * The office shows the run you are in; this shows every run you have had. It is separate from
   * the server on purpose — it starts nothing, opens no port, and answers in one screen.
   */
  stats: boolean;
  /**
   * Write one session as a looping GIF of the office, and exit.
   *
   * The office already replays any second of a session; this plays a whole one, sped up, into a
   * file. It starts the hub only for as long as it takes to read the session, on a loopback port it
   * does not print, and the file it was asked for is the only thing it writes.
   */
  gif: boolean;
  /** Where `--gif` writes. Absent means `roundtable-<session>.gif` in the working directory. */
  out: string | null;
  /** Which session `--gif` plays: an id or the start of one. Absent means the latest. */
  session: string | null;
  /** The longest the clip may run, in seconds. */
  seconds: number;
  /** A clip with no text from the transcripts in it at all. */
  bare: boolean;
  /** The whole session rather than its busiest stretch. */
  full: boolean;
  /** An argument that is not understood. Reported rather than ignored — see `parseArgs`. */
  unknown: string | null;
};

export const HELP = `roundtable — a read-only observer for Claude Code sessions

Usage
  claude-roundtable [options]

Options
  -p, --port <n>   Port for the app and its socket (default ${DEFAULT_HUB_PORT}).
                   ${PORT_ENV} sets the same thing.
      --root <dir> The Claude directory to observe (default ~/.claude).
      --demo       Watch a staged session instead: agents arrive, work, argue and leave, so there
                   is something to see on a machine that has never run Claude Code. The
                   transcripts are written under the temp directory and deleted on exit; nothing
                   of yours is read. Overrides --root.
      --stats      Print what every transcript under --root says about your own fan-out — how
                   much of your output is written inside subagents, what a child costs before it
                   starts, which of your hooks have ever fired — then exit. Starts no server.
      --gif        Write a session as a looping GIF of the office — a timelapse you can post —
                   and exit. The latest session unless --session names another; a long one is
                   cut to its busiest stretch unless --full. With --demo, a staged session.
        --out <file>     Where to write it (default roundtable-<session>.gif, here).
        --session <id>   Which session: its id, or the first few characters of it.
        --seconds <n>    How long the clip may run (default ${CLIP_DEFAULTS.seconds}, at most ${CLIP_MAX_SECONDS}).
        --bare           No text from your transcripts in the picture: no task, no names,
                         no speech. The people and what they do are still all there.
        --full           The whole session, however long, instead of its busiest stretch.
      --no-open    Do not open a browser; just print the address.
  -v, --version    Print the version.
  -h, --help       Print this.

It reads the transcript files Claude Code already writes and never writes to them. Nothing leaves
the machine: the server binds loopback only and makes no outbound connection of any kind. The one
file it ever writes is the GIF you ask --gif for.`;

/**
 * Arguments into options, with the environment underneath.
 *
 * An unrecognised flag is *reported*, not ignored: the two things a user is most likely to get
 * wrong here are the port and the root, and silently observing the wrong directory looks exactly
 * like an empty one — the failure this project keeps having to design against.
 */
export function parseArgs(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>> = {},
): CliOptions {
  const opts: CliOptions = {
    port: readPort(env[PORT_ENV], DEFAULT_HUB_PORT),
    root: env.ROUNDTABLE_HOME ?? claudeRoot(),
    open: true,
    help: false,
    version: false,
    demo: false,
    stats: false,
    gif: false,
    out: null,
    session: null,
    seconds: CLIP_DEFAULTS.seconds,
    bare: false,
    full: false,
    unknown: null,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? '';
    // `--port 9000` and `--port=9000` are the same thing to everyone except a parser.
    const eq = arg.indexOf('=');
    const flag = eq === -1 ? arg : arg.slice(0, eq);
    const inline = eq === -1 ? null : arg.slice(eq + 1);
    const take = (): string => inline ?? argv[++i] ?? '';

    if (flag === '-h' || flag === '--help') opts.help = true;
    else if (flag === '-v' || flag === '--version') opts.version = true;
    else if (flag === '--no-open') opts.open = false;
    else if (flag === '--demo') opts.demo = true;
    else if (flag === '--stats') opts.stats = true;
    else if (flag === '--gif') opts.gif = true;
    else if (flag === '--bare') opts.bare = true;
    else if (flag === '--full') opts.full = true;
    else if (flag === '--out') {
      const value = take();
      if (value) opts.out = value;
    } else if (flag === '--session') {
      const value = take();
      if (value) opts.session = value;
    } else if (flag === '--seconds') {
      const n = Number(take());
      // Out of range is clamped rather than refused: `--seconds 90` means "long", and the
      // longest allowed is the honest reading of that.
      if (Number.isFinite(n) && n > 0) opts.seconds = Math.min(CLIP_MAX_SECONDS, Math.max(3, n));
    }
    else if (flag === '-p' || flag === '--port') opts.port = readPort(take(), opts.port);
    else if (flag === '--root') {
      const value = take();
      if (value) opts.root = value;
    } else if (opts.unknown === null) opts.unknown = arg;
  }
  // The demo root is decided here and nowhere else, and it wins over `--root` on purpose: the
  // stage wipes and recreates whatever directory it is handed, and the one directory that is
  // safe to wipe is the one this process names itself, under the temp directory.
  if (opts.demo) opts.root = demoRoot();
  return opts;
}

/** Where `--demo` writes. Under the OS temp directory, so no path leads from it to a real transcript. */
export const demoRoot = (): string => join(tmpdir(), 'roundtable-demo-root');

/** The address to print, and to open. `localhost` because that is what a person recognises. */
export const appUrl = (port: number): string => `http://localhost:${port}`;

/**
 * Start the hub with the built client attached.
 *
 * The client directory is passed in rather than derived here: this module is bundled into
 * `dist/server/`, and a path guessed relative to a bundle is a path that breaks the first time the
 * layout changes. The launcher knows where it is installed, so the launcher says.
 */
export async function run(opts: CliOptions, clientDir: string): Promise<StopServer> {
  // Staged before the hub starts, so its first sweep already finds two sessions to attach.
  const room = opts.demo ? stageDemoRoom(opts.root) : null;
  let stop: StopServer;
  try {
    stop = await startServer(opts.root, opts.port, {
      clientDir,
      // The demo writes in bursts a few seconds apart; polling at 200ms keeps every burst a beat
      // rather than a lump, on every platform. A real directory keeps the hub's own default.
      ...(room ? { usePolling: true, interval: 200 } : {}),
      onError: (err, ctx) => {
        console.error(`[roundtable] ${ctx}:`, err);
      },
    });
  } catch (err) {
    room?.stop();
    if (room) rmSync(opts.root, { recursive: true, force: true });
    throw err;
  }
  if (!room) return stop;
  // The staged root is this process's to create, so it is this process's to remove: the watcher
  // is closed first, and the directory goes after it, exactly as `npm run demo` does on Ctrl+C.
  return async () => {
    room.stop();
    await stop();
    rmSync(opts.root, { recursive: true, force: true });
  };
}

/** Where `--gif --demo` stages its session. Its own directory, never the live demo's. */
export const showcaseRoot = (): string => join(tmpdir(), 'roundtable-showcase-root');

const mb = (bytes: number): string => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

const span = (ms: number): string => {
  const m = Math.round(ms / 60_000);
  if (m < 1) return `${Math.max(1, Math.round(ms / 1000))} s`;
  if (m < 90) return `${m} min`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h} h` : `${Math.round(h / 24)} days`;
};

const tok = (n: number): string =>
  n >= 1e9 ? `${(n / 1e9).toFixed(2)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n);

/**
 * `--gif`: read one session, play it into a file, and say what was written.
 *
 * Returns the lines to print rather than printing them, so the whole path — which session, what the
 * file holds, what it does and does not show — is something a test can read.
 */
export async function makeClip(opts: CliOptions, cwd: string = process.cwd()): Promise<string> {
  const staged = opts.demo ? showcaseRoot() : null;
  if (staged) stageShowcase(staged);
  try {
    const root = staged ?? opts.root;
    // `--demo` wins over `--session` the way it wins over `--root`: the staged directory holds one
    // session, and an id meant for the real one can only fail to match it. The plugin's `gif`
    // command always passes the id of the session it runs in, so `/roundtable:gif --demo` sent both.
    const got = await collectSession(root, staged ? undefined : (opts.session ?? undefined));
    const clip = renderClip(got.evs, {
      ...CLIP_DEFAULTS,
      seconds: opts.seconds,
      bare: opts.bare,
      full: opts.full,
    });
    const id = got.session.sessionId;
    const file = resolve(cwd, opts.out ?? (staged ? 'roundtable-demo.gif' : `roundtable-${id.slice(0, 8)}.gif`));
    writeFileSync(file, clip.gif);

    const title = got.session.title ?? got.session.label;
    const lines = [
      `[roundtable] ${staged ? 'the staged demo session' : `session ${id.slice(0, 8)}`}${title ? ` — ${title}` : ''}`,
      `[roundtable] wrote ${file}`,
      `             ${(clip.clipMs / 1000).toFixed(1)} s · ${clip.width}×${clip.height} · ${mb(clip.gif.length)}`,
      `             ${clip.agents} ${clip.agents === 1 ? 'agent' : 'agents'} · ${tok(clip.tokens)} tokens · ` +
        (clip.windowed
          ? `the busiest ${span(clip.shownTo - clip.shownFrom)} of ${span(clip.realMs)} (--full for all of it)`
          : `${span(clip.realMs)} of session at ${clip.speed.toFixed(1)}x`),
    ];
    if (!staged && !opts.bare) {
      lines.push(`             It shows this session's task, agent names and speech. Look before you post, or use --bare.`);
    }
    if (!staged && !opts.session) {
      const others = got.sessions.filter((s) => s.sessionId !== id).slice(0, 3);
      if (others.length > 0) {
        lines.push(`             Another session: --session <id>. Recent ones:`);
        for (const s of others) lines.push(`               ${s.sessionId.slice(0, 8)}  ${s.title ?? s.label ?? ''}`.trimEnd());
      }
    }
    return lines.join('\n');
  } finally {
    if (staged) rmSync(staged, { recursive: true, force: true });
  }
}

/** What to say when the port is taken, which is nearly always a second copy of the app. */
export const busyMessage = (port: number): string =>
  `[roundtable] port ${port} is already in use — Roundtable is probably already running.\n` +
  `             Open ${appUrl(port)}, or start this one on another port with --port.`;

export { DEFAULT_HUB_PORT, HUB_HOST };
// Re-exported through the CLI bundle on purpose: `dist/server/cli.mjs` is the one file the
// launcher imports, and a second entry point would be a second thing to keep in step.
export { collectStats, formatStats } from './stats';
