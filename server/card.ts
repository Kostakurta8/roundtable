/**
 * `--card`: one session as the share dialog's card, written to a PNG.
 *
 * Nothing about the card is decided here. The session is read the way `--gif` reads it — through a
 * hub of its own on a loopback port (`collectSession`) — the pixels are `renderCard`'s, the function
 * the dialog's worker runs, and the PNG writer is the one the room's review sheets have always used.
 * So the file is the card the app would have offered for the same events; only the compression is
 * node's rather than the browser's, and compression does not change a pixel.
 *
 * **Nothing is written except the file you asked for**, as for `--gif`.
 */
import { rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { encodePng } from '../scripts/pixpreview';
import { stageShowcase } from '../scripts/promo/showcase';
import { cardFacts, costText, renderCard } from '../src/clip/card';
import { collectSession } from './clip';

/** What `--card` reads off the command line: the same options `--gif` takes, less the clip's own. */
export type CardCliOptions = {
  demo: boolean;
  root: string;
  session: string | null;
  out: string | null;
  bare: boolean;
};

/**
 * Where `--card --demo` stages its session. Its own directory, never the live demo's nor the one
 * `--gif --demo` stages and deletes, so `--gif --card --demo` cannot pull a session out from under
 * itself.
 */
export const cardShowcaseRoot = (): string => join(tmpdir(), 'roundtable-card-showcase-root');

const kb = (bytes: number): string => `${Math.max(1, Math.round(bytes / 1024))} KB`;

/**
 * Reads one session, draws its card into a file, and returns the lines to print — so which session,
 * where the file went and what it shows are all something a test can read.
 */
export async function makeCard(opts: CardCliOptions, cwd: string = process.cwd()): Promise<string> {
  const staged = opts.demo ? cardShowcaseRoot() : null;
  if (staged) stageShowcase(staged);
  try {
    // `--demo` wins over `--session`, as it does for `--gif`: the staged directory holds one session.
    const got = await collectSession(staged ?? opts.root, staged ? undefined : (opts.session ?? undefined));
    const card = renderCard(got.evs, { bare: opts.bare });
    const id = got.session.sessionId;
    const file = resolve(cwd, opts.out ?? (staged ? 'roundtable-demo-card.png' : `roundtable-${id.slice(0, 8)}-card.png`));
    const png = encodePng(card.width, card.height, card.rgba);
    writeFileSync(file, png);

    const title = got.session.title ?? got.session.label;
    const lines = [
      `[roundtable] ${staged ? 'the staged demo session' : `session ${id.slice(0, 8)}`}${title ? ` — ${title}` : ''}`,
      `[roundtable] wrote ${file}`,
      `             ${card.width}×${card.height} · ${kb(png.length)} · ${cardFacts(card.stats)} · est ${costText(card.stats)}`,
    ];
    if (!staged && !opts.bare) {
      lines.push(`             It shows this session's task and agent names. Look before you post, or use --bare.`);
    }
    return lines.join('\n');
  } finally {
    if (staged) rmSync(staged, { recursive: true, force: true });
  }
}
