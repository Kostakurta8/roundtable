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
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stageDemoRoom } from '../scripts/promo/demoRoom';
import { DEFAULT_HUB_PORT, HUB_HOST, PORT_ENV, readPort } from '../shared/net';
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
      --no-open    Do not open a browser; just print the address.
  -v, --version    Print the version.
  -h, --help       Print this.

It reads the transcript files Claude Code already writes and never writes to them. Nothing leaves
the machine: the server binds loopback only and makes no outbound connection of any kind.`;

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

/** What to say when the port is taken, which is nearly always a second copy of the app. */
export const busyMessage = (port: number): string =>
  `[roundtable] port ${port} is already in use — Roundtable is probably already running.\n` +
  `             Open ${appUrl(port)}, or start this one on another port with --port.`;

export { DEFAULT_HUB_PORT, HUB_HOST };
// Re-exported through the CLI bundle on purpose: `dist/server/cli.mjs` is the one file the
// launcher imports, and a second entry point would be a second thing to keep in step.
export { collectStats, formatStats } from './stats';
