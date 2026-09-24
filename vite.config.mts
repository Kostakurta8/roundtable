import react from '@vitejs/plugin-react';
import { readFileSync } from 'node:fs';
import { defineConfig, type Plugin, type UserConfig } from 'vite';
import { DEFAULT_PREVIEW_PORT, DEFAULT_WEB_PORT, PORT_ENV } from './shared/net';

/**
 * The ports are pinned, and `strictPort` is the point.
 *
 * The hub only accepts WebSocket handshakes whose `Origin` is one of the dev server's own
 * addresses — that gate is the only thing stopping any page the user has open from reading their
 * transcripts. Vite's default behaviour when 5173 is busy is to quietly move to 5174, which the
 * allowlist does not name: the app would come up looking perfectly normal and never connect, with
 * the real reason visible only as a rejected handshake. Failing to start is the honest outcome.
 *
 * The numbers come from `shared/net.ts` rather than being written here, because the gate on the
 * other side is built from the same constants. Two literals that must agree, in two files that
 * never mention each other, is the shape of a bug nobody finds: the symptom is `OFFLINE` in the
 * top bar with a hub that is up and a page that loaded.
 */
const app: UserConfig = {
  plugins: [react()],
  server: { port: DEFAULT_WEB_PORT, strictPort: true },
  preview: { port: DEFAULT_PREVIEW_PORT, strictPort: true },
  /*
   * One variable moves both halves.
   *
   * The hub reads `ROUNDTABLE_PORT` from its own environment, but the client cannot: only
   * `VITE_`-prefixed variables reach `import.meta.env`, and only from a `.env` file at that. So
   * a user who set `ROUNDTABLE_PORT=9000` would move the hub and leave the page dialling 7411 —
   * the app would load, look completely normal, and sit at `OFFLINE` for ever, which is the
   * least debuggable failure this project has.
   *
   * Forwarding it here is what makes the documented variable true for both. The empty-string
   * default is deliberate: `readPort` rejects it and falls back, so an unset variable is the
   * same as no override rather than the literal text `undefined`.
   */
  define: {
    'import.meta.env.VITE_ROUNDTABLE_PORT': JSON.stringify(process.env[PORT_ENV] ?? ''),
  },
};

// ------------------------------------------------------------------ the hosted demo

/** Where `.github/workflows/pages.yml` publishes `dist/pages`. Link unfurls need it absolute. */
const PAGES_URL = 'https://kostakurta8.github.io/roundtable/';

const TITLE = 'Roundtable — watch Claude Code’s subagents work, in a pixel-art office';
const DESCRIPTION =
  'Watch subagents arrive, take a desk, report back and hand down verdicts — a staged replay, running in ' +
  'your browser. Roundtable is a read-only observer for Claude Code; one npx command runs it on your own sessions.';
const IMAGE_ALT = 'Roundtable: a pixel-art office where Claude Code subagents work at desks around a round table.';

/**
 * What a link to the demo unfurls as, on X, Slack, Discord and everywhere else that reads Open
 * Graph. Those previews are how the page travels, and every one of them wants the image as an
 * absolute URL — a relative `og:image` is silently dropped by most of them, leaving a bare link.
 */
const SOCIAL_HEAD = [
  `<title>${TITLE}</title>`,
  `<meta name="description" content="${DESCRIPTION}" />`,
  `<link rel="canonical" href="${PAGES_URL}" />`,
  `<meta property="og:type" content="website" />`,
  `<meta property="og:site_name" content="Roundtable" />`,
  `<meta property="og:title" content="${TITLE}" />`,
  `<meta property="og:description" content="${DESCRIPTION}" />`,
  `<meta property="og:url" content="${PAGES_URL}" />`,
  `<meta property="og:image" content="${PAGES_URL}social-preview.png" />`,
  `<meta property="og:image:width" content="1280" />`,
  `<meta property="og:image:height" content="640" />`,
  `<meta property="og:image:alt" content="${IMAGE_ALT}" />`,
  `<meta name="twitter:card" content="summary_large_image" />`,
  `<meta name="twitter:title" content="${TITLE}" />`,
  `<meta name="twitter:description" content="${DESCRIPTION}" />`,
  `<meta name="twitter:image" content="${PAGES_URL}social-preview.png" />`,
  `<meta name="twitter:image:alt" content="${IMAGE_ALT}" />`,
].join('\n    ');

/**
 * `index.html`, as the demo needs it: the demo's own entry, and a head that unfurls.
 *
 * A transform rather than a second HTML file, so the page the app ships and the page the demo ships
 * cannot drift apart in everything but these two edits — the favicon, the viewport, the root node
 * all stay the one copy. Each edit must find what it replaces or the build stops: a demo built from
 * `src/main.tsx` would be the local app on a public page, dialling a hub on the visitor's loopback.
 */
function pagesHtml(): Plugin {
  const swap = (html: string, from: RegExp | string, to: string): string => {
    const out = html.replace(from, to);
    if (out === html) throw new Error(`build:pages: index.html no longer contains ${String(from)}`);
    return out;
  };
  return {
    name: 'roundtable-pages',
    transformIndexHtml: {
      order: 'pre',
      handler: (html) => swap(swap(html, '/src/main.tsx', '/src/demo/main.tsx'), /<title>[^<]*<\/title>/, SOCIAL_HEAD),
    },
    generateBundle() {
      // The same card the repository uses for its own social preview, at the one path the tags name.
      this.emitFile({ type: 'asset', fileName: 'social-preview.png', source: readFileSync('media/social-preview.png') });
    },
  };
}

/**
 * `vite build --mode pages`: the static demo for GitHub Pages.
 *
 * Served from a project page, so every asset is under `/roundtable/`; written to its own directory
 * so it never lands in `dist/client`, which is what the npm package ships. The hub port is blanked
 * for the same reason `scripts/build.mjs` blanks it — a value from whoever ran the build means
 * nothing on a page with no hub — though the demo never opens a socket to use it.
 */
const pages: UserConfig = {
  ...app,
  base: '/roundtable/',
  plugins: [react(), pagesHtml()],
  build: { outDir: 'dist/pages', emptyOutDir: true },
  define: { 'import.meta.env.VITE_ROUNDTABLE_PORT': JSON.stringify('') },
};

export default defineConfig(({ mode }) => (mode === 'pages' ? pages : app));
