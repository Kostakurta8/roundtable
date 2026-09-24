import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { appUrl, busyMessage, demoRoot, HELP, parseArgs, run } from '../server/cli';
import { DEMO_SESSIONS } from '../scripts/promo/demoRoom';
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

  it('takes --card with the options it shares with --gif, and alongside it', () => {
    expect(parseArgs(['--card', '--out', 'c.png', '--session', 'abc', '--bare'], {})).toMatchObject({
      card: true,
      gif: false,
      out: 'c.png',
      session: 'abc',
      bare: true,
      unknown: null,
    });
    expect(parseArgs(['--gif', '--card'], {})).toMatchObject({ card: true, gif: true });
    expect(parseArgs([], {}).card).toBe(false);
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
    // The stage wipes the directory it is handed. The only directory it may ever be handed is the
    // one this process names under the temp directory — never a path a person typed.
    const opts = parseArgs(['--demo', '--root', '/home/someone/.claude'], { ROUNDTABLE_HOME: '/env/home' });
    expect(opts.demo).toBe(true);
    expect(opts.root).toBe(demoRoot());
    expect(opts.root.startsWith(tmpdir())).toBe(true);
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

  it('stages a room the roster names, and removes it again on stop', async () => {
    // Not the shared demo root: a test must not wipe a demo somebody is watching right now.
    const root = mkdtempSync(join(tmpdir(), 'rt-cli-demo-'));
    dirs.push(root);
    const base = parseArgs(['--demo', '--no-open'], {});
    let stop: (() => Promise<void>) | undefined;
    let port = 0;
    for (let p = 7480; p < 7495; p++) {
      try {
        stop = await run({ ...base, root, port: p }, fakeClient());
        port = p;
        break;
      } catch (err) {
        if ((err as { code?: string }).code !== 'EADDRINUSE') throw err;
      }
    }
    if (!stop) throw new Error('no free port in 7480-7494');
    stops.push(stop);

    expect(existsSync(join(root, 'sessions'))).toBe(true);
    const hello = await new Promise<{ sessions: { sessionId: string }[]; root: string }>((resolve, reject) => {
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
    const ids = hello.sessions.map((s) => s.sessionId);
    for (const id of DEMO_SESSIONS) expect(ids).toContain(id);
    expect(hello.root).toBe(root);

    await stops.pop()!();
    // The staged root was this process's to create, so it is gone once the hub is.
    expect(existsSync(root)).toBe(false);
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
    for (const flag of ['--port', '--root', '--demo', '--no-open', '--version', '--help', '--stats', '--gif', '--card', '--out', '--session', '--seconds', '--bare', '--full']) {
      expect(HELP, flag).toContain(flag);
    }
    expect(HELP).toContain('never writes');
  });
});
