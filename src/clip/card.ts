/**
 * A session as one picture: its numbers, over a still of the room at its busiest.
 *
 * The GIF is the session as it happened. It is also several megabytes and several seconds of
 * rendering, and in a feed it is one more autoplaying rectangle. This is the other thing worth
 * posting — the run in numbers, legible at a glance, with the room behind them so it could only have
 * come from here.
 *
 * **Every number is one the app already prints, computed the way it computes it.** The totals are a
 * fold of the same events through the same `reduce`, in the same arrival order the page's store
 * folds them, so the tokens and the estimate are the top bar's to the digit and are spelled by the
 * top bar's own `tokens` and `money`. The two numbers the app does not print — how many subagents
 * were in the room at once, and how long the session ran — are derived from the clip's own replay
 * and clock, and each says how beside the code that derives it.
 *
 * **The still is a clip frame.** Same timeline, same `Replay`, same `Scene`, same `drawRoom` the GIF
 * draws every frame with, so a bare card is bare for the same reasons a bare clip is.
 *
 * Like `render.ts`, nothing here may reach for Node or the DOM: the share dialog runs it in its
 * worker, and `tests/clipcore.test.ts` walks this graph too.
 */
import { verdictOf, type Ev } from '../../shared/events';
import type { ActorState } from '../office/engine';
import { drawText, PAL, PIX, textWidth } from '../office/pixel/art';
import { Scene } from '../office/pixel/scene';
import { Replay, type Entry } from '../office/replay';
import { initialState, MAIN, reduce, type RtState } from '../store';
import { duration, money, tokens } from '../ui/format';
import { anonNamer, drawRoom, REPO_LINE, timeline, type Beat } from './render';
import { asCtx, SoftCtx } from './softctx';

// --------------------------------------------------------------- the numbers

export type CardStats = {
  /** Every agent the session had, `main` included: the top bar's AGENTS, folded the same way. */
  agents: number;
  /** The same roster without `main` — the subagents this session spawned. */
  spawned: number;
  /** The most subagents in the room at one moment. See `peakOf`. */
  peak: number;
  /** Every token billed, cache included: the top bar's TOK. */
  totalTok: number;
  /** The top bar's EST, and whether it is a floor. */
  cost: number;
  costPartial: boolean;
  /** From the first transcript line to the last — the span the GIF dialog says a clip covers. */
  durationMs: number;
  /** Agent turns the feed badges ✓ CONFIRMED and ✕ REFUTED. */
  confirmed: number;
  refuted: number;
  /**
   * The agent that billed the most tokens, `main` included. `name` is what the roster calls it, or
   * `agent 3` on a bare card, where no label typed into a transcript may appear.
   */
  busiest: { name: string; tokens: number } | null;
  /** The session's opening prompt, as the whiteboard has it. Always `null` on a bare card. */
  task: string | null;
};

/** The two figures the top bar prints, spelled exactly as it spells them. */
export const tokText = (s: Pick<CardStats, 'totalTok'>): string => tokens(s.totalTok);
export const costText = (s: Pick<CardStats, 'cost' | 'costPartial'>): string =>
  `${s.costPartial ? '≥' : ''}${money(s.cost)}`;

/**
 * The card in one line of words — `24 subagents (8 at once), 14.83M tokens, 9m 26s` — for the
 * caption the dialog offers and the summary `--card` prints. Counts only, never a word from a
 * transcript, so it is as safe to post as a bare card whether or not the text was hidden.
 */
export function cardFacts(s: CardStats): string {
  const parts: string[] = [];
  if (s.spawned > 0) {
    parts.push(`${s.spawned} ${s.spawned === 1 ? 'subagent' : 'subagents'}${s.peak > 1 ? ` (${s.peak} at once)` : ''}`);
  }
  parts.push(`${tokText(s)} tokens`, duration(s.durationMs));
  return parts.join(', ');
}

/**
 * The store's fold of the events, in the order they are given — which for the dialog is the order
 * the page received them, the order its own store folded them in.
 *
 * Verdicts are counted here rather than read off `state.msgs`, because the feed keeps only its last
 * thousand cards and a long session's early verdicts would silently fall out of the count. They are
 * the same test the feed badges with — `verdictOf` on an agent's turn — and only for events `reduce`
 * actually took: the hub can deliver an event twice, and the store folds it once.
 */
function fold(evs: readonly Ev[]): { state: RtState; confirmed: number; refuted: number } {
  let state = initialState;
  let confirmed = 0;
  let refuted = 0;
  for (const ev of evs) {
    const next = reduce(state, ev);
    if (next !== state && ev.kind === 'agentText') {
      const v = verdictOf(ev.text);
      if (v === 'ok') confirmed++;
      else if (v === 'err') refuted++;
    }
    state = next;
  }
  return { state, confirmed, refuted };
}

/** Subagents present at this moment: at a desk or queued outside for one, and not yet finished. */
const presentOf = (actors: readonly ActorState[], offsite: readonly string[]): number =>
  actors.filter((a) => a.id !== MAIN && !a.retired).length + offsite.filter((id) => id !== MAIN).length;

/** How long after the last command the room is still worth looking at: the last walk out. */
const TAIL_MS = 8000;

/**
 * The most subagents in the room at once, and the longest stretch the room spent at that peak.
 *
 * Counted off the replay the still is drawn from, so the number on the card and the people in the
 * picture cannot disagree. "In the room" is the engine's own cast: everyone who has arrived and has
 * not finished, whether at a desk, walking in, or queued outside for a chair. The moment `done`
 * lands they are counted out, though they take a few seconds to reach the door.
 *
 * That count only moves when a command is applied, so it is read once per distinct instant a
 * command lands at — exact, not sampled — and it does not depend on how hard the clock was
 * compressed, only on the order things happened in.
 */
function peakOf(beats: readonly Beat[], entries: readonly Entry[]): { peak: number; from: number; len: number } {
  const replay = new Replay(entries);
  const marks: { at: number; n: number }[] = [];
  for (let i = 0; i < beats.length; ) {
    const at = beats[i].at;
    let moved = false;
    for (; i < beats.length && beats[i].at === at; i++) if (beats[i].cmds.length > 0) moved = true;
    if (!moved) continue;
    const n = presentOf(replay.seek(at), replay.offsite());
    if (marks.length === 0 || marks[marks.length - 1].n !== n) marks.push({ at, n });
  }
  if (marks.length === 0) return { peak: 0, from: 0, len: 0 };

  const end = beats[beats.length - 1].at + TAIL_MS;
  const peak = marks.reduce((m, k) => Math.max(m, k.n), 0);
  let best = { from: marks[0].at, len: -1 };
  for (let k = 0; k < marks.length; k++) {
    if (marks[k].n !== peak) continue;
    const len = (k + 1 < marks.length ? marks[k + 1].at : end) - marks[k].at;
    if (len > best.len) best = { from: marks[k].at, len };
  }
  return { peak, ...best };
}

/** How far into the peak stretch the still may be looked for, and how finely. */
const LOOK_MS = 30_000;
const LOOK_STEP_MS = 250;

/**
 * The instant in a stretch at the peak that makes the best photograph of it.
 *
 * Any instant in the stretch has the peak's head count, but the first one has the last arrival
 * still in the doorway, and a later one can have somebody who just finished pushing back their chair
 * — the picture then shows a person the number does not count. So the stretch is looked through at
 * a quarter-second step for the moment with the most of its people in their chairs and the fewest
 * on their way out, and the earliest such moment wins, so the same session always gets the same one.
 */
function momentIn(entries: readonly Entry[], from: number, len: number): number {
  const replay = new Replay(entries);
  let best = { at: from, score: Number.NEGATIVE_INFINITY };
  for (let t = from; t < from + Math.min(len, LOOK_MS); t += LOOK_STEP_MS) {
    // `main` counts towards the chairs filled: in a session nobody was spawned into, the best
    // picture is the one person in it at their desk, not in the doorway.
    const cast = replay.seek(t);
    const score = cast.filter((a) => !a.retired && a.pose === 'sit').length - cast.filter((a) => a.retired).length;
    if (score > best.score) best = { at: t, score };
  }
  return best.at;
}

type Measured = {
  stats: CardStats;
  beats: Beat[];
  entries: Entry[];
  /** The instant on the clip's clock the still is taken at. */
  at: number;
  anonName: (id: string) => string;
};

function measure(evs: readonly Ev[], opts: CardOptions): Measured {
  const { state, confirmed, refuted } = fold(evs);
  // The clip's clock at its loosest cut: the whole session, every silence held to a short beat.
  const tl = timeline(evs, Number.POSITIVE_INFINITY, true);
  const entries: Entry[] = [];
  for (const b of tl.beats) for (const cmd of b.cmds) entries.push({ ts: b.at, cmd });
  const { peak, from, len } = peakOf(tl.beats, entries);
  const at = momentIn(entries, from, len);

  // Numbered in the order the room first sees them, before the still asks for any, so the name the
  // strip gives the busiest agent is the name over its desk in the picture.
  const anonName = anonNamer();
  for (const b of tl.beats) for (const c of b.cmds) anonName(c.agentId);

  // First in roster order wins a tie, so the same session always names the same agent.
  let busiest: CardStats['busiest'] = null;
  for (const id of state.order) {
    const a = state.agents[id];
    if (!a || a.tokens <= 0 || (busiest && a.tokens <= busiest.tokens)) continue;
    busiest = { name: opts.bare ? anonName(id) : a.label ?? id, tokens: a.tokens };
  }

  return {
    stats: {
      agents: state.order.length,
      spawned: state.order.filter((id) => id !== MAIN).length,
      peak,
      totalTok: state.totalTok,
      cost: state.cost,
      costPartial: state.costPartial,
      durationMs: tl.realMs,
      confirmed,
      refuted,
      busiest,
      task: opts.bare ? null : state.task ?? null,
    },
    beats: tl.beats,
    entries,
    at,
    anonName,
  };
}

// --------------------------------------------------------------- the still

/**
 * How much of the session is played into the scene before the still, and at what step.
 *
 * The scene remembers the last frame — which way somebody walking is facing, whether the door is
 * still swinging, how long a bubble has been up — and a scene that has seen only one frame thinks
 * everybody in it has just come through the door. Two seconds at the GIF's own frame step is enough
 * for all of that to settle. Those frames are drawn into a canvas that keeps nothing, because the
 * scene's memory is the only part of them anybody needs: painted, at the eleven milliseconds a clip
 * frame takes, their twenty-five frames would be four times the whole card.
 */
const WARM_MS = 2000;
const FRAME_MS = 80;

/** A 2D context that paints nothing: the scene steps its memory and the pixels go nowhere. */
const NOWHERE = {
  fillStyle: '#000000',
  globalAlpha: 1,
  imageSmoothingEnabled: false,
  fillRect(): void {},
  clearRect(): void {},
  save(): void {},
  restore(): void {},
} as unknown as CanvasRenderingContext2D;

function still(m: Measured, bare: boolean): SoftCtx {
  const { beats, entries, at } = m;
  const replay = new Replay(entries);
  const scene = new Scene();
  const room = new SoftCtx(PIX.w, PIX.h);
  // The room's own fold, on the room's clock, exactly as a clip frame at this instant would have it.
  let state: RtState = initialState;
  let folded = 0;
  const t0 = beats.length > 0 ? beats[0].real : 0;
  const from = Math.max(0, at - WARM_MS);
  const frames = Math.round((at - from) / FRAME_MS);
  for (let f = 0; f <= frames; f++) {
    const now = f === frames ? at : from + f * FRAME_MS;
    const actors = replay.seek(now);
    while (folded < beats.length && beats[folded].at <= now) state = reduce(state, beats[folded++].ev);
    const clockMs = folded > 0 ? beats[folded - 1].real + Math.max(0, now - beats[folded - 1].at) : t0;
    drawRoom(f === frames ? asCtx(room) : NOWHERE, scene, {
      actors,
      offsite: replay.offsite(),
      state,
      bare,
      anonName: m.anonName,
      dt: FRAME_MS,
      clockMs,
      // Blank, the board would say "waiting for a task" — on a card, in public, about a session
      // that had one. What it can truthfully say is that there was one and it is not shown.
      hiddenTask: 'task hidden',
    });
  }
  return room;
}

// --------------------------------------------------------------- the card

/**
 * 600x315 card pixels at 2x: 1200x630.
 *
 * 1200x630 is the size X, LinkedIn, Slack and Discord all show whole — the Open Graph image size —
 * so a card posted anywhere arrives uncropped. It is also exactly twice a grid the room fits in at
 * its own 480x270, which is what keeps it crisp: the room and every letter on the card land on the
 * same 2x2 blocks the GIF uses, with no fractional scale anywhere to blur them.
 */
export const CARD_W = 600;
export const CARD_H = 315;
export const CARD_SCALE = 2;

export type CardOptions = {
  /** No text from the transcripts anywhere on the card, exactly as for a bare clip. */
  bare: boolean;
};

export const CARD_DEFAULTS: CardOptions = { bare: false };

export type CardResult = {
  /** The card at its final size, RGBA, in its own buffer so a worker can hand it over whole. */
  rgba: Uint8ClampedArray<ArrayBuffer>;
  width: number;
  height: number;
  stats: CardStats;
};

/** The room sits flush right and top, so what the panel covers is the kitchen and the break corner. */
const ROOM_X = CARD_W - PIX.w;
/** The strip under the room. */
const BAND_Y = PIX.h;
/**
 * The dark panel the numbers sit on: solid to here, then hard-edged steps rather than a gradient —
 * the way `pool` draws light — so the fade is pixel art too. It stops short of the left bank of
 * desks, so no figure ever covers a person.
 */
const PANEL_W = 190;
const FADE = [0.72, 0.5, 0.3, 0.14] as const;
const FADE_STEP = 6;

const PAD = 14;
/**
 * The figures' column, right-aligned, and the labels beside it: `24 SUBAGENTS`, `14.83M TOKENS`,
 * read down the panel like a list rather than across it like a dashboard. One figure per row is
 * what lets each of them be drawn at full size — two columns in a panel this narrow held two digits
 * apiece — and the column is only as wide as the widest figure, so a label never floats far from
 * its number.
 */
const FIGURE_MAX_W = 108;
const LABEL_GAP = 8;
const ROW_H = 30;
const LABEL_K = 2;
/** The largest a figure is drawn: each font pixel an 8x8 block on the finished card. */
const FIGURE_K = 4;

/**
 * The glyphs the card needs that the room's font does not have, drawn in its style.
 *
 * `≥` is how the top bar marks an estimate that is a floor, and the font's fallback block in its
 * place would read as a redaction in front of the number most likely to be quoted. `✓` and `✕` are
 * how the feed badges a verdict. The font's 3x5 cell is too small for either: a chevron two pixels
 * wide over a bar read as a `2`, and a check that narrow reads as a `J`, so these take four and five
 * columns. Drawn here rather than added to `art.ts`, whose table is part of the pixel contract.
 */
const EXTRA: Readonly<Record<string, readonly string[]>> = {
  '≥': ['#...', '.##.', '#...', '....', '####'],
  '✓': ['.....', '....#', '...#.', '#.#..', '.#...'],
  '✕': ['#...#', '.#.#.', '..#..', '.#.#.', '#...#'],
};

/** One character's advance: its width and the gap after it, as `textWidth` counts them. */
const advance = (ch: string): number => (EXTRA[ch]?.[0].length ?? textWidth(ch)) + 1;

/** Width of `s` at scale `k`, in card pixels. */
function widthOf(s: string, k: number): number {
  let w = 0;
  for (const ch of s) w += advance(ch);
  return Math.max(0, w - 1) * k;
}

/** A context that draws every rectangle `k` times larger from (`ox`, `oy`): pixel text, scaled whole. */
function scaled(ctx: CanvasRenderingContext2D, ox: number, oy: number, k: number): CanvasRenderingContext2D {
  const s = {
    fillStyle: ctx.fillStyle,
    globalAlpha: ctx.globalAlpha,
    fillRect: (x: number, y: number, w: number, h: number): void => {
      ctx.fillStyle = s.fillStyle;
      ctx.globalAlpha = s.globalAlpha;
      ctx.fillRect(ox + x * k, oy + y * k, w * k, h * k);
    },
  };
  return s as unknown as CanvasRenderingContext2D;
}

/**
 * Text as the card prints it: the store's `…` becomes three dots, because the font has no ellipsis
 * and its fallback block at the end of a sentence reads as a redacted word.
 */
const printable = (s: string): string => s.replaceAll('…', '...');

/** Draws `s` in the room's font at scale `k`, and says how wide it came out. */
function text(ctx: CanvasRenderingContext2D, s: string, x: number, y: number, k: number, color: string): number {
  const sc = scaled(ctx, x, y, k);
  let px = 0;
  for (const ch of s) {
    const extra = EXTRA[ch];
    if (extra) {
      sc.fillStyle = color;
      extra.forEach((row, ry) => {
        for (let rx = 0; rx < row.length; rx++) if (row[rx] === '#') sc.fillRect(px + rx, ry, 1, 1);
      });
    } else {
      drawText(sc, ch, px, 0, color);
    }
    px += advance(ch);
  }
  ctx.globalAlpha = 1;
  return widthOf(s, k);
}

/** Cut to fit `w` card pixels at scale `k`, with three dots. */
function fit(s: string, w: number, k: number): string {
  const t = printable(s);
  if (widthOf(t, k) <= w) return t;
  let out = t;
  while (out.length > 0 && widthOf(`${out.trimEnd()}...`, k) > w) out = out.slice(0, -1);
  return `${out.trimEnd()}...`;
}

function fill(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, color: string, alpha = 1): void {
  ctx.globalAlpha = alpha;
  ctx.fillStyle = color;
  ctx.fillRect(x, y, w, h);
  ctx.globalAlpha = 1;
}

/** One figure's value: a run of text in one colour or several, drawn as large as its column allows. */
type Run = { s: string; color: string };

/** Space between two runs of one figure — `8✓ 1✕` — as wide as a space in the font at that scale. */
const RUN_GAP = 3;

const runsWidth = (runs: readonly Run[], k: number): number =>
  runs.reduce((w, r) => w + widthOf(r.s, k), (runs.length - 1) * RUN_GAP * k);

/** The largest scale a figure fits the column at. Only an outsized figure — `≥$1234.56` — steps down. */
const figureK = (runs: readonly Run[]): number => [FIGURE_K, 3, 2].find((n) => runsWidth(runs, n) <= FIGURE_MAX_W) ?? 2;

/** One row: the figure right-aligned to the column's edge, and its label on the same baseline. */
function row(ctx: CanvasRenderingContext2D, y: number, col: number, runs: readonly Run[], label: string): void {
  const k = figureK(runs);
  // A figure drawn smaller than the rest shares their baseline, not their top.
  const fy = y + (FIGURE_K - k) * 5;
  let fx = PAD + col - runsWidth(runs, k);
  for (const r of runs) fx += text(ctx, r.s, fx, fy, k, r.color) + RUN_GAP * k;
  text(ctx, label, PAD + col + LABEL_GAP, y + (FIGURE_K - LABEL_K) * 5, LABEL_K, PAL.gry);
}

/** A straight copy of the room onto the card, both at card scale. */
function blit(dst: SoftCtx, src: SoftCtx, dx: number, dy: number): void {
  for (let y = 0; y < src.height; y++) {
    const ty = dy + y;
    if (ty < 0 || ty >= dst.height) continue;
    const x0 = Math.max(0, -dx);
    const x1 = Math.min(src.width, dst.width - dx);
    if (x1 <= x0) continue;
    const row = y * src.width * 4;
    dst.data.set(src.data.subarray(row + x0 * 4, row + x1 * 4), (ty * dst.width + dx + x0) * 4);
  }
}

function paint(card: SoftCtx, room: SoftCtx, stats: CardStats): void {
  const ctx = asCtx(card);
  fill(ctx, 0, 0, CARD_W, CARD_H, PAL.shd);
  blit(card, room, ROOM_X, 0);
  fill(ctx, ROOM_X, 0, PANEL_W - ROOM_X, BAND_Y, PAL.shd, 0.9);
  FADE.forEach((a, i) => fill(ctx, PANEL_W + i * FADE_STEP, 0, FADE_STEP, BAND_Y, PAL.shd, a));

  text(ctx, 'ROUNDTABLE', PAD, PAD, LABEL_K, PAL.acc);

  const white = (s: string): Run[] => [{ s, color: PAL.wht }];
  const rows: [Run[], string][] = [
    [white(String(stats.spawned)), stats.spawned === 1 ? 'SUBAGENT' : 'SUBAGENTS'],
    // `0 AT ONCE` under `0 SUBAGENTS` says nothing the line above did not.
    ...(stats.spawned > 0 ? [[white(String(stats.peak)), 'AT ONCE'] satisfies [Run[], string]] : []),
    [white(tokText(stats)), 'TOKENS'],
    [white(costText(stats)), 'EST COST'],
    [white(duration(stats.durationMs)), 'DURATION'],
  ];
  // In the verdicts' own colours, the only saturated ones the app uses — and only when there were
  // any: `0✓ 0✕` on a session nobody asked for verdicts in would describe a different kind of run.
  if (stats.confirmed + stats.refuted > 0) {
    rows.push([
      [
        { s: `${stats.confirmed}✓`, color: PAL.ok },
        { s: `${stats.refuted}✕`, color: PAL.err },
      ],
      'VERDICTS',
    ]);
  }
  const col = Math.max(...rows.map(([runs]) => runsWidth(runs, figureK(runs))));
  let y = 38;
  for (const [runs, label] of rows) {
    row(ctx, y, col, runs, label);
    y += ROW_H;
  }

  if (stats.busiest) {
    y += 4;
    text(ctx, 'BUSIEST', PAD, y, LABEL_K, PAL.gry);
    const tail = `${tokens(stats.busiest.tokens)} TOK`;
    const room = PANEL_W - PAD - LABEL_GAP - widthOf(tail, LABEL_K);
    const x = PAD + text(ctx, fit(stats.busiest.name, room, LABEL_K), PAD, y + 15, LABEL_K, PAL.wht) + LABEL_GAP;
    text(ctx, tail, x, y + 15, LABEL_K, PAL.gry);
  }

  // The strip under the room: what the session was asked, and where this came from.
  fill(ctx, 0, BAND_Y, CARD_W, CARD_H - BAND_Y, PAL.out);
  fill(ctx, 0, BAND_Y, CARD_W, 1, PAL.ou2);
  const credit = REPO_LINE;
  const cx = CARD_W - PAD - widthOf(credit, 1);
  const cy = BAND_Y + Math.round((CARD_H - BAND_Y - 5) / 2);
  text(ctx, credit, cx, cy, 1, PAL.gry);
  if (stats.task) {
    const ty = BAND_Y + Math.round((CARD_H - BAND_Y - 10) / 2);
    const tx = PAD + text(ctx, 'TASK', PAD, ty, LABEL_K, PAL.acc) + 8;
    text(ctx, fit(stats.task, cx - 16 - tx, LABEL_K), tx, ty, LABEL_K, PAL.wht);
  }
}

/** Nearest-neighbour, by a whole number: each card pixel becomes an `n`x`n` block. */
function upscale(src: SoftCtx, n: number): Uint8ClampedArray<ArrayBuffer> {
  const w = src.width * n;
  const out = new Uint8ClampedArray(w * src.height * n * 4);
  const from = new Uint32Array(src.data.buffer, src.data.byteOffset, src.width * src.height);
  const to = new Uint32Array(out.buffer);
  const row = new Uint32Array(w);
  for (let y = 0; y < src.height; y++) {
    for (let x = 0; x < src.width; x++) row.fill(from[y * src.width + x], x * n, x * n + n);
    for (let r = 0; r < n; r++) to.set(row, (y * n + r) * w);
  }
  return out;
}

/** The numbers alone — what the caption is written from, and what the tests pin to the store. */
export function cardStats(evs: readonly Ev[], opts: CardOptions = CARD_DEFAULTS): CardStats {
  return measure(evs, opts).stats;
}

export function renderCard(evs: readonly Ev[], opts: CardOptions = CARD_DEFAULTS): CardResult {
  const m = measure(evs, opts);
  const card = new SoftCtx(CARD_W, CARD_H);
  paint(card, still(m, opts.bare), m.stats);
  return { rgba: upscale(card, CARD_SCALE), width: CARD_W * CARD_SCALE, height: CARD_H * CARD_SCALE, stats: m.stats };
}
