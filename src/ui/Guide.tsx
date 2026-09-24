/**
 * The first-visit guide: what the room's pictures mean, on a card over the room, once.
 *
 * The Help sheet has always explained the metaphor, but it is behind a `?` that a first-time viewer
 * has no reason to press — they see desks, bubbles and a door, and nothing on screen says that a
 * person leaving is good news. This is the same dictionary cut down to the six things that happen
 * in the first minute, each beside a picture of itself, shown the first time the room has something
 * in it and never again once dismissed.
 *
 * It does not block the room. It is not a dialog: nothing behind it is inert, focus is not taken,
 * and only the card itself takes the pointer, so the room keeps moving and stays clickable around
 * it. Like the Help sheet it reports nothing live — a glossary cannot be wrong about the session.
 *
 * Dismissal is remembered in `localStorage` and every access is wrapped: storage that throws
 * (a private window, a blocked origin) means the guide is shown again next visit, never that the
 * app fails to render. The Help sheet and the palette can always bring it back.
 */
import { memo, useEffect, useRef } from 'react';
import { agentLook, MAIN } from '../store';
import { PAL } from '../office/pixel/art';

const KEY = 'rt.guide';

/** Whether this browser has dismissed the guide before. Unknown storage reads as "not yet". */
export function guideSeen(): boolean {
  try {
    return localStorage.getItem(KEY) === 'seen';
  } catch {
    return false;
  }
}

export function rememberGuide(): void {
  try {
    localStorage.setItem(KEY, 'seen');
  } catch {
    // storage denied — the guide simply comes back next visit, which is the safe way to be wrong
  }
}

// ---------------------------------------------------------------- the icons

/**
 * One icon as rows of characters, one per pixel, `.` transparent — the room's own sprite format
 * (`Art` in the pixel contract), so the icons are drawn the way the room is and read as part of it.
 * Colours come from the room's locked palette and the agents' looks, never from new hexes.
 */
type Icon = { rows: readonly string[]; map: Readonly<Record<string, string>> };

const ORCH = agentLook(MAIN);
const SCOUT = agentLook('a7f2c1');

const ICONS = {
  person: {
    rows: ['..hhh..', '.hhhhh.', '.hssss.', '..sss..', '.ttttt.', 'ttttttt', 't.ttt.t', '..o.o..'],
    map: { h: SCOUT.hair, s: SCOUT.skin, t: SCOUT.tint, o: PAL.out },
  },
  desk: {
    rows: ['.bbbbbb.', '.bggggb.', '.bgccgb.', '.bbbbbb.', '...bb...', 'dddddddd', 'ffffffff', 'f......f'],
    map: { b: PAL.blk, g: PAL.sc2, c: PAL.scg, d: PAL.wdt, f: PAL.wdd },
  },
  think: {
    rows: ['.oooooo.', 'owwwwwwo', 'owwwwwwo', 'owwwwwwo', '.oooooo.', '...oo...', '....o...', '.....o..'],
    map: { o: PAL.ou2, w: PAL.wht },
  },
  speak: {
    rows: ['oooooooo', 'owwwwwwo', 'owkkkkwo', 'owwwwwwo', 'oooowooo', '...owo..', '...oo...', '..hhh...'],
    map: { o: PAL.ou2, w: PAL.wht, k: PAL.gry, h: ORCH.hair },
  },
  verdict: {
    rows: ['oooo.oooo', 'oggo.orro', 'owgo.oror', 'oggo.orro', 'oooo.oooo', '.o.....o.'],
    map: { o: PAL.ou2, g: PAL.ok, w: PAL.wht, r: PAL.err },
  },
  door: {
    rows: ['oooooo', 'oddddo', 'odlldo', 'oddddo', 'odddko', 'oddddo', 'odlldo', 'oddddo'],
    map: { o: PAL.out, d: PAL.wdf, l: PAL.wdl, k: PAL.lmp },
  },
  rewind: {
    rows: ['.......c', '...c...c', '...c.c.c', '.g.c.c.c', '.g.cgc.c', 'gg.cgccc', 'oooooooo'],
    map: { c: PAL.acc, g: PAL.ok, o: PAL.me2 },
  },
} as const satisfies Record<string, Icon>;

/**
 * An icon as an SVG of hard-edged rects, one per horizontal run of a colour.
 *
 * `crispEdges` and whole-unit rects are what keep it pixel art at any size the stylesheet gives
 * it; a run rather than a rect per pixel keeps the DOM at a few dozen nodes for the whole card.
 */
const PixelIcon = memo(function PixelIcon({ icon }: { icon: Icon }) {
  const w = Math.max(...icon.rows.map((r) => r.length));
  const h = icon.rows.length;
  const runs: { x: number; y: number; n: number; fill: string }[] = [];
  icon.rows.forEach((row, y) => {
    for (let x = 0; x < row.length; ) {
      const fill: string | undefined = icon.map[row[x]];
      let n = 1;
      while (x + n < row.length && row[x + n] === row[x]) n += 1;
      if (fill) runs.push({ x, y, n, fill });
      x += n;
    }
  });
  return (
    <svg
      className="guide-ico"
      viewBox={`0 0 ${w} ${h}`}
      width={w * 3}
      height={h * 3}
      shapeRendering="crispEdges"
      aria-hidden="true"
    >
      {runs.map((r) => (
        <rect key={`${r.x}-${r.y}`} x={r.x} y={r.y} width={r.n} height={1} fill={r.fill} />
      ))}
    </svg>
  );
});

/**
 * The six things a newcomer sees in the first minute, in the order they tend to happen. `short` is
 * the caption the phone-width legend puts under the picture instead of the sentence.
 */
const LINES: readonly { icon: Icon; term: string; means: string; more?: string; short: string }[] = [
  {
    icon: ICONS.person,
    term: 'A person',
    means: 'is an agent',
    more: ' — hover for what it is doing, click for the rest',
    short: 'an agent',
  },
  { icon: ICONS.desk, term: 'At a desk', means: 'a tool is running', short: 'tool running' },
  { icon: ICONS.think, term: 'Thought bubble', means: 'it is thinking', short: 'thinking' },
  { icon: ICONS.speak, term: 'Walks over and speaks', means: 'reporting back', more: ' to whoever asked', short: 'reporting' },
  { icon: ICONS.verdict, term: 'Green or red bubble', means: 'a CONFIRMED or REFUTED verdict', short: 'verdict' },
  { icon: ICONS.door, term: 'Leaves through the door', means: 'done', more: ' — good news, not a crash', short: 'done' },
];

export const Guide = memo(function Guide({ onClose }: { onClose: () => void }) {
  const card = useRef<HTMLElement>(null);

  // Escape from inside the card closes it and goes no further: the shell's own Escape would clear
  // the selection or a held seek behind it, which is not what somebody dismissing a card meant.
  useEffect(() => {
    const el = card.current;
    if (!el) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      onClose();
    };
    el.addEventListener('keydown', onKey);
    return () => el.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <section ref={card} className="guide" aria-labelledby="guide-title">
      <header className="guide-hd">
        <b id="guide-title">WHAT YOU ARE LOOKING AT</b>
        <button type="button" className="guide-x" aria-label="dismiss the guide" onClick={onClose}>
          ✕
        </button>
      </header>
      <p className="guide-lede">A Claude Code session, replayed as an office.</p>
      <ul className="guide-list">
        {LINES.map((l) => (
          <li key={l.term}>
            <PixelIcon icon={l.icon} />
            {/* Two phrasings of one line, and the stylesheet shows one: the sentence on a card with
                room for it, the picture's one-word caption in the phone-width legend. */}
            <span className="guide-long">
              <b>{l.term}</b> {l.means}
              {l.more}
            </span>
            <span className="guide-short">{l.short}</span>
          </li>
        ))}
      </ul>
      <footer className="guide-ft">
        <PixelIcon icon={ICONS.rewind} />
        <span>Click the timeline to rewind the room.</span>
        <button type="button" className="btn on guide-ok" onClick={onClose}>
          Got it
        </button>
      </footer>
    </section>
  );
});
