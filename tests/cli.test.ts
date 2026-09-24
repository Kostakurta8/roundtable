import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { appUrl, busyMessage, HELP, parseArgs, run, type CliOptions, type Running } from '../server/cli';
import { DEMO_SESSIONS, demoRootPrefix } from '../scripts/promo/demoRoom';
import { DEFAULT_HUB_PORT } from '../shared/net';

/**
 * The installed command's argument handling.
 *
 * Worth its own file because this is the one part of the app a user types at, and the two things
 * they are most likely to get wrong — the port and the root — both fail the same silent way: an
 * app that starts, looks perfectly normal, and observes nothing.
 */
describe('parseArgs', () => {
  it('defaults to the hub port and the real Claude directory', () => {
    const opts = parseArgs([], {});
    expect(opts.port).toBe(DEFAULT_HUB_PORT);
    expect(opts.root).toMatch(/[\\/]\.claude$/);
    expect(opts.open).toBe(true);
    expect(opts.unknown).toBeNull();
  });

  it('takes the port either way round', () => {
    expect(parseArgs(['--port', '9000'], {}).port).toBe(9000);
    expect(parseArgs(['--port=9000'], {}).port).toBe(9000);
    expect(parseArgs(['-p', '9000'], {}).port).toBe(9000);
  });

  it('lets the environment set the port, and the flag beat it', () => {
    expect(parseArgs([], { ROUNDTABLE_PORT: '8000' }).port).toBe(8000);
    expect(parseArgs(['--port', '9000'], { ROUNDTABLE_PORT: '8000' }).port).toBe(9000);
  });

  it('falls back rather than binding a port nobody can dial', () => {
    // `readPort`'s rule, reached through the CLI: 0 means "any free port" to `listen`, which is a
    // hub the page cannot find. A typo must not be the reason the app cannot connect to itself.
    expect(parseArgs(['--port', '0'], {}).port).toBe(DEFAULT_HUB_PORT);
    expect(parseArgs(['--port', 'abc'], {}).port).toBe(DEFAULT_HUB_PORT);
    expect(parseArgs(['--port'], {}).port).toBe(DEFAULT_HUB_PORT);
  });

  it('observes the root it is given, and ignores an empty one', () => {
    expect(parseArgs(['--root', '/tmp/demo'], {}).root).toBe('/tmp/demo');
    expect(parseArgs(['--root=/tmp/demo'], {}).root).toBe('/tmp/demo');
    expect(parseArgs(['--root', ''], { ROUNDTABLE_HOME: '/env/home' }).root).toBe('/env/home');
  });

  it('reports an unrecognised option instead of ignoring it', () => {
    // Silently ignoring `--prot 9000` leaves the hub on 7411 and the user certain it is on 9000.
    expect(parseArgs(['--prot', '9000'], {}).unknown).toBe('--prot');
    expect(parseArgs(['--no-open'], {}).unknown).toBeNull();
  });

  it('keeps the first unknown option, not the last', () => {
    expect(parseArgs(['--first', '--second'], {}).unknown).toBe('--first');
  });

  it('recognises help and version under both spellings', () => {
    expect(parseArgs(['-h'], {}).help).toBe(true);
    expect(parseArgs(['--help'], {}).help).toBe(true);
    expect(parseArgs(['-v'], {}).version).toBe(true);
    expect(parseArgs(['--version'], {}).version).toBe(true);
  });

  it('turns the browser off when asked', () => {
    expect(parseArgs(['--no-open'], {}).open).toBe(false);
  });

  it('points --demo at a directory of its own, whatever --root said', () => {
    // The stage wipes the directory it is handed. With --demo, `root` is only the temp-directory
    // prefix `run` makes a fresh directory from — never a path a person typed — and parsing creates
    // nothing, so `--demo --help` leaves no directory behind.
    const opts = parseArgs(['--demo', '--root', '/home/someone/.claude'], { ROUNDTABLE_HOME: '/env/home' });
    expect(opts.demo).toBe(true);
    expect(opts.root).toBe(demoRootPrefix());
    expect(opts.root.startsWith(tmpdir())).toBe(true);
    expect(existsSync(opts.root)).toBe(false);
    expect(parseArgs([], {}).demo).toBe(false);
  });
});

describe('run --demo', () => {
  const stops: (() => Promise<void>)[] = [];
  const dirs: string[] = [];
  afterEach(async () => {
    for (const stop of stops.splice(0)) await stop().catch(() => {});
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  /** A stand-in for `dist/client`: one page is enough for the hub to have something to serve. */
  const fakeClient = (): string => {
    const dir = mkdtempSync(join(tmpdir(), 'rt-cli-client-'));
    dirs.push(dir);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'index.html'), '<!doctype html><html><head></head><body></body></html>');
    return dir;
  };

  /**
   * A demo on the first free port in 7480-7494, so the suite can run beside the app and beside
   * itself. Its stop is queued for `afterEach` too; stopping twice is harmless.
   */
  const startDemo = async (over: Partial<CliOptions> = {}): Promise<Running & { port: number }> => {
    const base = parseArgs(['--demo', '--no-open'], {});
    for (let port = 7480; port < 7495; port++) {
      try {
        const running = await run({ ...base, ...over, port }, fakeClient());
        stops.push(running.stop);
        dirs.push(running.root);
        return { ...running, port };
      } catch (err) {
        if ((err as { code?: string }).code !== 'EADDRINUSE') throw err;
      }
    }
    throw new Error('no free port in 7480-7494');
  };

  const hello = (port: number): Promise<{ sessions: { sessionId: string }[]; root: string }> =>
    new Promise((resolve, reject) => {
      const sock = new WebSocket(`ws://127.0.0.1:${port}/ws`, { origin: `http://localhost:${port}` });
      const timer = setTimeout(() => reject(new Error('no hello in 10s')), 10_000);
      sock.on('message', (data) => {
        const msg = JSON.parse(data.toString());
        if (msg.kind === 'hello') {
          clearTimeout(timer);
          sock.close();
          resolve(msg);
        }
      });
      sock.on('error', reject);
    });

  it('stages a room the roster names, and removes it again on stop', async () => {
    const demo = await startDemo();
    expect(demo.root.startsWith(demoRootPrefix())).toBe(true);
    expect(existsSync(join(demo.root, 'sessions'))).toBe(true);

    const got = await hello(demo.port);
    const ids = got.sessions.map((s) => s.sessionId);
    for (const id of DEMO_SESSIONS) expect(ids).toContain(id);
    expect(got.root).toBe(demo.root);

    await demo.stop();
    // The staged root was this run's to create, so it is gone once the hub is.
    expect(existsSync(demo.root)).toBe(false);
  });

  it('gives two demos two directories, and stopping one leaves the other serving', async () => {
    // What a shared fixed path did: the second demo's stage wiped the first one's room, and the
    // first to exit deleted the directory the other hub was still watching.
    const a = await startDemo();
    const b = await startDemo();
    expect(a.root).not.toBe(b.root);
    for (const d of [a, b]) {
      expect(d.root.startsWith(tmpdir())).toBe(true);
      expect(existsSync(join(d.root, 'sessions'))).toBe(true);
    }

    await a.stop();
    expect(existsSync(a.root)).toBe(false);
    expect(existsSync(join(b.root, 'sessions'))).toBe(true);
    const still = await hello(b.port);
    expect(still.root).toBe(b.root);
    for (const id of DEMO_SESSIONS) expect(still.sessions.map((s) => s.sessionId)).toContain(id);

    await b.stop();
    expect(existsSync(b.root)).toBe(false);
  });

  it('never stages into, or deletes, a root it was handed', async () => {
    // `run` is exported, so the rule cannot live in `parseArgs` alone: a caller that builds its own
    // options with `demo` set and a real directory in `root` still gets a directory made for it.
    const mine = mkdtempSync(join(tmpdir(), 'rt-cli-mine-'));
    dirs.push(mine);
    writeFileSync(join(mine, 'keep.txt'), 'a file somebody cares about');
    const demo = await startDemo({ root: mine });
    expect(demo.root).not.toBe(mine);

    await demo.stop();
    expect(existsSync(join(mine, 'keep.txt'))).toBe(true);
    expect(existsSync(join(mine, 'sessions'))).toBe(false);
  });
});

describe('what the CLI prints', () => {
  it('names the address in a form a person can click', () => {
    expect(appUrl(7411)).toBe('http://localhost:7411');
  });

  it('explains a busy port as the second copy it almost always is', () => {
    const msg = busyMessage(7411);
    expect(msg).toContain('already running');
    expect(msg).toContain('http://localhost:7411');
    expect(msg).toContain('--port');
  });

  it('documents every option it accepts', () => {
    // A help text that has drifted from the parser is worse than none: it is a wrong answer to
    // the only question the user thought to ask.
    for (const flag of ['--port', '--root', '--demo', '--no-open', '--version', '--help', '--stats', '--gif', '--out', '--session', '--seconds', '--bare', '--full']) {
      expect(HELP, flag).toContain(flag);
    }
    expect(HELP).toContain('never writes');
  });
});
