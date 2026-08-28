import { describe, expect, it } from 'vitest';
import {
  allowedOrigins,
  appOrigins,
  DEFAULT_HUB_PORT,
  hubWsUrl,
  pageOrigins,
  readPort,
} from '../shared/net';

describe('readPort', () => {
  it('takes a plain port number out of an environment string', () => {
    expect(readPort('9000', DEFAULT_HUB_PORT)).toBe(9000);
  });

  it('falls back when the variable is unset', () => {
    expect(readPort(undefined, DEFAULT_HUB_PORT)).toBe(DEFAULT_HUB_PORT);
  });

  it('falls back rather than binding port 0, which the OS reads as "any free port"', () => {
    // A typo that silently binds a random port is worse than one that is ignored: the client
    // would go on dialling 7411 and the app would sit at OFFLINE with a hub that is up.
    expect(readPort('0', DEFAULT_HUB_PORT)).toBe(DEFAULT_HUB_PORT);
  });

  it('falls back on anything that is not a whole port', () => {
    for (const bad of ['', '  ', 'abc', '-1', '1.5', '70000', '80x']) {
      expect(readPort(bad, DEFAULT_HUB_PORT)).toBe(DEFAULT_HUB_PORT);
    }
  });
});

describe('hubWsUrl', () => {
  it('always dials loopback — the observer reads one machine, its own', () => {
    expect(hubWsUrl(DEFAULT_HUB_PORT)).toBe('ws://127.0.0.1:7411/ws');
  });

  it('follows the port it is given', () => {
    expect(hubWsUrl(9000)).toBe('ws://127.0.0.1:9000/ws');
  });
});

describe('pageOrigins', () => {
  it('names both loopback spellings of both dev ports, and nothing else', () => {
    expect(pageOrigins(5173, 4173).sort()).toEqual(
      [
        'http://127.0.0.1:4173',
        'http://127.0.0.1:5173',
        'http://localhost:4173',
        'http://localhost:5173',
      ].sort(),
    );
  });

  it('moves with a reconfigured web port, so the gate cannot drift from the server it guards', () => {
    // The whole point of deriving these: a hub on a custom port with an allowlist still naming
    // 5173 is a hub no page can reach, and the failure looks exactly like a crashed server.
    expect(pageOrigins(3000, 4173)).toContain('http://localhost:3000');
    expect(pageOrigins(3000, 4173)).not.toContain('http://localhost:5173');
  });
});

describe('appOrigins', () => {
  it('names the hub’s own port under both loopback spellings', () => {
    expect(appOrigins(7411).sort()).toEqual(
      ['http://127.0.0.1:7411', 'http://localhost:7411'].sort(),
    );
  });

  it('moves with the hub, because installed from npm the page is served by the hub itself', () => {
    // No Vite in a packaged install: page and socket share a port, so the page's own origin is
    // the only one that can ever appear on a handshake. A gate pinned to 7411 would refuse it.
    expect(appOrigins(9000)).toContain('http://localhost:9000');
    expect(appOrigins(9000)).not.toContain('http://localhost:7411');
  });
});

describe('allowedOrigins', () => {
  it('is the dev server’s origins plus the hub’s own, and nothing else', () => {
    expect(allowedOrigins(7411, 5173, 4173).sort()).toEqual(
      [...pageOrigins(5173, 4173), ...appOrigins(7411)].sort(),
    );
  });

  it('still admits the dev server, so installing the package cannot break `npm run dev`', () => {
    expect(allowedOrigins(9000, 5173, 4173)).toContain('http://localhost:5173');
  });

  it('names no origin that is not loopback', () => {
    for (const o of allowedOrigins(7411, 5173, 4173)) {
      expect(o, o).toMatch(/^http:\/\/(localhost|127\.0\.0\.1):\d+$/);
    }
  });
});
