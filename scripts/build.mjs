/**
 * The published build: the page, and the server that serves it.
 *
 * Two outputs under `dist/`, and the layout is load-bearing — `bin/roundtable.mjs` resolves
 * `../dist/client` and `../dist/server/cli.mjs` relative to itself, so moving either one moves the
 * launcher too.
 *
 *   dist/client       what Vite makes of `index.html` and `src/`
 *   dist/server/cli.mjs   the hub, `shared/`, and the argument parsing, in one ESM file
 *
 * The server is bundled rather than compiled file-by-file because the source is TypeScript with
 * extensionless imports: `tsc` would emit `import './hub'`, which Node cannot resolve at runtime,
 * and rewriting every import to carry `.js` is a worse tax than one bundler call. `chokidar` and
 * `ws` stay external — they are real dependencies, npm installs them, and inlining them would
 * bake their platform-specific bits into our file.
 */
import { build as esbuild } from 'esbuild';
import { rmSync } from 'node:fs';
import { build as viteBuild } from 'vite';

rmSync('dist', { recursive: true, force: true });

await viteBuild({
  build: { outDir: 'dist/client', emptyOutDir: true },
  // The dev build reads the hub's port from `import.meta.env` at bundle time. A published bundle
  // cannot: it is built here and run somewhere else, possibly on another port. It falls back to
  // the default, and the hub overrides it in the HTML it serves — see `wsUrlScript`.
  define: { 'import.meta.env.VITE_ROUNDTABLE_PORT': JSON.stringify('') },
});

await esbuild({
  entryPoints: ['server/cli.ts'],
  outfile: 'dist/server/cli.mjs',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22.12',
  external: ['chokidar', 'ws'],
  // Sourcemaps ship: this is a tool people run on their own machine, and a stack trace that names
  // `hub.ts:1400` is the difference between a bug report and a shrug.
  sourcemap: true,
  logLevel: 'info',
});

console.log('[build] dist/client + dist/server/cli.mjs');
