/** @vitest-environment jsdom */

/**
 * The clip renderer both halves run: `--gif` in the CLI and the Share dialog's browser worker.
 *
 * It moved out of `server/clip.ts` so a browser could load it, and the way that goes wrong is
 * quietly: someone adds one `import { … } from 'node:fs'` three modules down, or one `Buffer.from`,
 * node goes on running it happily, every CLI test stays green, and the Share button breaks in the
 * only place none of those tests look. So the graph is walked from the two entry points and held to
 * what a worker can load, and the renderer is run here, in jsdom, with `Buffer` taken away.
 */
import { readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Ev } from '../shared/events';
import { Normalizer } from '../server/normalize';
import { parseLine } from '../server/parse';
import { renderClip as renderForCli } from '../server/clip';
import { renderCard } from '../src/clip/card';
import { CLIP_DEFAULTS, renderClip, type ClipProgress } from '../src/clip/render';

const ROOT = resolve(__dirname, '..');

/** Comments out, so a sentence that says "never `Buffer`" is not mistaken for a use of it. */
const code = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');

const SPECIFIERS = [
  /(?:^|\n)\s*(?:import|export)\s[^'"`;]*?from\s*['"]([^'"]+)['"]/g,
  /(?:^|\n)\s*import\s*['"]([^'"]+)['"]/g,
  /\bimport\(\s*['"]([^'"]+)['"]\s*\)/g,
];

function specifiersOf(src: string): string[] {
  const out: string[] = [];
  for (const re of SPECIFIERS) for (const m of src.matchAll(re)) out.push(m[1]);
  return out;
}

function resolveLocal(from: string, spec: string): string {
  const base = resolve(dirname(from), spec);
  for (const file of [base, `${base}.ts`, `${base}.tsx`, join(base, 'index.ts')]) {
    try {
      readFileSync(file);
      return file;
    } catch {
      // try the next spelling
    }
  }
  throw new Error(`${relative(ROOT, from)} imports ${spec}, which does not resolve`);
}

/** Every module reachable from `entry`, with every specifier each one imports. */
function graph(entry: string): Map<string, string[]> {
  const seen = new Map<string, string[]>();
  const todo = [resolve(ROOT, entry)];
  while (todo.length > 0) {
    const file = todo.pop()!;
    if (seen.has(file)) continue;
    const specs = specifiersOf(code(readFileSync(file, 'utf8')));
    seen.set(file, specs);
    for (const s of specs) if (s.startsWith('.')) todo.push(resolveLocal(file, s));
  }
  return seen;
}

/** A whole session: the orchestrator's transcript and its subagent's, through the real normalizer. */
function fixtureSession(): Ev[] {
  const feed = (file: string, agentId: string): Ev[] => {
    const n = new Normalizer('fix-sess', agentId);
    return readFileSync(join(ROOT, 'fixtures', file), 'utf8')
      .split('\n')
      .filter(Boolean)
      .flatMap((l) => {
        const r = parseLine(l);
        return r ? n.feed(r) : [];
      });
  };
  return [...feed('main-session.jsonl', 'main'), ...feed('agent-abc123.jsonl', 'abc123')];
}

describe('the clip module graph', () => {
  for (const entry of ['src/clip/render.ts', 'src/clip/card.ts', 'src/clip/worker.ts']) {
    describe(entry, () => {
      const g = graph(entry);
      const files = [...g.keys()].map((f) => relative(ROOT, f).replaceAll('\\', '/'));

      it('actually walks the renderer, so an empty walk cannot pass', () => {
        for (const f of ['src/clip/gif.ts', 'src/clip/softctx.ts', 'src/office/pixel/scene.ts', 'src/store.ts', 'shared/events.ts']) {
          expect(files, f).toContain(f);
        }
      });

      it('imports nothing from node, and no package at all', () => {
        const bad = [...g].flatMap(([file, specs]) =>
          specs.filter((s) => !s.startsWith('.')).map((s) => `${relative(ROOT, file)} → ${s}`),
        );
        expect(bad).toEqual([]);
      });

      it('never reaches into server/ or scripts/, and loads no stylesheet', () => {
        expect(files.filter((f) => f.startsWith('server/') || f.startsWith('scripts/'))).toEqual([]);
        const css = [...g.values()].flat().filter((s) => s.endsWith('.css'));
        expect(css).toEqual([]);
      });

      it('touches no node global and no bundler global', () => {
        const uses = [...g.keys()].flatMap((file) => {
          const src = code(readFileSync(file, 'utf8'));
          return [/\bprocess\s*\./, /\bBuffer\b/, /\bimport\.meta\b/, /\brequire\s*\(/, /\b__dirname\b/]
            .filter((re) => re.test(src))
            .map((re) => `${relative(ROOT, file)}: ${re.source}`);
        });
        expect(uses).toEqual([]);
      });
    });
  }
});

describe('renderClip, where a browser would run it', () => {
  const evs = fixtureSession();
  const opts = { ...CLIP_DEFAULTS, seconds: 3, scale: 1 };

  it('makes a GIF with no Buffer in the world', () => {
    const g = globalThis as { Buffer?: unknown };
    const saved = g.Buffer;
    delete g.Buffer;
    let gif: Uint8Array;
    try {
      gif = renderClip(evs, opts).gif;
    } finally {
      g.Buffer = saved;
    }
    expect(gif).toBeInstanceOf(Uint8Array);
    expect(Buffer.isBuffer(gif)).toBe(false);
    expect(String.fromCharCode(...gif.subarray(0, 6))).toBe('GIF89a');
    // Its own buffer, exactly its size: what the worker transfers is the file and nothing else.
    expect(gif.byteOffset).toBe(0);
    expect(gif.byteLength).toBe(gif.buffer.byteLength);
  }, 30_000);

  it('reports every frame drawn and then every frame encoded, in that order', () => {
    const seen: ClipProgress[] = [];
    const c = renderClip(evs, opts, (p) => seen.push(p));
    const draw = seen.filter((p) => p.phase === 'draw');
    const encode = seen.filter((p) => p.phase === 'encode');
    expect(seen.findIndex((p) => p.phase === 'encode')).toBe(draw.length);
    expect(draw.map((p) => p.done)).toEqual(Array.from({ length: c.frames }, (_, i) => i + 1));
    expect(encode.map((p) => p.done)).toEqual(Array.from({ length: c.frames }, (_, i) => i + 1));
    expect(new Set(seen.map((p) => p.total))).toEqual(new Set([c.frames]));
  });

  it('is the file the CLI writes: the same bytes, only the CLI gets them as a Buffer', () => {
    const browser = renderClip(evs, opts);
    const cli = renderForCli(evs, opts);
    expect(Buffer.isBuffer(cli.gif)).toBe(true);
    expect(Buffer.from(browser.gif).equals(cli.gif)).toBe(true);
    // Listening changes nothing about what is made.
    expect(Buffer.from(renderClip(evs, opts, () => {}).gif).equals(cli.gif)).toBe(true);
  }, 30_000);
});

describe('renderCard, where a browser would run it', () => {
  it('draws the card with no Buffer in the world, into pixels a worker can hand over whole', () => {
    const g = globalThis as { Buffer?: unknown };
    const saved = g.Buffer;
    delete g.Buffer;
    let card: ReturnType<typeof renderCard>;
    try {
      card = renderCard(fixtureSession());
    } finally {
      g.Buffer = saved;
    }
    expect(card.rgba).toBeInstanceOf(Uint8ClampedArray);
    expect(card.rgba.length).toBe(card.width * card.height * 4);
    // Its own buffer, exactly its size: the worker transfers it rather than copying three megabytes.
    expect(card.rgba.byteOffset).toBe(0);
    expect(card.rgba.byteLength).toBe(card.rgba.buffer.byteLength);
  });
});
