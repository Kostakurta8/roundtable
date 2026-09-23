/**
 * The only test that proves `npx claude-roundtable` works: pack the package, install the tarball
 * into an empty directory the way a stranger would, run the installed binary against a staged
 * transcript root, and check that the page loads, the socket opens from the page's own origin,
 * and the roster names the session.
 *
 * Nothing here imports the source. If it passes, the published artefact is what works.
 */
import { execFileSync, spawn } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { WebSocket } from 'ws';

const repo = resolve('.');
const work = mkdtempSync(join(tmpdir(), 'rt-smoke-'));
const PORT = 7499;
const fail = (msg) => {
  console.error('FAIL:', msg);
  process.exitCode = 1;
};

console.log('[smoke] work dir', work);

// 1. pack
const tarName = execFileSync('npm', ['pack', '--silent', '--pack-destination', work], {
  cwd: repo,
  encoding: 'utf8',
  shell: process.platform === 'win32',
}).trim().split('\n').pop();
const tarball = join(work, tarName);
console.log('[smoke] packed', tarName);

// 2. install it as a stranger would
const consumer = join(work, 'consumer');
mkdirSync(consumer, { recursive: true });
writeFileSync(join(consumer, 'package.json'), JSON.stringify({ name: 'consumer', private: true, version: '1.0.0' }));
execFileSync('npm', ['install', tarball, '--no-audit', '--no-fund', '--silent'], {
  cwd: consumer,
  stdio: 'inherit',
  shell: process.platform === 'win32',
});
console.log('[smoke] installed');

// 3. a transcript root to observe, built from the repo's own fixtures
const root = join(work, 'claude-home');
const slug = join(root, 'projects', 'demo');
mkdirSync(slug, { recursive: true });
copyFileSync(join(repo, 'fixtures', 'main-session.jsonl'), join(slug, 'fix-sess.jsonl'));

// 4. run the installed binary — the real entry point, not a source import
const binJs = join(consumer, 'node_modules', 'claude-roundtable', 'bin', 'roundtable.mjs');
const child = spawn(process.execPath, [binJs, '--root', root, '--port', String(PORT), '--no-open'], {
  cwd: consumer,
  stdio: ['ignore', 'pipe', 'pipe'],
});
let out = '';
child.stdout.on('data', (d) => (out += d.toString()));
child.stderr.on('data', (d) => (out += d.toString()));

const until = async (fn, ms, what) => {
  const stop = Date.now() + ms;
  while (Date.now() < stop) {
    try {
      const v = await fn();
      if (v) return v;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`timed out waiting for ${what}\n--- process output ---\n${out}`);
};

try {
  // 5. the page
  const html = await until(
    async () => {
      const res = await fetch(`http://127.0.0.1:${PORT}/`);
      return res.ok ? await res.text() : null;
    },
    30000,
    'the page',
  );
  if (!html.includes(`window.__ROUNDTABLE_WS__="ws://127.0.0.1:${PORT}/ws"`)) fail('page does not carry the socket URL');
  const script = /src="([^"]+\.js)"/.exec(html)?.[1];
  if (!script) fail('page names no script');
  else {
    const js = await fetch(`http://127.0.0.1:${PORT}${script}`);
    if (!js.ok) fail(`the bundle 404s: ${script}`);
    const ct = js.headers.get('content-type') ?? '';
    if (!ct.includes('javascript')) fail(`bundle served as ${ct}`);
    const body = await js.text();
    if (body.length < 50_000) fail(`bundle suspiciously small: ${body.length} bytes`);
  }

  // 6. the socket, from the origin the served page actually has
  const roster = await new Promise((res, rej) => {
    const sock = new WebSocket(`ws://127.0.0.1:${PORT}/ws`, { origin: `http://localhost:${PORT}` });
    const timer = setTimeout(() => rej(new Error('no hello in 10s')), 10000);
    sock.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.kind === 'hello') {
        clearTimeout(timer);
        sock.close();
        res(msg);
      }
    });
    sock.on('error', (e) => {
      clearTimeout(timer);
      rej(e);
    });
  });
  const ids = (roster.sessions ?? []).map((s) => s.sessionId);
  if (!ids.includes('fix-sess')) fail(`roster does not name the staged session: ${JSON.stringify(ids)}`);
  if (roster.root !== root) fail(`observing ${roster.root}, not ${root}`);

  // 7. a page from somewhere else still gets nothing
  const evil = await new Promise((res) => {
    const sock = new WebSocket(`ws://127.0.0.1:${PORT}/ws`, { origin: 'http://evil.example' });
    sock.on('open', () => res('open'));
    sock.on('error', (e) => res(`rejected: ${e.message}`));
  });
  if (evil === 'open') fail('a foreign origin opened the socket');

  // 8. and it cannot read outside the client directory
  const escape = await fetch(`http://127.0.0.1:${PORT}/../../package.json`);
  if (escape.status === 200 && (await escape.text()).includes('claude-roundtable')) fail('path traversal served a real file');

  // 9. --help and --version work without starting anything
  const help = execFileSync(process.execPath, [binJs, '--help'], { encoding: 'utf8' });
  if (!help.includes('claude-roundtable')) fail('--help says nothing useful');
  const version = execFileSync(process.execPath, [binJs, '--version'], { encoding: 'utf8' }).trim();
  const expected = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8')).version;
  if (version !== expected) fail(`--version says ${version}, package says ${expected}`);

  // 9b. --stats reads a root and prints a report without starting a server. Pointed at an empty
  //     directory on purpose: the packaged build must survive a machine with no sessions at all,
  //     which is exactly the machine someone runs this on first.
  const emptyRoot = mkdtempSync(join(tmpdir(), 'rt-smoke-empty-'));
  const stats = execFileSync(process.execPath, [binJs, '--stats', '--root', emptyRoot], { encoding: 'utf8' });
  if (!stats.includes('--stats')) fail('--stats printed no header');
  if (!stats.includes('0 session transcripts')) fail('--stats did not report an empty root as empty');
  if (!stats.includes('nothing left this machine')) fail('--stats dropped the read-only statement');

  // 9c. --demo --gif renders the staged session into a file in the working directory, through the
  //     packaged bundle — the renderer and the encoder are the two parts of the app the page never
  //     loads, so nothing else in this script would notice them missing from the tarball.
  const gifDir = mkdtempSync(join(tmpdir(), 'rt-smoke-gif-'));
  const gifOut = execFileSync(process.execPath, [binJs, '--demo', '--gif', '--seconds', '4'], { encoding: 'utf8', cwd: gifDir });
  const gif = readFileSync(join(gifDir, 'roundtable-demo.gif'));
  if (gif.subarray(0, 6).toString('ascii') !== 'GIF89a') fail('--demo --gif did not write a GIF');
  if (!gifOut.includes(' agents · ')) fail('--gif did not say what it wrote');
  rmSync(gifDir, { recursive: true, force: true });

  // 10. --demo stages its own root under the temp directory and serves it, with nothing of the
  //     consumer's read. A second port, a second process, the same checks as steps 5 and 6.
  const DEMO_PORT = PORT + 1;
  const demo = spawn(process.execPath, [binJs, '--demo', '--port', String(DEMO_PORT), '--no-open'], {
    cwd: consumer,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let demoOut = '';
  demo.stdout.on('data', (d) => (demoOut += d.toString()));
  demo.stderr.on('data', (d) => (demoOut += d.toString()));
  try {
    const demoHtml = await until(
      async () => {
        const res = await fetch(`http://127.0.0.1:${DEMO_PORT}/`);
        return res.ok ? await res.text() : null;
      },
      30000,
      'the demo page',
    );
    if (!demoHtml.includes(`window.__ROUNDTABLE_WS__="ws://127.0.0.1:${DEMO_PORT}/ws"`)) fail('demo page does not carry the socket URL');
    const demoRoster = await new Promise((res, rej) => {
      const sock = new WebSocket(`ws://127.0.0.1:${DEMO_PORT}/ws`, { origin: `http://localhost:${DEMO_PORT}` });
      const timer = setTimeout(() => rej(new Error('no demo hello in 10s')), 10000);
      sock.on('message', (data) => {
        const msg = JSON.parse(data.toString());
        if (msg.kind === 'hello') {
          clearTimeout(timer);
          sock.close();
          res(msg);
        }
      });
      sock.on('error', (e) => {
        clearTimeout(timer);
        rej(e);
      });
    });
    const demoIds = (demoRoster.sessions ?? []).map((s) => s.sessionId);
    if (!demoIds.includes('demo-7f2a91')) fail(`demo roster does not name the staged session: ${JSON.stringify(demoIds)}`);
    if (!String(demoRoster.root).startsWith(tmpdir())) fail(`--demo observes ${demoRoster.root}, which is not under the temp directory`);
    if (!demoOut.includes('--demo')) fail('the launcher did not say it was running a demo');
  } finally {
    demo.kill();
  }

  if (!process.exitCode) console.log(`[smoke] PASS — page, bundle, socket, origin gate, traversal, --help, --version, --stats, --gif, --demo (v${version})`);
} catch (err) {
  fail(err.message);
} finally {
  child.kill();
  try {
    rmSync(work, { recursive: true, force: true, maxRetries: 3 });
  } catch {
    /* Windows holds the tarball briefly */
  }
}
