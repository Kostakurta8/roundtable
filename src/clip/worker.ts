/**
 * The share dialog's renderer, off the page's thread.
 *
 * A twenty-second clip of the showcase session is 262 frames drawn and then encoded — about seven
 * seconds of unbroken work in node, and no less in a tab. On the main thread that is seven seconds
 * of a frozen room, a progress bar that cannot repaint and a Cancel button that cannot be pressed.
 * Here the page stays live, and cancelling is `terminate()`: no flag for the frame loop to poll and
 * no half-built clip to unwind, because the whole worker goes.
 *
 * It runs `renderClip` from `./render` and nothing else — the function `--gif` runs — so the file
 * the dialog offers is the file the terminal would have written from the same events.
 */
import type { Ev } from '../../shared/events';
import { renderClip, type ClipOptions, type ClipProgress, type ClipResult } from './render';

export type ClipRequest = { evs: readonly Ev[]; opts: ClipOptions };

/** Everything the dialog shows about a finished clip, which is everything but the bytes. */
export type ClipInfo = Omit<ClipResult, 'gif'>;

export type ClipReply =
  | ({ kind: 'progress' } & ClipProgress)
  | { kind: 'done'; gif: ArrayBuffer; info: ClipInfo }
  | { kind: 'error'; message: string };

/**
 * The two members of the worker scope this uses, typed as a worker's rather than a window's.
 *
 * The project compiles against the DOM library, where `self` is a `Window` and `postMessage` wants
 * a target origin; adding the WebWorker library to `tsconfig.json` for one file would retype
 * `self` for every file in `src/`.
 */
type Scope = {
  onmessage: ((e: MessageEvent<ClipRequest>) => void) | null;
  postMessage: (msg: ClipReply, transfer?: Transferable[]) => void;
};
const scope = self as unknown as Scope;

/**
 * The fastest the bar is told anything. A frame takes about eleven milliseconds to draw, and a
 * message per frame is a render per frame on the page for a bar that moves a pixel at a time.
 */
const PROGRESS_EVERY_MS = 60;

scope.onmessage = (e) => {
  const { evs, opts } = e.data;
  let told = 0;
  try {
    const clip = renderClip(evs, opts, (p) => {
      const now = performance.now();
      // The last tick of each phase always goes through, so the bar never stops short of a phase
      // it has in fact finished.
      if (p.done !== p.total && now - told < PROGRESS_EVERY_MS) return;
      told = now;
      scope.postMessage({ kind: 'progress', ...p });
    });
    const { gif, ...info } = clip;
    // Transferred rather than copied: the page takes ownership of the megabytes, and this worker
    // is about to be thrown away anyway.
    scope.postMessage({ kind: 'done', gif: gif.buffer, info }, [gif.buffer]);
  } catch (err) {
    scope.postMessage({ kind: 'error', message: err instanceof Error ? err.message : String(err) });
  }
};
