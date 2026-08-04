/**
 * The cut.
 *
 * Reads `marks.json` — the moment each beat actually happened during the take — and turns the one
 * long recording into the trailer plus the press kit's b-roll. Every window is expressed as an
 * offset from a *mark*, never as an absolute timecode, so a retake with different timings needs no
 * edit here: re-run `record.ts`, re-run this, and the same beats come out.
 *
 * Three things carry the pace, in the order they matter:
 *
 * 1. **Length.** Seventeen beats in about fifty seconds. Nothing is on screen long enough to be
 *    studied, because a trailer is an argument for looking at the real thing later.
 * 2. **Speed ramps.** The parts where people are merely walking run at 1.3–1.8×; the parts where
 *    something is decided run at 1×. Cutting the walk entirely would be easier and would lose the
 *    thing that makes the room legible, so it is compressed instead.
 * 3. **Crossfades.** Every join is a 0.3s `xfade`, and the last one fades through black into the
 *    end card. Hard cuts between shots of the same static UI read as glitches; a dissolve reads as
 *    a move.
 *
 * The zooms are *not* here. They are in `record.ts`, driven through the app's own camera, because
 * cropping the finished video and scaling it back up softens every glyph in the UI. The two crops
 * that do exist are for reading small type (the token counters, the help dialog) and are held to
 * 1.5×, which lanczos survives.
 *
 * Captions are burned per segment rather than as one subtitle track over the finished file. It
 * keeps `libass` and its Windows path escaping out of the build, and it means a segment whose
 * caption is wrong can be re-cut on its own.
 *
 *   npx tsx scripts/promo/cut.ts
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const OUT = join(homedir(), 'Desktop', 'roundtable promo');
const KIT = join(OUT, 'presskit');
const BROLL = join(KIT, 'broll');
const WORK = join(OUT, 'segments');

/** Consolas: monospace, on every Windows box, and close to the face the app itself sets. */
const FONT = 'C\\:/Windows/Fonts/consola.ttf';
/** The room's own width in the 1920px frame; the dock owns everything right of it. */
const ROOM_W = 1510;
/** Crossfade length. Long enough to read as a dissolve, short enough not to soften the beat. */
const XFADE = 0.3;

type Marks = { video: string; marks: { name: string; at: number }[] };

type Cap = { text: string; from: number; to: number; pos?: 'top' | 'bottom' };

type Window = {
  name: string;
  /** Which mark it hangs off, and how far after it the window opens. */
  mark: string;
  offset: number;
  /** Seconds taken from the source. Divided by `speed` to give the length on screen. */
  srcDur: number;
  /** 1 = real time. Above 1 compresses; used only where nothing is being decided. */
  speed?: number;
  /** `[w, h, x, y]` in the source frame, for the two shots that exist to make small type legible. */
  crop?: [number, number, number, number];
  caps?: Cap[];
  trailer: boolean;
  broll: boolean;
};

/**
 * The trailer, in the order it plays — which is not the order it was filmed.
 *
 * It opens on the packed room, which happens two thirds of the way through the take. A trailer
 * that starts where the session started opens on four people and a lot of empty desks; the whole
 * point of the first three seconds is that there is more happening than you can follow.
 */
const WINDOWS: Window[] = [
  {
    name: '01-hook',
    mark: 'crowd',
    offset: 9,
    srcDur: 3,
    trailer: true,
    broll: false,
    caps: [{ text: 'This is one Claude Code session.', from: 0.25, to: 3 }],
  },
  {
    name: '02-desks',
    mark: 'fanout',
    offset: 2,
    srcDur: 4.8,
    speed: 1.6,
    trailer: true,
    broll: false,
    caps: [{ text: 'Every agent is a person at a desk.', from: 0.2, to: 3 }],
  },
  {
    name: '03-arrive',
    mark: 'fanout',
    offset: 8,
    srcDur: 6.3,
    speed: 1.8,
    trailer: true,
    broll: true,
    caps: [{ text: "They walk in when they're spawned.", from: 0.2, to: 3.5 }],
  },
  {
    name: '04-think',
    mark: 'working',
    offset: 2,
    srcDur: 3.5,
    trailer: true,
    broll: true,
    caps: [{ text: 'A cloud is a real thinking block.', from: 0.2, to: 3.5 }],
  },
  // No caption: the push in is the shot. A line of text over a camera move asks the viewer to do
  // two things at once and they do neither.
  { name: '05-pushin', mark: 'zoomin', offset: 0.4, srcDur: 3.2, trailer: true, broll: true },
  {
    name: '06-deliver',
    mark: 'deliver',
    offset: 1.5,
    srcDur: 4,
    trailer: true,
    broll: true,
    caps: [{ text: 'They walk over to report.', from: 0.2, to: 4 }],
  },
  {
    name: '07-refuted',
    mark: 'refuted',
    offset: 2,
    srcDur: 3.4,
    trailer: true,
    broll: true,
    caps: [{ text: 'Red is REFUTED.', from: 0.2, to: 3.4 }],
  },
  {
    name: '08-confirmed',
    mark: 'confirmed',
    offset: 2,
    srcDur: 3,
    trailer: true,
    broll: true,
    caps: [{ text: 'Green is CONFIRMED.', from: 0.2, to: 3 }],
  },
  // The pull out, also uncaptioned, and deliberately the longest quiet moment in the cut: it is
  // the one breath before the second half.
  { name: '09-pullout', mark: 'zoomout', offset: 0.5, srcDur: 3.6, trailer: true, broll: true },
  {
    name: '10-leaving',
    mark: 'leaving',
    offset: 10,
    srcDur: 4.4,
    speed: 1.25,
    trailer: true,
    broll: true,
    caps: [{ text: 'They finish, and they leave.', from: 0.2, to: 3.5 }],
  },
  {
    name: '11-crowd',
    mark: 'crowd',
    offset: 4,
    srcDur: 4.6,
    speed: 1.3,
    trailer: true,
    broll: true,
    caps: [{ text: 'More agents than chairs.', from: 0.2, to: 3.5 }],
  },
  {
    name: '12-scrub',
    mark: 'scrub',
    offset: 1,
    srcDur: 3.8,
    trailer: true,
    broll: true,
    caps: [{ text: 'Rewind to any second.', from: 0.2, to: 3.8 }],
  },
  {
    name: '13-tabs',
    mark: 'tab-switch',
    offset: 0.5,
    srcDur: 3.4,
    trailer: true,
    broll: true,
    caps: [{ text: 'Two sessions. Two tabs.', from: 0.2, to: 3.4 }],
  },
  {
    name: '14-numbers',
    mark: 'numbers',
    offset: 1.5,
    srcDur: 3.2,
    // 1.5× on the top-right quadrant, which is where TOK and EST live. They are ten pixels tall at
    // full frame and the caption is a claim about them, so they have to be readable.
    crop: [1280, 720, 560, 0],
    trailer: true,
    broll: false,
    caps: [{ text: 'Tokens checked against the transcripts.', from: 0.2, to: 3.2, pos: 'bottom' }],
  },
  {
    name: '15-night',
    mark: 'night',
    offset: 2,
    srcDur: 3,
    trailer: true,
    broll: true,
    caps: [{ text: 'Day or night.', from: 0.2, to: 3 }],
  },
  {
    name: '16-help',
    mark: 'help',
    offset: 0.8,
    srcDur: 2.4,
    trailer: true,
    broll: false,
    // Bottom, not the usual top band: the overlay's own headline sits exactly where a top caption
    // lands, and covering the words "WHAT AM I LOOKING AT" with a caption saying the same thing is
    // the worst of both. Below the dialog the frame is empty room.
    caps: [{ text: 'Press ? and it explains itself.', from: 0.15, to: 2.4, pos: 'bottom' }],
  },
  // Then push into it, silently. The overlay is a wall of text and a caption over it is text on
  // text: at 1.5× every row is legible, and the dialog's own headline says what the caption did.
  {
    name: '17-helpread',
    mark: 'help',
    offset: 3.4,
    srcDur: 2.8,
    crop: [1280, 720, 460, 110],
    trailer: true,
    broll: true,
  },
];

/** The three lines of the end card, over the night room, dimmed. */
const END_CARD = [
  'Read-only. Local. It never talks to an API.',
  'Built almost entirely by the agents it watches.',
  'Not public yet. Reply if you want a build.',
];
const END_DUR = 4.6;

const ff = (args: string[]): void => {
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], { stdio: 'inherit' });
};

/**
 * A Windows path as an ffmpeg filter argument: forward slashes, and the drive colon escaped so it
 * is not read as the end of the option value.
 */
const ffPath = (p: string): string => p.replace(/\\/g, '/').replace(/:/g, '\\:');

/** `crop` is a property of the window, but the caption needs it to decide what to centre on. */
type CapWithCrop = Cap & { crop?: unknown };

/**
 * One caption, on a border rather than a plate.
 *
 * A solid box cannot be faded with the text on top of it — `boxcolor`'s alpha is fixed — so a
 * caption over a box has to pop on and off. The heavy border and drop shadow read on both the day
 * room and the night one, and they fade with the glyphs.
 *
 * The text arrives as a **file**, not as a `text=` argument. ffmpeg's filtergraph cannot escape an
 * apostrophe inside a quoted value at all — you have to leave the quotes, escape it, and reopen —
 * and the first caption to contain one ("they're") took the whole build down with `Filter not
 * found`. `textfile=` has no escaping rules to get wrong, and `expansion=none` stops drawtext
 * reading `%{...}` out of ordinary prose.
 */
const drawtext = (c: CapWithCrop, file: string): string => {
  const fade = `clip(min((t-${c.from})/0.22\\,(${c.to}-t)/0.22)\\,0\\,1)`;
  return [
    `drawtext=fontfile='${FONT}'`,
    `textfile='${ffPath(file)}'`,
    'expansion=none',
    'fontsize=48',
    'fontcolor=white',
    'borderw=5',
    'bordercolor=black@0.9',
    'shadowcolor=black@0.55',
    'shadowx=2',
    'shadowy=3',
    // Centred on the room, not the frame: centring on 1920 pushes every caption half under the
    // dock. A cropped shot has no dock, so it centres on the whole frame.
    c.crop === undefined ? `x=(${ROOM_W}-text_w)/2` : 'x=(w-text_w)/2',
    c.pos === 'bottom' ? 'y=h-170' : 'y=176',
    `alpha='${fade}'`,
    `enable='between(t,${c.from - 0.25},${c.to + 0.25})'`,
  ].join(':');
};

function main(): void {
  const meta = JSON.parse(readFileSync(join(OUT, 'marks.json'), 'utf8')) as Marks;
  const at = new Map(meta.marks.map((m) => [m.name, m.at]));

  // Windows hands out directory handles to anything that so much as previews a folder — an open
  // player, Explorer, the thumbnail indexer — and a locked directory must not end the run. Emptying
  // it file by file is enough, because every clip below is written by name anyway.
  for (const d of [WORK, BROLL]) {
    try {
      rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch {
      for (const f of readdirSync(d)) {
        try {
          rmSync(join(d, f), { force: true, maxRetries: 3, retryDelay: 200 });
        } catch {
          console.log(`  ! could not remove ${f} — it will be overwritten if the cut still names it`);
        }
      }
    }
  }
  for (const d of [WORK, BROLL, KIT]) mkdirSync(d, { recursive: true });

  const encode = ['-c:v', 'libx264', '-preset', 'medium', '-crf', '16', '-pix_fmt', 'yuv420p', '-r', '30', '-an'];
  const segments: { file: string; dur: number }[] = [];

  for (const w of WINDOWS) {
    const base = at.get(w.mark);
    if (base === undefined) throw new Error(`cut: no mark named ${w.mark} in marks.json`);
    const start = base + w.offset;
    const speed = w.speed ?? 1;
    const outDur = w.srcDur / speed;

    // Order matters: crop and scale first, then retime, then caption. `drawtext` sits after
    // `setpts` so a caption's `from`/`to` are seconds of the *finished* segment — which is what
    // they are written as — rather than seconds of the source at some other rate.
    const chain = [
      ...(w.crop ? [`crop=${w.crop[0]}:${w.crop[1]}:${w.crop[2]}:${w.crop[3]}`] : []),
      'scale=1920:1080:flags=lanczos',
      ...(speed === 1 ? [] : [`setpts=PTS/${speed}`]),
      'fps=30',
      ...(w.caps ?? []).map((c, i) => {
        const capFile = join(WORK, `${w.name}-cap${i}.txt`);
        writeFileSync(capFile, c.text, 'utf8');
        return drawtext({ ...c, crop: w.crop } as CapWithCrop, capFile);
      }),
    ];

    if (w.trailer) {
      const file = join(WORK, `${w.name}.mp4`);
      ff(['-ss', String(start), '-t', String(w.srcDur), '-i', meta.video, '-vf', chain.join(','), ...encode, file]);
      segments.push({ file, dur: outDur });
      const ramp = speed === 1 ? '' : ` ${speed}×`;
      console.log(`  cut ${w.name.padEnd(13)} ${start.toFixed(1)}s → ${outDur.toFixed(1)}s${ramp}`);
    }

    if (w.broll) {
      // No captions and no speed ramp: a channel wants the picture at the speed it happened.
      const file = join(BROLL, `${w.name.replace(/^\d+-/, '')}.mp4`);
      ff([
        '-ss',
        String(start - 1),
        '-t',
        String(w.srcDur + 4),
        '-i',
        meta.video,
        '-vf',
        'scale=1920:1080:flags=lanczos,fps=30',
        ...encode,
        file,
      ]);
    }
  }

  // ------------------------------------------------------------------------ end card
  const endFile = join(WORK, '17-end.mp4');
  const lines = END_CARD.map((t, i) => {
    const f = join(WORK, `end-line${i}.txt`);
    writeFileSync(f, t, 'utf8');
    return [
      `drawtext=fontfile='${FONT}'`,
      `textfile='${ffPath(f)}'`,
      'expansion=none',
      'fontsize=46',
      i === 2 ? 'fontcolor=0x7fd6c4' : 'fontcolor=white',
      'x=(w-text_w)/2',
      `y=(h/2)-70+${i * 76}`,
    ].join(':');
  });
  ff([
    '-loop',
    '1',
    '-t',
    String(END_DUR),
    '-i',
    join(KIT, 'stills', 'night.png'),
    '-vf',
    ['scale=1920:1080', 'eq=brightness=-0.24:saturation=0.65', ...lines, 'fps=30'].join(','),
    ...encode,
    endFile,
  ]);
  segments.push({ file: endFile, dur: END_DUR });
  console.log('  cut end-card');

  // ------------------------------------------------------------------- crossfade chain
  // One `xfade` per join, all in a single graph, so the whole trailer is encoded once. Each
  // `offset` is where the transition begins on the *output* timeline, and every transition eats
  // `XFADE` seconds of total length — hence the running `acc` rather than a plain sum.
  const inputs = segments.flatMap((s) => ['-i', s.file]);
  const steps: string[] = [];
  let acc = segments[0].dur;
  let label = '0:v';
  for (let i = 1; i < segments.length; i++) {
    const out = `x${i}`;
    const last = i === segments.length - 1;
    // Through black into the end card: it is the one join that is a change of subject rather than
    // a change of shot, and a straight dissolve there reads as a mistake.
    const kind = last ? 'fadeblack' : 'fade';
    const dur = last ? 0.5 : XFADE;
    steps.push(`[${label}][${i}:v]xfade=transition=${kind}:duration=${dur}:offset=${(acc - dur).toFixed(3)}[${out}]`);
    acc += segments[i].dur - dur;
    label = out;
  }

  const out = join(OUT, 'trailer-v2.mp4');
  ff([
    ...inputs,
    '-filter_complex',
    steps.join(';'),
    '-map',
    `[${label}]`,
    '-c:v',
    'libx264',
    '-preset',
    'slow',
    '-crf',
    '18',
    '-pix_fmt',
    'yuv420p',
    '-r',
    '30',
    '-an',
    '-movflags',
    '+faststart',
    out,
  ]);
  console.log(`\n[cut] ${out} — ${acc.toFixed(1)}s across ${segments.length} shots`);
}

main();
