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
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
  /** Whether `--gif` was given too, in which case `--out` is the GIF's and not this file's. */
  gif?: boolean;
};

/**
 * Where `--card --demo` stages its session: a directory made for this run and no other, as `--demo`
 * and `--gif --demo` stage theirs. A fixed name was shared by every run at once, and the first to
 * finish deleted the session the others were still reading.
 */
const stageRoot = (): string => mkdtempSync(join(tmpdir(), 'roundtable-card-showcase-'));

/**
 * The card's file name. `--out` names the one file asked for; asked for a GIF as well, `--out` is
 * the GIF's — `--gif` came first and says so in its help — and the card goes beside it, named after
 * it. Handing both writers the same path wrote the card and then wrote the GIF over it.
 */
export function cardFile(opts: Pick<CardCliOptions, 'out' | 'gif'>, fallback: string): string {
  if (opts.out === null) return fallback;
  if (!opts.gif) return opts.out;
  return `${opts.out.replace(/\.gif$/i, '')}-card.png`;
}

const kb = (bytes: number): string => `${Math.max(1, Math.round(bytes / 1024))} KB`;

/**
 * Reads one session, draws its card into a file, and returns the lines to print — so which session,
 * where the file went and what it shows are all something a test can read.
 */
export async function makeCard(opts: CardCliOptions, cwd: string = process.cwd()): Promise<string> {
  const staged = opts.demo ? stageRoot() : null;
  if (staged) stageShowcase(staged);
  try {
    // `--demo` wins over `--session`, as it does for `--gif`: the staged directory holds one session.
    const got = await collectSession(staged ?? opts.root, staged ? undefined : (opts.session ?? undefined));
    const card = renderCard(got.evs, { bare: opts.bare });
    const id = got.session.sessionId;
    const file = resolve(cwd, cardFile(opts, staged ? 'roundtable-demo-card.png' : `roundtable-${id.slice(0, 8)}-card.png`));
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
