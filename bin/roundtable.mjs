#!/usr/bin/env node
/**
 * The executable `npx claude-roundtable` runs.
 *
 * Deliberately thin. Everything it decides — arguments, defaults, the address — is decided in
 * `server/cli.ts`, where the type checker and the tests can reach it. What lives here is the part
 * that cannot: knowing where the package is installed, and opening a browser.
 *
 * Opening the browser is a spawned process, and it is the only one in the project. It is here
 * rather than under `server/` on purpose: the hub reads the user's private transcripts, and a
 * program that reads transcripts should not also be one that can run things. `--no-open` skips it
 * and prints the address instead.
 */
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const here = (rel) => fileURLToPath(new URL(rel, import.meta.url));

const pkg = JSON.parse(readFileSync(here('../package.json'), 'utf8'));

// Node 22.12 is the floor for the ESM and fs APIs the hub uses. npm only warns about `engines`,
// and the failure without this is a stack trace from deep inside a dependency.
const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 22 || (major === 22 && minor < 12)) {
  console.error(`[roundtable] needs Node 22.12 or newer; this is ${process.versions.node}.`);
  process.exit(1);
}

// The URL, not the path: on Windows `import()` of `C:\…` fails with ERR_UNSUPPORTED_ESM_URL_SCHEME
// because the drive letter parses as a protocol. `fileURLToPath` is for the filesystem calls below.
const { parseArgs, run, appUrl, busyMessage, HELP } = await import(
  new URL('../dist/server/cli.mjs', import.meta.url).href
);

const opts = parseArgs(process.argv.slice(2), process.env);

if (opts.unknown) {
  console.error(`[roundtable] unknown option: ${opts.unknown}\n`);
  console.error(HELP);
  process.exit(2);
}
if (opts.help) {
  console.log(HELP);
  process.exit(0);
}
if (opts.version) {
  console.log(pkg.version);
  process.exit(0);
}

/** The OS's own "open this address" command. Nothing is interpolated into a shell. */
function openBrowser(url) {
  const [cmd, args] =
    process.platform === 'win32'
      ? ['cmd', ['/c', 'start', '', url]]
      : process.platform === 'darwin'
        ? ['open', [url]]
        : ['xdg-open', [url]];
  try {
    // Detached and unref'd: a browser that outlives this process must not keep it alive, and a
    // machine with no opener at all (a container, a bare server) must not take the app down.
    spawn(cmd, args, { stdio: 'ignore', detached: true }).unref();
  } catch {
    /* the address is printed either way */
  }
}

try {
  const stop = await run(opts, here('../dist/client'));
  const url = appUrl(opts.port);
  console.log(`[roundtable] observing ${opts.root}`);
  console.log(`[roundtable] ${url}`);
  if (opts.open) openBrowser(url);

  const shutdown = () => {
    stop().then(
      () => process.exit(0),
      () => process.exit(1),
    );
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
} catch (err) {
  if (err?.code === 'EADDRINUSE') {
    console.error(busyMessage(opts.port));
  } else {
    console.error(`[roundtable] failed to start on port ${opts.port}:`, err);
  }
  process.exit(1);
}
