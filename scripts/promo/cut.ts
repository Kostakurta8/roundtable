/**
 * The cut.
 *
 * Reads `marks.json` — the moment each beat actually happened during the take — and turns the one
 * long recording into the trailer plus the press kit's b-roll. Every window is expressed as an
 * offset from a *mark*, never as an absolute timecode, so a retake with different timings needs no
 * edit here: re-run `record.ts`, re-run this, and the same beats come out.
 *
 * Captions are burned per segment rather than as one subtitle track over the finished file. It
 * costs nothing, it keeps `libass` and its Windows path escaping out of the build entirely, and it
 * means a segment whose caption is wrong can be re-cut on its own — the concat that follows is a
 * stream copy, so nothing else is even re-encoded.
 *
 *   npx tsx scripts/promo/cut.ts
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const OUT = join(homedir(), 'Desktop', 'roundtable promo');
const KIT = join(OUT, 'presskit');
const BROLL = join(KIT, 'broll');
const WORK = join(OUT, 'segments');

/** Consolas: monospace, on every Windows box, and close to the face the app itself sets. */
const FONT = 'C\\:/Windows/Fonts/consola.ttf';

type Marks = { video: string; marks: { name: string; at: number }[] };

/**
 * A caption line and the slice of its own segment it is up for.
 *
 * `pos` defaults to `top`, which is not a style choice: the room's buffer is bottom-aligned in its
 * stage, so there is a band of empty wall above the office that occludes nothing. A caption at the
 * foot of the frame — where captions normally go — sits straight over the AGENTS rail and the
 * off-site strip, which are two of the things the trailer is pointing at. `bottom` is for the one
 * beat where the middle of the screen is a dialog.
 */
type Cap = { text: string; from: number; to: number; pos?: 'top' | 'bottom' };

type Window = {
  /** Output name; also the b-roll filename when `broll` is set. */
  name: string;
  /** Which mark it hangs off, and how far after it the window opens. */
  mark: string;
  offset: number;
  dur: number;
  caps?: Cap[];
  /** In the trailer, in this order. */
  trailer: boolean;
  /** Shipped as a loopable b-roll clip (no captions). */
  broll: boolean;
};

/**
 * The shot list from `docs/promo/PLAN.md`, as arithmetic.
 *
 * Offsets account for what the room does after an event lands rather than when the line was
 * written: a walk across the office takes a couple of seconds and a bubble is up for five, so
 * `deliver + 1.5` is the arrival and `leaving + 10` is the door, not the decision.
 */
const WINDOWS: Window[] = [
  {
    name: '01-hook',
    mark: 'cold-open',
    offset: 1.5,
    dur: 5.5,
    trailer: true,
    broll: false,
    caps: [{ text: 'These are AI agents. Working. Right now.', from: 0.3, to: 5.5 }],
  },
  {
    name: '02-fanout',
    mark: 'fanout',
    offset: 1,
    dur: 10,
    trailer: true,
    broll: true,
    caps: [
      { text: 'Roundtable draws a Claude Code session as an office.', from: 0.2, to: 5.2 },
      { text: 'One person per agent. They walk in and take a desk.', from: 5.4, to: 10 },
    ],
  },
  {
    name: '03-working',
    mark: 'working',
    offset: 2,
    dur: 7,
    trailer: true,
    broll: true,
    caps: [
      { text: 'A desk means a tool is running.', from: 0.2, to: 3.4 },
      { text: 'A cloud is a real thinking block from the transcript.', from: 3.6, to: 7 },
    ],
  },
  {
    name: '04-deliver',
    mark: 'deliver',
    offset: 1.5,
    dur: 8,
    trailer: true,
    broll: true,
    caps: [{ text: 'Agents walk over to report. You watch it happen.', from: 0.3, to: 8 }],
  },
  {
    name: '05-refuted',
    mark: 'refuted',
    offset: 2,
    dur: 7,
    trailer: true,
    broll: true,
    caps: [{ text: 'Red is REFUTED.', from: 0.3, to: 7 }],
  },
  {
    name: '06-confirmed',
    mark: 'confirmed',
    offset: 2,
    dur: 6,
    trailer: true,
    broll: true,
    caps: [{ text: 'Green is CONFIRMED.', from: 0.3, to: 6 }],
  },
  {
    name: '07-leaving',
    mark: 'leaving',
    offset: 10,
    dur: 8,
    trailer: true,
    broll: true,
    caps: [{ text: 'Finished means the chair frees up and they go home.', from: 0.3, to: 8 }],
  },
  {
    name: '08-crowd',
    mark: 'crowd',
    offset: 5,
    dur: 8,
    trailer: true,
    broll: true,
    caps: [{ text: 'More agents than chairs?', from: 0.3, to: 8 }],
  },
  {
    name: '09-peek',
    mark: 'peek',
    offset: 0.5,
    dur: 5,
    trailer: true,
    broll: true,
    caps: [{ text: 'The rest are real: hover, click or tab to any of them.', from: 0.2, to: 5 }],
  },
  {
    name: '10-scrub',
    mark: 'scrub',
    offset: 1,
    dur: 7,
    trailer: true,
    broll: true,
    caps: [
      { text: 'Click any second on the timeline.', from: 0.2, to: 3.2 },
      { text: 'The room rebuilds that moment exactly.', from: 3.4, to: 7 },
    ],
  },
  {
    name: '11-resume',
    mark: 'resume',
    offset: 0.5,
    dur: 4,
    trailer: true,
    broll: false,
    caps: [{ text: 'Then catch up to now.', from: 0.2, to: 4 }],
  },
  {
    name: '12-tabs',
    mark: 'tabs',
    offset: 1,
    dur: 4,
    trailer: true,
    broll: false,
    caps: [{ text: 'Two sessions running, two tabs.', from: 0.2, to: 4 }],
  },
  {
    name: '13-tabswitch',
    mark: 'tab-switch',
    offset: 0.5,
    dur: 5,
    trailer: true,
    broll: true,
    caps: [{ text: 'Neither one stops while you look at the other.', from: 0.2, to: 5 }],
  },
  {
    name: '14-numbers',
    mark: 'numbers',
    offset: 1,
    dur: 5,
    trailer: true,
    broll: false,
    caps: [{ text: 'Tokens and cost, checked against the real transcripts on your machine.', from: 0.2, to: 5 }],
  },
  {
    name: '15-night',
    mark: 'night',
    offset: 1.5,
    dur: 6,
    trailer: true,
    broll: true,
    caps: [{ text: 'Day, or night.', from: 0.3, to: 6 }],
  },
  {
    name: '16-help',
    mark: 'help',
    offset: 1,
    dur: 7,
    trailer: true,
    broll: true,
    // The overlay owns the middle of the screen, so this one caption goes to the foot of the frame.
    caps: [{ text: 'Press ? and the room explains itself.', from: 0.2, to: 7, pos: 'bottom' }],
  },
];

/** The three lines of the end card, over the night room, dimmed. */
const END_CARD = [
  'Read-only. Local. It never talks to an API.',
  'Built almost entirely by the agents it watches.',
  'Not public yet. Reply if you want a build.',
];
const END_DUR = 7;

const ff = (args: string[]): void => {
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], { stdio: 'inherit' });
};

/** ffmpeg's filter grammar eats `:`, `'` and `\`; a caption is user text and must survive all three. */
const esc = (s: string): string => s.replace(/\\/g, '\\\\').replace(/:/g, '\\:').replace(/'/g, "\\\\'").replace(/%/g, '\\%');

/** The room's own width in the 1920px frame; the dock owns everything to the right of it. */
const ROOM_W = 1510;

const drawtext = (c: Cap): string =>
  [
    `drawtext=fontfile='${FONT}'`,
    `text='${esc(c.text)}'`,
    'fontsize=36',
    'fontcolor=white',
    'box=1',
    'boxcolor=black@0.72',
    'boxborderw=20',
    // Centred on the room rather than on the frame: centring on 1920 would push every caption a
    // couple of hundred pixels to the right, half-under the dock.
    `x=(${ROOM_W}-text_w)/2`,
    c.pos === 'bottom' ? 'y=h-168' : 'y=176',
    `enable='between(t,${c.from},${c.to})'`,
  ].join(':');

function main(): void {
  const meta = JSON.parse(readFileSync(join(OUT, 'marks.json'), 'utf8')) as Marks;
  const at = new Map(meta.marks.map((m) => [m.name, m.at]));

  rmSync(WORK, { recursive: true, force: true });
  for (const d of [WORK, BROLL, KIT]) mkdirSync(d, { recursive: true });

  const segments: string[] = [];

  for (const w of WINDOWS) {
    const base = at.get(w.mark);
    if (base === undefined) throw new Error(`cut: no mark named ${w.mark} in marks.json`);
    const start = base + w.offset;

    // Common encode for every segment, so the concat below can be a stream copy: same codec, same
    // pixel format, same frame rate, same size. A single mismatched segment turns concat into a
    // silent re-mux with a broken timebase.
    const encode = ['-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-pix_fmt', 'yuv420p', '-r', '30', '-an'];

    if (w.trailer) {
      const chain = ['fps=30', 'scale=1920:1080', ...(w.caps ?? []).map(drawtext)];
      const file = join(WORK, `${w.name}.mp4`);
      ff(['-ss', String(start), '-t', String(w.dur), '-i', meta.video, '-vf', chain.join(','), ...encode, file]);
      segments.push(file);
      console.log(`  cut ${w.name.padEnd(14)} ${start.toFixed(1)}s +${w.dur}s`);
    }

    if (w.broll) {
      // No captions: a channel wants the picture, not my words over it.
      const file = join(BROLL, `${w.name.replace(/^\d+-/, '')}.mp4`);
      ff([
        '-ss',
        String(start),
        '-t',
        String(w.dur),
        '-i',
        meta.video,
        '-vf',
        'fps=30,scale=1920:1080',
        ...encode,
        file,
      ]);
    }
  }

  // ------------------------------------------------------------------------ end card
  const still = join(KIT, 'stills', 'night.png');
  const lines = END_CARD.map((t, i) =>
    [
      `drawtext=fontfile='${FONT}'`,
      `text='${esc(t)}'`,
      'fontsize=46',
      i === 2 ? 'fontcolor=0x7fd6c4' : 'fontcolor=white',
      'x=(w-text_w)/2',
      `y=(h/2)-70+${i * 76}`,
    ].join(':'),
  );
  const endFile = join(WORK, '17-end.mp4');
  ff([
    '-loop',
    '1',
    '-t',
    String(END_DUR),
    '-i',
    still,
    '-vf',
    ['scale=1920:1080', 'eq=brightness=-0.22:saturation=0.7', ...lines, 'fps=30'].join(','),
    '-c:v',
    'libx264',
    '-preset',
    'medium',
    '-crf',
    '18',
    '-pix_fmt',
    'yuv420p',
    '-r',
    '30',
    '-an',
    endFile,
  ]);
  segments.push(endFile);
  console.log('  cut end-card');

  // -------------------------------------------------------------------------- concat
  const list = join(WORK, 'concat.txt');
  writeFileSync(list, segments.map((s) => `file '${s.replace(/\\/g, '/')}'`).join('\n'));
  const out = join(OUT, 'trailer-v1.mp4');
  ff(['-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', '-movflags', '+faststart', out]);
  console.log(`\n[cut] ${out}`);
}

main();
