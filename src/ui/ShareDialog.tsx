/**
 * Share as GIF: the session on screen, as the timelapse `--gif` writes, without leaving the page.
 *
 * The clip is the most shareable thing Roundtable makes, and it used to take a terminal and a flag.
 * This renders the same clip from the events the page already holds, shows it before anything else
 * happens, and hands it to the browser to save. The renderer is `src/clip/render.ts` — the
 * function the CLI runs — in a worker, so the file is the one the terminal would have written and
 * the room keeps moving while it is made.
 *
 * **Download and copy are the whole flow.** No share-to-anywhere buttons, no intent links: the
 * observer opens no outbound connection, and a link that opens a social network's composer with the
 * clip's context in its query string is one. The GIF goes to the Downloads folder; the caption goes
 * to the clipboard; where either goes after that is the person's decision.
 *
 * **Look at it before you post it.** By default a clip shows what the session showed — the task on
 * the whiteboard, what each agent was asked to do, what they said — which is exactly what someone
 * sharing a screenshot of their work forgets is in it. So the preview is the first thing in the
 * dialog, the text is named in words beside the Download button, and hiding it is one checkbox that
 * says precisely what it removes.
 *
 * Dialog conventions are the palette's and the help's: `aria-modal`, focus taken on open and handed
 * back on close, Tab held inside, Escape and the backdrop both close it. It also keeps every key
 * press to itself: `T` or `?` pressed at a modal must not rearrange the page behind it.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Ev } from '../../shared/events';
import { CLIP_DEFAULTS, type ClipProgress } from '../clip/render';
import type { ClipInfo, ClipReply, ClipRequest } from '../clip/worker';
import { duration, shortId } from './format';
import './share.css';

/** The key that opens this dialog, for the shell's bindings, the palette and the help sheet. */
export const SHARE_KEY = 'g';

/** The line "Copy caption" puts on the clipboard: what this is, and the one command that makes one. */
export const CAPTION =
  'My Claude Code subagents at work 👀 — rendered with Roundtable: ' +
  'npx https://github.com/Kostakurta8/roundtable/releases/latest/download/roundtable.tgz --gif';

const LENGTHS = [10, 20, 40] as const;
type Length = (typeof LENGTHS)[number];

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

/**
 * How the bar divides between the two loops, from a 20 s clip of the showcase session in node:
 * drawing 2.9 s, cutting the palette 0.6 s, encoding 3.3 s. The palette cut reports nothing, so the
 * bar parks at the end of the drawing share and says what it is doing instead.
 */
const DRAW_SHARE = 0.45;
const ENCODE_FROM = 0.5;

type Job =
  | { state: 'rendering'; progress: ClipProgress | null }
  | { state: 'done'; url: string; bytes: number; info: ClipInfo; tookMs: number }
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
};

export function ShareDialog({ sessionId, sessionName, events, missing, onClose, spawn = spawnClipWorker }: ShareDialogProps) {
  const [seconds, setSeconds] = useState<Length>(20);
  const [full, setFull] = useState(false);
  const [bare, setBare] = useState(false);
  /** Bumped by "Render again", which is a new render of the same options. */
  const [attempt, setAttempt] = useState(0);
  const [job, setJob] = useState<Job>({ state: 'rendering', progress: null });
  const [copied, setCopied] = useState<'idle' | 'ok' | 'refused'>('idle');
  const [held, setHeld] = useState(0);

  const dialog = useRef<HTMLDivElement>(null);
  const worker = useRef<ClipWorker | null>(null);
  // Read through refs, so a caller that passes fresh closures on every render cannot restart the
  // render on every render — which, with a progress message per tick, would be a render loop.
  const eventsRef = useRef(events);
  eventsRef.current = events;
  const spawnRef = useRef(spawn);
  spawnRef.current = spawn;

  const stop = useCallback(() => {
    worker.current?.terminate();
    worker.current = null;
  }, []);

  // One render per choice of options. Changing a choice mid-render abandons the render rather than
  // queueing behind it: the clip being made is one nobody wants any more.
  useEffect(() => {
    const evs = eventsRef.current();
    setHeld(evs.length);
    if (evs.length === 0) {
      setJob({ state: 'empty' });
      return;
    }
    const startedAt = performance.now();
    setJob({ state: 'rendering', progress: null });
    const w = spawnRef.current();
    worker.current = w;
    w.onmessage = (e) => {
      if (worker.current !== w) return; // a reply already in flight when this render was abandoned
      const msg = e.data;
      if (msg.kind === 'progress') {
        setJob((j) => (j.state === 'rendering' ? { ...j, progress: msg } : j));
        return;
      }
      stop();
      if (msg.kind === 'error') {
        setJob({ state: 'error', message: msg.message });
        return;
      }
      const url = URL.createObjectURL(new Blob([msg.gif], { type: 'image/gif' }));
      setJob({ state: 'done', url, bytes: msg.gif.byteLength, info: msg.info, tookMs: performance.now() - startedAt });
    };
    w.onerror = (e) => {
      if (worker.current !== w) return;
      stop();
      setJob({ state: 'error', message: e.message || 'the renderer stopped without saying why' });
    };
    const req: ClipRequest = { evs, opts: { ...CLIP_DEFAULTS, seconds, full, bare } };
    w.postMessage(req);
    return stop;
  }, [seconds, full, bare, attempt, stop]);

  // An object URL holds the whole GIF in memory until it is revoked, and a dialog reopened a dozen
  // times with three renders each would otherwise keep every one of them for the life of the tab.
  const url = job.state === 'done' ? job.url : null;
  useEffect(() => {
    if (!url) return;
    return () => URL.revokeObjectURL(url);
  }, [url]);

  useEffect(() => {
    const opener = document.activeElement;
    tabStops(dialog.current)[0]?.focus();
    return () => {
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus();
    };
  }, []);

  // The Cancel button lives in the progress panel, so finishing or cancelling removes the element
  // that had focus and drops a keyboard user on `<body>` — outside the trap, where Tab starts over
  // from the top of the page. Focus goes to what the new state is for instead.
  useEffect(() => {
    const root = dialog.current;
    if (!root || root.contains(document.activeElement)) return;
    const next = root.querySelector<HTMLElement>('[data-autofocus]') ?? tabStops(root)[0];
    next?.focus();
  }, [job.state]);

  const cancel = (): void => {
    stop();
    setJob({ state: 'cancelled' });
  };

  const copy = async (): Promise<void> => {
    try {
      // `navigator.clipboard` is absent outright in some embedded browsers and on any origin the
      // browser does not count as secure, so a missing object is a refusal like any other.
      await navigator.clipboard.writeText(CAPTION);
      setCopied('ok');
    } catch {
      setCopied('refused');
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

  const file = `roundtable-${shortId(sessionId)}.gif`;
  const pct = job.state === 'rendering' ? Math.round(fraction(job.progress) * 100) : 0;

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
          <b id="share-title">SHARE AS GIF</b>
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
          {job.state === 'rendering'
            ? 'Rendering the GIF.'
            : job.state === 'done'
              ? `GIF ready: ${size(job.bytes)}, ${(job.info.clipMs / 1000).toFixed(1)} seconds. Download is available.`
              : job.state === 'cancelled'
                ? 'Rendering cancelled.'
                : job.state === 'error'
                  ? `The clip could not be rendered: ${job.message}`
                  : 'Nothing to render yet.'}
        </p>

        <div className="share-body">
          <figure className="share-preview">
            <div className="share-frame">
              {job.state === 'done' ? (
                <img
                  src={job.url}
                  width={job.info.width}
                  height={job.info.height}
                  alt={`the office, replaying this session as a ${(job.info.clipMs / 1000).toFixed(0)}-second loop`}
                />
              ) : (
                <div className="share-wait">
                  {job.state === 'rendering' && (
                    <>
                      <div
                        className="share-bar"
                        role="progressbar"
                        aria-label="rendering the GIF"
                        aria-valuemin={0}
                        aria-valuemax={100}
                        aria-valuenow={pct}
                        aria-valuetext={`${pct}% — ${doing(job.progress)}`}
                      >
                        <i style={{ width: `${pct}%` }} />
                      </div>
                      <span className="share-doing">{doing(job.progress)}</span>
                      <button type="button" className="btn" onClick={cancel}>
                        Cancel
                      </button>
                    </>
                  )}
                  {job.state === 'cancelled' && (
                    <>
                      <span className="share-doing">Cancelled. Nothing was kept.</span>
                      <button type="button" className="btn" data-autofocus onClick={() => setAttempt((n) => n + 1)}>
                        Render again
                      </button>
                    </>
                  )}
                  {job.state === 'error' && (
                    <>
                      <span className="share-doing share-err">The clip could not be rendered: {job.message}</span>
                      <button type="button" className="btn" data-autofocus onClick={() => setAttempt((n) => n + 1)}>
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
              {job.state === 'done' ? (
                <>
                  <span>
                    {job.info.width}×{job.info.height}
                  </span>
                  <span>{size(job.bytes)}</span>
                  <span>{(job.info.clipMs / 1000).toFixed(1)} s loop</span>
                  <span>
                    {job.info.agents} {job.info.agents === 1 ? 'agent' : 'agents'}
                  </span>
                  <span>{covers(job.info)}</span>
                </>
              ) : (
                <span>{job.state === 'rendering' ? `${pct}%` : ' '}</span>
              )}
            </figcaption>
          </figure>

          <div className="share-opts">
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
            <label className="share-bare">
              <input type="checkbox" checked={bare} onChange={(e) => setBare(e.target.checked)} aria-describedby="share-bare-what" />
              <span>
                <b>Hide transcript text</b>
                <small id="share-bare-what">no task, names or speech from your transcripts — people and desks only</small>
              </span>
            </label>
          </div>

          {/* The privacy line changes with the checkbox rather than being a fixed disclaimer, because
              a warning that reads the same whether or not it applies is one people learn to skip. */}
          <p id="share-privacy" className={bare ? 'share-note' : 'share-note share-warn'}>
            {bare ? (
              <>
                <b>Text hidden.</b> People, desks and walks only; agents are numbered, not named.
              </>
            ) : (
              <>
                <b>Look at it before you post it.</b> This clip shows the session’s task, what each agent was asked to
                do and what they said.
              </>
            )}
          </p>
          {missing > 0 && held > 0 && (
            <p className="share-note">
              This page holds only the latest {held.toLocaleString('en-US')} events of the session, so the clip starts
              partway through. <code>roundtable --gif</code> in a terminal reads all of it.
            </p>
          )}
        </div>

        <footer className="share-ft">
          <div className="share-actions">
            {job.state === 'done' ? (
              <a className="btn share-primary" href={job.url} download={file} data-autofocus>
                Download GIF
              </a>
            ) : (
              <button type="button" className="btn share-primary" disabled>
                Download GIF
              </button>
            )}
            <button type="button" className="btn" onClick={() => void copy()}>
              {copied === 'ok' ? 'Caption copied' : 'Copy caption'}
            </button>
            <span className="share-copied" role="status" aria-live="polite">
              {copied === 'refused' ? 'The browser refused the clipboard — select the line below and copy it.' : ''}
            </span>
          </div>
          <input
            className="share-caption"
            readOnly
            value={CAPTION}
            aria-label="caption to post with the GIF"
            onFocus={(e) => e.currentTarget.select()}
          />
          <p className="share-local">
            {job.state === 'done' ? `rendered in ${(job.tookMs / 1000).toFixed(1)} s, ` : ''}in this tab · nothing is
            uploaded · saved as {file}
          </p>
        </footer>
      </div>
    </div>
  );
}
