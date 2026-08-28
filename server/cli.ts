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
    else if (flag === '-p' || flag === '--port') opts.port = readPort(take(), opts.port);
    else if (flag === '--root') {
      const value = take();
      if (value) opts.root = value;
    } else if (opts.unknown === null) opts.unknown = arg;
  }
  return opts;
}

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
  return startServer(opts.root, opts.port, {
    clientDir,
    onError: (err, ctx) => {
      console.error(`[roundtable] ${ctx}:`, err);
    },
  });
}

/** What to say when the port is taken, which is nearly always a second copy of the app. */
export const busyMessage = (port: number): string =>
  `[roundtable] port ${port} is already in use — Roundtable is probably already running.\n` +
  `             Open ${appUrl(port)}, or start this one on another port with --port.`;

export { DEFAULT_HUB_PORT, HUB_HOST };
