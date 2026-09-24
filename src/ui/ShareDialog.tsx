/**
 * Share: the session on screen, as the timelapse `--gif` writes or as one card of its numbers,
 * without leaving the page.
 *
 * The clip is the most shareable thing Roundtable makes, and it used to take a terminal and a flag.
 * This renders the same clip from the events the page already holds, shows it before anything else
 * happens, and hands it to the browser to save. The renderer is `src/clip/render.ts` — the
 * function the CLI runs — in a worker, so the file is the one the terminal would have written and
 * the room keeps moving while it is made.
 *
 * The card is the second format, for a feed rather than a demo: one PNG, the session in numbers over
 * a still of the room at its busiest (`src/clip/card.ts`). It comes out of the same worker, from the
 * same events, behind the same privacy switch.
 *
 * **Download and copy are the whole flow.** No share-to-anywhere buttons, no intent links: the
 * observer opens no outbound connection, and a link that opens a social network's composer with the
 * clip's context in its query string is one. The file goes to the Downloads folder or the clipboard;
 * the caption goes to the clipboard; where either goes after that is the person's decision.
 *
 * **Look at it before you post it.** By default a clip shows what the session showed — the task on
 * the whiteboard, what each agent was asked to do, what they said — which is exactly what someone
 * sharing a screenshot of their work forgets is in it. So the preview is the first thing in the
 * dialog, the text is named in words beside the Download button, and hiding it is one checkbox that
 * says precisely what it removes. The checkbox is one switch for both formats: a person who hid the
 * text for the GIF and then made a card has not changed their mind about the text.
 *
 * Dialog conventions are the palette's and the help's: `aria-modal`, focus taken on open and handed
 * back on close, Tab held inside, Escape and the backdrop both close it. It also keeps every key
 * press to itself: `T` or `?` pressed at a modal must not rearrange the page behind it.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Ev } from '../../shared/events';
import { costText, tokText, type CardStats } from '../clip/card';
import { CLIP_DEFAULTS, type ClipProgress } from '../clip/render';
import type { ClipInfo, ClipReply, ClipRequest } from '../clip/worker';
import { isRecorded } from '../ws';
import { duration, shortId } from './format';
import './share.css';

/** The key that opens this dialog, for the shell's bindings, the palette and the help sheet. */
export const SHARE_KEY = 'g';

const NPX = 'npx https://github.com/Kostakurta8/roundtable/releases/latest/download/roundtable.tgz';
const DEMO_URL = 'https://kostakurta8.github.io/roundtable/';

/** The line "Copy caption" puts on the clipboard: what this is, and the one command that makes one. */
export const CAPTION = `My Claude Code subagents at work 👀 — rendered with Roundtable: ${NPX} --gif`;

/**
 * The same line for a clip of the hosted demo. "My subagents" would be false there — the session is
 * staged, and nobody's — and a caption is posted under the poster's own name. So it says what the
 * clip is, and points at the page it came from rather than at a command the viewer has not run.
 */
export const DEMO_CAPTION =
  'Claude Code subagents at work, as a pixel-art office 👀 — a staged replay from Roundtable. ' +
  `Watch it in your browser: ${DEMO_URL}`;

/** Which caption is true of the clip on screen. */
export const caption = (): string => (isRecorded() ? DEMO_CAPTION : CAPTION);

/**
 * What a card's caption says about the session: counts, never a word from a transcript, so the line
 * is as safe to post as the card beside it whether or not the text is hidden. Spelled by the same
 * formatters the card and the top bar use, so the post and the picture agree to the digit.
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
 * The card's caption. Like the clip's, it never calls a staged session the poster's own: in the
 * hosted demo it says whose it is — nobody's — and points at the page rather than at a command.
 */
export function cardCaption(s: CardStats | null): string {
  const facts = s ? `: ${cardFacts(s)}` : '';
  return isRecorded()
    ? `A Claude Code session in numbers${facts} — a staged replay from Roundtable 👀 Watch it in your browser: ${DEMO_URL}`
    : `My Claude Code session in numbers${facts} 👀 — card rendered with Roundtable: ${NPX}`;
}

const LENGTHS = [10, 20, 40] as const;
type Length = (typeof LENGTHS)[number];

type Format = 'gif' | 'card';
const FORMATS: readonly { key: Format; label: string }[] = [
  { key: 'gif', label: 'GIF' },
  { key: 'card', label: 'Card' },
];

/** The part of a `Worker` this dialog uses. Tests hand in a fake that answers on cue. */
export type ClipWorker = {
  postMessage: (req: ClipRequest) => void;
  terminate: () => void;
  onmessage: ((e: MessageEvent<ClipReply>) => void) | null;
  onerror: ((e: ErrorEvent) => void) | null;
};

/**
 * A fresh worker per render. Cancelling is `terminate()`, and a terminated worker cannot be reused,
 * so reusing one would only move the `new` to the cancel path. The expression stays literally
 * `new Worker(new URL(…), …)`: that shape is what Vite recognizes and bundles as a worker.
 */
const spawnClipWorker = (): ClipWorker =>
  new Worker(new URL('../clip/worker.ts', import.meta.url), { type: 'module', name: 'roundtable-clip' });

/** Pixels in, PNG out. */
export type PngEncoder = (rgba: Uint8ClampedArray<ArrayBuffer>, width: number, height: number) => Promise<Blob>;

/**
 * The card's pixels as a PNG, by the browser's own encoder.
 *
 * The worker draws the card and a canvas encodes it: every browser ships a PNG encoder behind
 * `toBlob`, and writing a second one — a deflate, in the bundle — would buy nothing the pixels do
 * not already guarantee. The picture is the worker's, byte for byte; only the compression is the
 * browser's, and compression does not change a pixel.
 */
const canvasPng: PngEncoder = (rgba, width, height) =>
  new Promise((resolve, reject) => {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      reject(new Error('this browser will not draw to a canvas'));
      return;
    }
    ctx.putImageData(new ImageData(rgba, width, height), 0, 0);
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('the browser would not encode the PNG'))), 'image/png');
  });

/**
 * How the bar divides between the two loops, from a 20 s clip of the showcase session in node:
 * drawing 2.9 s, cutting the palette 0.6 s, encoding 3.3 s. The palette cut reports nothing, so the
 * bar parks at the end of the drawing share and says what it is doing instead.
 */
const DRAW_SHARE = 0.45;
const ENCODE_FROM = 0.5;

type GifDone = { url: string; bytes: number; info: ClipInfo; tookMs: number };
type CardDone = { url: string; blob: Blob; bytes: number; width: number; height: number; stats: CardStats; tookMs: number };

type Job<Done> =
  | { state: 'rendering'; progress: ClipProgress | null }
  | ({ state: 'done' } & Done)
  | { state: 'cancelled' }
  | { state: 'empty' }
  | { state: 'error'; message: string };

const fraction = (p: ClipProgress | null): number => {
  if (!p || p.total === 0) return 0;
  return p.phase === 'draw' ? (DRAW_SHARE * p.done) / p.total : ENCODE_FROM + ((1 - ENCODE_FROM) * p.done) / p.total;
};

const doing = (p: ClipProgress | null): string => {
  if (!p) return 'starting the renderer…';
  if (p.phase === 'draw') return p.done < p.total ? `drawing frame ${p.done} of ${p.total}` : 'cutting the palette…';
  return `encoding frame ${p.done} of ${p.total}`;
};

const size = (bytes: number): string =>
  bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;

/** What stretch of the session the clip covers — the same claim `--gif` prints under the file. */
const covers = (info: ClipInfo): string =>
  info.windowed
    ? `the busiest ${duration(info.shownTo - info.shownFrom)} of ${duration(info.realMs)}`
    : `${duration(info.realMs)} of session at ${info.speed.toFixed(1)}×`;

/** The card, in words, for anyone who cannot see it: its numbers, and no text from a transcript. */
const cardAlt = (s: CardStats): string =>
  `session card: ${cardFacts(s)}, estimated ${costText(s)}` +
  (s.confirmed + s.refuted > 0 ? `, ${s.confirmed} confirmed and ${s.refuted} refuted` : '') +
  ', over the office at its busiest';

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * The dialog's Tab stops, in order. An unchecked radio is left out: a radio group is one stop, and
 * the arrow keys move within it, so walking Tab through every option would be three stops where the
 * platform promises one.
 */
const tabStops = (root: HTMLElement | null): HTMLElement[] =>
  Array.from(root?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? []).filter(
    (el) => !(el instanceof HTMLInputElement && el.type === 'radio' && !el.checked),
  );

/** Saves a file the way the Download link does, for when the clipboard would not take the image. */
function saveFile(url: string, name: string): void {
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
}

export type ShareDialogProps = {
  sessionId: string;
  /** How the rest of the shell names this session, so it is plain which one is being rendered. */
  sessionName: string;
  /** The session's events, read once when each render starts. */
  events: () => readonly Ev[];
  /**
   * Events of this session the page does not hold — the hub's replay window and the page's own cap
   * together. Non-zero means the clip starts partway through, and the dialog says so.
   */
  missing: number;
  onClose: () => void;
  spawn?: () => ClipWorker;
  encodePng?: PngEncoder;
};

export function ShareDialog({
  sessionId,
  sessionName,
  events,
  missing,
  onClose,
  spawn = spawnClipWorker,
  encodePng = canvasPng,
}: ShareDialogProps) {
  const [format, setFormat] = useState<Format>('gif');
  const [seconds, setSeconds] = useState<Length>(20);
  const [full, setFull] = useState(false);
  const [bare, setBare] = useState(false);
  /** Bumped by "Render again", which is a new render of the same options. */
  const [gifAttempt, setGifAttempt] = useState(0);
  const [cardAttempt, setCardAttempt] = useState(0);
  const [gifJob, setGifJob] = useState<Job<GifDone>>({ state: 'rendering', progress: null });
  const [cardJob, setCardJob] = useState<Job<CardDone>>({ state: 'rendering', progress: null });
  const [copied, setCopied] = useState<'idle' | 'ok' | 'refused'>('idle');
  const [imaged, setImaged] = useState<'idle' | 'ok' | 'saved'>('idle');
  const [held, setHeld] = useState(0);

  const dialog = useRef<HTMLDivElement>(null);
  const gifWorker = useRef<ClipWorker | null>(null);
  const cardWorker = useRef<ClipWorker | null>(null);
  // Read through refs, so a caller that passes fresh closures on every render cannot restart the
  // render on every render — which, with a progress message per tick, would be a render loop.
  const eventsRef = useRef(events);
  eventsRef.current = events;
  const spawnRef = useRef(spawn);
  spawnRef.current = spawn;
  const encodeRef = useRef(encodePng);
  encodeRef.current = encodePng;
  const gifJobRef = useRef(gifJob);
  gifJobRef.current = gifJob;
  const cardJobRef = useRef(cardJob);
  cardJobRef.current = cardJob;
  /** Which options each format last started a render for, so switching back to one is free. */
  const gifStarted = useRef<string | null>(null);
  const cardStarted = useRef<string | null>(null);
  /** Bumped whenever a card render is abandoned, so a PNG still being encoded for it is dropped. */
  const cardRun = useRef(0);

  const stopGif = useCallback(() => {
    gifWorker.current?.terminate();
    gifWorker.current = null;
  }, []);
  const stopCard = useCallback(() => {
    cardWorker.current?.terminate();
    cardWorker.current = null;
    cardRun.current += 1;
  }, []);

  // One render per choice of options, and only for the format on screen. Changing a choice — the
  // format is one — abandons a render in progress rather than queueing behind it: the clip being
  // made is one nobody wants any more. A render that *finished* is kept, so flipping to the card and
  // back does not make the same GIF twice.
  const gifKey = `${seconds}|${full}|${bare}|${gifAttempt}`;
  useEffect(() => {
    if (format !== 'gif') return;
    if (gifStarted.current === gifKey && gifJobRef.current.state !== 'rendering') return;
    gifStarted.current = gifKey;
    const evs = eventsRef.current();
    setHeld(evs.length);
    if (evs.length === 0) {
      setGifJob({ state: 'empty' });
      return;
    }
    const startedAt = performance.now();
    setGifJob({ state: 'rendering', progress: null });
    const w = spawnRef.current();
    gifWorker.current = w;
    w.onmessage = (e) => {
      if (gifWorker.current !== w) return; // a reply already in flight when this render was abandoned
      const msg = e.data;
      if (msg.kind === 'progress') {
        setGifJob((j) => (j.state === 'rendering' ? { ...j, progress: msg } : j));
        return;
      }
      stopGif();
      if (msg.kind === 'error') {
        setGifJob({ state: 'error', message: msg.message });
        return;
      }
      if (msg.kind !== 'done') return;
      const url = URL.createObjectURL(new Blob([msg.gif], { type: 'image/gif' }));
      setGifJob({ state: 'done', url, bytes: msg.gif.byteLength, info: msg.info, tookMs: performance.now() - startedAt });
    };
    w.onerror = (e) => {
      if (gifWorker.current !== w) return;
      stopGif();
      setGifJob({ state: 'error', message: e.message || 'the renderer stopped without saying why' });
    };
    w.postMessage({ kind: 'gif', evs, opts: { ...CLIP_DEFAULTS, seconds, full, bare } });
    return stopGif;
  }, [format, gifKey, seconds, full, bare, stopGif]);

  const cardKey = `${bare}|${cardAttempt}`;
  useEffect(() => {
    if (format !== 'card') return;
    if (cardStarted.current === cardKey && cardJobRef.current.state !== 'rendering') return;
    cardStarted.current = cardKey;
    const evs = eventsRef.current();
    setHeld(evs.length);
    if (evs.length === 0) {
      setCardJob({ state: 'empty' });
      return;
    }
    const startedAt = performance.now();
    setCardJob({ state: 'rendering', progress: null });
    const w = spawnRef.current();
    cardWorker.current = w;
    const run = ++cardRun.current;
    w.onmessage = (e) => {
      if (cardWorker.current !== w) return;
      const msg = e.data;
      if (msg.kind === 'progress') return;
      cardWorker.current?.terminate();
      cardWorker.current = null;
      if (msg.kind === 'error') {
        setCardJob({ state: 'error', message: msg.message });
        return;
      }
      if (msg.kind !== 'card') return;
      const { width, height, stats } = msg;
      encodeRef.current(new Uint8ClampedArray(msg.rgba), width, height).then(
        (blob) => {
          if (cardRun.current !== run) return;
          const url = URL.createObjectURL(blob);
          setCardJob({ state: 'done', url, blob, bytes: blob.size, width, height, stats, tookMs: performance.now() - startedAt });
        },
        (err: unknown) => {
          if (cardRun.current !== run) return;
          setCardJob({ state: 'error', message: err instanceof Error ? err.message : String(err) });
        },
      );
    };
    w.onerror = (e) => {
      if (cardWorker.current !== w) return;
      stopCard();
      setCardJob({ state: 'error', message: e.message || 'the renderer stopped without saying why' });
    };
    w.postMessage({ kind: 'card', evs, opts: { bare } });
    return stopCard;
  }, [format, cardKey, bare, stopCard]);

  // An object URL holds the whole file in memory until it is revoked, and a dialog reopened a dozen
  // times with three renders each would otherwise keep every one of them for the life of the tab.
  const gifUrl = gifJob.state === 'done' ? gifJob.url : null;
  useEffect(() => {
    if (!gifUrl) return;
    return () => URL.revokeObjectURL(gifUrl);
  }, [gifUrl]);
  const cardUrl = cardJob.state === 'done' ? cardJob.url : null;
  useEffect(() => {
    if (!cardUrl) return;
    return () => URL.revokeObjectURL(cardUrl);
  }, [cardUrl]);

  useEffect(() => {
    const opener = document.activeElement;
    tabStops(dialog.current)[0]?.focus();
    return () => {
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus();
    };
  }, []);

  const job = format === 'gif' ? gifJob : cardJob;

  // The Cancel button lives in the progress panel, so finishing or cancelling removes the element
  // that had focus and drops a keyboard user on `<body>` — outside the trap, where Tab starts over
  // from the top of the page. Focus goes to what the new state is for instead.
  useEffect(() => {
    const root = dialog.current;
    if (!root || root.contains(document.activeElement)) return;
    const next = root.querySelector<HTMLElement>('[data-autofocus]') ?? tabStops(root)[0];
    next?.focus();
  }, [job.state, format]);

  // A result is about the thing it was done to, and the thing on screen just changed.
  useEffect(() => {
    setCopied('idle');
    setImaged('idle');
  }, [format]);

  const cancel = (): void => {
    if (format === 'gif') {
      stopGif();
      setGifJob({ state: 'cancelled' });
    } else {
      stopCard();
      setCardJob({ state: 'cancelled' });
    }
  };
  const again = (): void => (format === 'gif' ? setGifAttempt((n) => n + 1) : setCardAttempt((n) => n + 1));

  const line = format === 'gif' ? caption() : cardCaption(cardJob.state === 'done' ? cardJob.stats : null);

  const copy = async (): Promise<void> => {
    try {
      // `navigator.clipboard` is absent outright in some embedded browsers and on any origin the
      // browser does not count as secure, so a missing object is a refusal like any other.
      await navigator.clipboard.writeText(line);
      setCopied('ok');
    } catch {
      setCopied('refused');
    }
  };

  const cardFile = `roundtable-${shortId(sessionId)}-card.png`;
  const gifFile = `roundtable-${shortId(sessionId)}.gif`;

  /**
   * The card onto the clipboard as an image, where the browser allows it — and where it does not,
   * the file instead, with a line saying so. Firefox before 127 has no `ClipboardItem`, an insecure
   * origin has no `navigator.clipboard`, and any browser may refuse; in every one of those cases the
   * person pressed a button to get the card, and the Downloads folder is the nearest place to put it.
   */
  const copyImage = async (): Promise<void> => {
    if (cardJob.state !== 'done') return;
    try {
      const Item = (globalThis as { ClipboardItem?: typeof ClipboardItem }).ClipboardItem;
      if (!Item || typeof navigator.clipboard?.write !== 'function') throw new Error('no image clipboard');
      await navigator.clipboard.write([new Item({ [cardJob.blob.type || 'image/png']: cardJob.blob })]);
      setImaged('ok');
    } catch {
      saveFile(cardJob.url, cardFile);
      setImaged('saved');
    }
  };

  const onKeyDown = (e: React.KeyboardEvent): void => {
    e.stopPropagation();
    if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    } else if (e.key === 'Tab') {
      e.preventDefault();
      const nodes = tabStops(dialog.current);
      if (nodes.length === 0) return;
      const from = nodes.indexOf(document.activeElement as HTMLElement);
      const step = e.shiftKey ? -1 : 1;
      nodes[(Math.max(0, from) + step + nodes.length) % nodes.length].focus();
    }
  };

  const pct = gifJob.state === 'rendering' ? Math.round(fraction(gifJob.progress) * 100) : 0;
  const what = format === 'gif' ? 'GIF' : 'card';

  const status = ((): string => {
    if (job.state === 'rendering') return format === 'gif' ? 'Rendering the GIF.' : 'Drawing the card.';
    if (job.state === 'cancelled') return 'Rendering cancelled.';
    if (job.state === 'error') return `The ${what} could not be rendered: ${job.message}`;
    if (job.state === 'empty') return 'Nothing to render yet.';
    if (gifJob.state === 'done' && format === 'gif') {
      return `GIF ready: ${size(gifJob.bytes)}, ${(gifJob.info.clipMs / 1000).toFixed(1)} seconds. Download is available.`;
    }
    if (cardJob.state === 'done') return `Card ready: ${cardJob.width} by ${cardJob.height} PNG, ${size(cardJob.bytes)}. Download is available.`;
    return '';
  })();

  return (
    // Closed on `click`, not `pointerdown`, for the reason the palette and the help give: an
    // overlay that unmounts on the down-stroke hands the up-stroke's click to the room underneath.
    <div className="overlay share-overlay" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div
        ref={dialog}
        className="share"
        role="dialog"
        aria-modal="true"
        aria-labelledby="share-title"
        aria-describedby="share-privacy"
        onKeyDown={onKeyDown}
      >
        <header className="share-hd">
          <b id="share-title">SHARE</b>
          <span className="share-which" title={sessionName}>
            {sessionName}
          </span>
          <span className="spacer" />
          <button type="button" className="btn icon" aria-label="close" onClick={onClose}>
            ✕
          </button>
        </header>

        {/* Said once per state, not once per frame: the bar carries its own value for anyone who
            goes looking, and a live region re-reading "drawing frame 41 of 262" every sixty
            milliseconds would drown out everything else a screen reader has to say. */}
        <p className="sr-only" role="status" aria-live="polite">
          {status}
        </p>

        <div className="share-body">
          <fieldset className="share-seg share-format">
            <legend className="sr-only">Share as</legend>
            <div className="share-seg-row">
              {FORMATS.map((f) => (
                <label key={f.key}>
                  <input
                    type="radio"
                    name="share-format"
                    value={f.key}
                    checked={format === f.key}
                    onChange={() => setFormat(f.key)}
                  />
                  <span>{f.label}</span>
                </label>
              ))}
            </div>
          </fieldset>

          <figure className="share-preview">
            <div className={format === 'card' ? 'share-frame share-frame-card' : 'share-frame'}>
              {format === 'gif' && gifJob.state === 'done' ? (
                <img
                  src={gifJob.url}
                  width={gifJob.info.width}
                  height={gifJob.info.height}
                  alt={`the office, replaying this session as a ${(gifJob.info.clipMs / 1000).toFixed(0)}-second loop`}
                />
              ) : format === 'card' && cardJob.state === 'done' ? (
                <img src={cardJob.url} width={cardJob.width} height={cardJob.height} alt={cardAlt(cardJob.stats)} />
              ) : (
                <div className="share-wait">
                  {job.state === 'rendering' && (
                    <>
                      {format === 'gif' ? (
                        <>
                          <div
                            className="share-bar"
                            role="progressbar"
                            aria-label="rendering the GIF"
                            aria-valuemin={0}
                            aria-valuemax={100}
                            aria-valuenow={pct}
                            aria-valuetext={`${pct}% — ${doing(gifJob.state === 'rendering' ? gifJob.progress : null)}`}
                          >
                            <i style={{ width: `${pct}%` }} />
                          </div>
                          <span className="share-doing">{doing(gifJob.state === 'rendering' ? gifJob.progress : null)}</span>
                        </>
                      ) : (
                        // One frame has no frames to count, so the card says what it is doing
                        // rather than drawing a bar that would jump from nothing to done.
                        <span className="share-doing">finding the busiest moment and counting…</span>
                      )}
                      <button type="button" className="btn" onClick={cancel}>
                        Cancel
                      </button>
                    </>
                  )}
                  {job.state === 'cancelled' && (
                    <>
                      <span className="share-doing">Cancelled. Nothing was kept.</span>
                      <button type="button" className="btn" data-autofocus onClick={again}>
                        Render again
                      </button>
                    </>
                  )}
                  {job.state === 'error' && (
                    <>
                      <span className="share-doing share-err">
                        The {what} could not be rendered: {job.message}
                      </span>
                      <button type="button" className="btn" data-autofocus onClick={again}>
                        Try again
                      </button>
                    </>
                  )}
                  {job.state === 'empty' && (
                    <span className="share-doing">Nothing to render yet — this session has not said anything.</span>
                  )}
                </div>
              )}
            </div>
            <figcaption className="share-meta">
              {format === 'gif' && gifJob.state === 'done' ? (
                <>
                  <span>
                    {gifJob.info.width}×{gifJob.info.height}
                  </span>
                  <span>{size(gifJob.bytes)}</span>
                  <span>{(gifJob.info.clipMs / 1000).toFixed(1)} s loop</span>
                  <span>
                    {gifJob.info.agents} {gifJob.info.agents === 1 ? 'agent' : 'agents'}
                  </span>
                  <span>{covers(gifJob.info)}</span>
                </>
              ) : format === 'card' && cardJob.state === 'done' ? (
                <>
                  <span>
                    {cardJob.width}×{cardJob.height}
                  </span>
                  <span>{size(cardJob.bytes)}</span>
                  <span>PNG</span>
                  <span>
                    the room at its busiest: {cardJob.stats.peak} {cardJob.stats.peak === 1 ? 'subagent' : 'subagents'} at
                    once
                  </span>
                </>
              ) : (
                <span>{format === 'gif' && gifJob.state === 'rendering' ? `${pct}%` : ' '}</span>
              )}
            </figcaption>
          </figure>

          <div className="share-opts">
            {format === 'gif' && (
              <>
                <fieldset className="share-seg">
                  <legend>Length</legend>
                  <div className="share-seg-row">
                    {LENGTHS.map((s) => (
                      <label key={s}>
                        <input type="radio" name="share-length" value={s} checked={seconds === s} onChange={() => setSeconds(s)} />
                        <span>{s} s</span>
                      </label>
                    ))}
                  </div>
                </fieldset>
                <fieldset className="share-seg">
                  <legend>Plays</legend>
                  <div className="share-seg-row">
                    <label>
                      <input type="radio" name="share-range" value="busiest" checked={!full} onChange={() => setFull(false)} />
                      <span>busiest stretch</span>
                    </label>
                    <label>
                      <input type="radio" name="share-range" value="whole" checked={full} onChange={() => setFull(true)} />
                      <span>whole session</span>
                    </label>
                  </div>
                </fieldset>
              </>
            )}
            <label className="share-bare">
              <input type="checkbox" checked={bare} onChange={(e) => setBare(e.target.checked)} aria-describedby="share-bare-what" />
              <span>
                <b>Hide transcript text</b>
                <small id="share-bare-what">
                  {format === 'gif'
                    ? 'no task, names or speech from your transcripts — people and desks only'
                    : 'no task, names or speech from your transcripts — numbers, people and desks only'}
                </small>
              </span>
            </label>
          </div>

          {/* The privacy line changes with the checkbox rather than being a fixed disclaimer, because
              a warning that reads the same whether or not it applies is one people learn to skip. */}
          <p id="share-privacy" className={bare ? 'share-note' : 'share-note share-warn'}>
            {bare ? (
              <>
                <b>Text hidden.</b> {format === 'gif' ? 'People, desks and walks only' : 'Numbers, people and desks only'};
                agents are numbered, not named.
              </>
            ) : format === 'gif' ? (
              <>
                <b>Look at it before you post it.</b> This clip shows the session’s task, what each agent was asked to
                do and what they said.
              </>
            ) : (
              <>
                <b>Look at it before you post it.</b> This card shows the session’s task, what each agent was asked to
                do and what they were saying at that moment.
              </>
            )}
          </p>
          {missing > 0 && held > 0 && (
            <p className="share-note">
              This page holds only the latest {held.toLocaleString('en-US')} events of the session, so the {what}{' '}
              {format === 'gif' ? 'starts partway through' : 'counts from partway through'}.{' '}
              {format === 'gif' ? (
                <>
                  <code>roundtable --gif</code> in a terminal reads all of it.
                </>
              ) : (
                'Its numbers can be lower than the top bar’s.'
              )}
            </p>
          )}
        </div>

        <footer className="share-ft">
          <div className="share-actions">
            {format === 'gif' ? (
              gifJob.state === 'done' ? (
                <a className="btn share-primary" href={gifJob.url} download={gifFile} data-autofocus>
                  Download GIF
                </a>
              ) : (
                <button type="button" className="btn share-primary" disabled>
                  Download GIF
                </button>
              )
            ) : cardJob.state === 'done' ? (
              <>
                <a className="btn share-primary" href={cardJob.url} download={cardFile} data-autofocus>
                  Download PNG
                </a>
                <button type="button" className="btn" onClick={() => void copyImage()}>
                  {imaged === 'ok' ? 'Image copied' : 'Copy image'}
                </button>
              </>
            ) : (
              <>
                <button type="button" className="btn share-primary" disabled>
                  Download PNG
                </button>
                <button type="button" className="btn" disabled>
                  Copy image
                </button>
              </>
            )}
            <button type="button" className="btn" onClick={() => void copy()}>
              {copied === 'ok' ? 'Caption copied' : 'Copy caption'}
            </button>
            <span className="share-copied" role="status" aria-live="polite">
              {copied === 'refused'
                ? 'The browser refused the clipboard — select the line below and copy it.'
                : imaged === 'saved'
                  ? 'This browser would not put an image on the clipboard, so the card was downloaded instead.'
                  : ''}
            </span>
          </div>
          <input
            className="share-caption"
            readOnly
            value={line}
            aria-label={`caption to post with the ${what}`}
            onFocus={(e) => e.currentTarget.select()}
          />
          <p className="share-local">
            {job.state === 'done' ? `rendered in ${(job.tookMs / 1000).toFixed(1)} s, ` : ''}in this tab · nothing is
            uploaded · saved as {format === 'gif' ? gifFile : cardFile}
          </p>
        </footer>
      </div>
    </div>
  );
}
