import { describe, expect, it } from 'vitest';
import { appUrl, busyMessage, HELP, parseArgs } from '../server/cli';
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
    for (const flag of ['--port', '--root', '--no-open', '--version', '--help']) {
      expect(HELP, flag).toContain(flag);
    }
    expect(HELP).toContain('never writes');
  });
});
