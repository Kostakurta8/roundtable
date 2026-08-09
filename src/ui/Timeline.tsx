/**
 * The activity strip: one column per second of session time, stacked by what happened in it.
 *
 * Volume alone would not say much — a busy second of tool calls and a busy second of refusals
 * look identical as a single bar — so the mix is the point: teal for tool calls, green for
 * messages, grey for thinking, red for failures. Pressing a column seeks the room and the feed
 * to that second.
 *
 * It is the app's only time-travel control, and until now it was reachable by mouse alone. The
 * plot was `role="img"`, which makes every child of it presentational however interactive it
 * really is, and the columns were bare `div`s carrying an `onClick`: no tab stop, no key handler,
 * nothing announced. The structure here is what the strip always behaved like — a labelled group
 * of buttons, one per bucket, sharing a single roving tab stop.
 *
 * Why a group of buttons rather than the two other honest readings:
 *
 * - A **slider** would be one element and one announcement, which is tempting for a 220-column
 *   strip. But a slider's value *is* its position: moving it with an arrow key is the commit. Here
 *   a commit opens the dock, switches the panel to the feed and freezes the whole room in the past,
 *   which is not something to do on every arrow press. Moving and committing are two acts, so the
 *   widget has to be one that separates them.
 * - A **listbox** separates them, but its options are values being chosen, and `aria-selected` on
 *   a row the cursor is merely passing over says the room is showing a second it is not.
 * - A **button** already means "press me and something happens", and it brings Enter and Space
 *   activation from the platform rather than from a hand-written key handler that can drift from
 *   it. What the room is currently replaying is `aria-current`, which is a different claim from
 *   "focused" and is exactly the claim this strip needs to make.
 */
import { memo, useMemo, useRef, useState } from 'react';
import { BUCKET_CAP, BUCKET_MS, type RtBucket } from '../store';
import { clockSec, duration } from './format';

/** Columns drawn at once. Past this the strip shows the most recent window rather than shrinking. */
const MAX_COLUMNS = 220;
/**
 * How far PageUp/PageDown jump. A strip this wide needs a coarse gear as well as a fine one:
 * crossing 220 columns one arrow press at a time is a keyboard path nobody walks twice.
 */
const PAGE = 10;

type Series = keyof Omit<RtBucket, 't'>;
const SERIES: readonly { key: Series; label: string; cls: string }[] = [
  { key: 'tools', label: 'tools', cls: 's-tools' },
  { key: 'says', label: 'messages', cls: 's-says' },
  { key: 'thinks', label: 'thinking', cls: 's-thinks' },
  { key: 'errors', label: 'errors', cls: 's-errors' },
];

const bucketTotal = (b: RtBucket): number => b.says + b.tools + b.thinks + b.errors;

/**
 * One column, in words — the button's accessible name *and* its mouse tooltip, from one string, so
 * what a pointer reads and what a screen reader hears cannot drift.
 *
 * Zeroes are dropped. "0 messages, 0 thinking, 0 failed" is noise in a name that is read aloud on
 * every single arrow press.
 */
function labelOf(b: RtBucket): string {
  const parts: string[] = [];
  if (b.tools > 0) parts.push(`${b.tools} tool call${b.tools === 1 ? '' : 's'}`);
  if (b.says > 0) parts.push(`${b.says} message${b.says === 1 ? '' : 's'}`);
  if (b.thinks > 0) parts.push(`${b.thinks} thinking`);
  if (b.errors > 0) parts.push(`${b.errors} failed`);
  return `${clockSec(b.t)} · ${parts.length > 0 ? parts.join(', ') : 'nothing'}`;
}

export type TimelineProps = {
  buckets: RtBucket[];
  firstTs: number;
  lastTs: number;
  /**
   * How many turns the session has had — every one of them, including the ones the feed's cap has
   * already dropped. Named for what it is: it used to be handed `msgs.length`, which stops rising
   * at a thousand, so the strip's own summary line quietly froze on a session long enough to be
   * worth summarising.
   */
  turns: number;
  /**
   * The instant the room is replaying, or `null` while it is live.
   *
   * The strip is what puts the room in the past, so it is the surface that has to say where the
   * past is. Without this the only mark of a held seek was a pill in the top bar, and the control
   * that caused it looked exactly as it does when nothing is held.
   */
  seekTs: number | null;
  onSeek: (ts: number) => void;
};

export const Timeline = memo(function Timeline({
  buckets,
  firstTs,
  lastTs,
  turns,
  seekTs,
  onSeek,
}: TimelineProps) {
  const plot = useRef<HTMLDivElement>(null);
  /**
   * Where the keyboard is on the strip, held as a *timestamp* rather than an index.
   *
   * The window slides by one column every second a session is busy, so an index would silently
   * come to mean a different second between one arrow press and the next — the cursor would drift
   * backwards through history at exactly the rate history arrives.
   */
  const [cursorTs, setCursorTs] = useState<number | null>(null);

  const shown = useMemo(
    () => (buckets.length > MAX_COLUMNS ? buckets.slice(buckets.length - MAX_COLUMNS) : buckets),
    [buckets],
  );
  const peak = useMemo(() => shown.reduce((m, b) => Math.max(m, bucketTotal(b)), 0), [shown]);
  const span = firstTs > 0 && lastTs > firstTs ? lastTs - firstTs : 0;

  /**
   * Which column holds the tab stop. With nothing chosen yet that is the newest one: the strip is
   * an observer's, and the second a keyboard user most likely wants is the one happening now.
   */
  const cursor = useMemo(() => {
    if (shown.length === 0) return -1;
    if (cursorTs === null) return shown.length - 1;
    const i = shown.findIndex((b) => b.t === cursorTs);
    if (i !== -1) return i;
    // The window slid past where the cursor was. Clamp to the end it left through rather than
    // jumping to the other one.
    return cursorTs < shown[0].t ? 0 : shown.length - 1;
  }, [shown, cursorTs]);

  /**
   * Move the cursor, and move the real focus with it. A roving `tabIndex` that nothing focuses is
   * a lie told to the tab order: the attribute would move while the screen reader stayed put and
   * announced nothing.
   */
  const moveTo = (i: number): void => {
    if (shown.length === 0) return;
    const to = Math.max(0, Math.min(shown.length - 1, i));
    setCursorTs(shown[to].t);
    plot.current?.querySelectorAll<HTMLButtonElement>('.tl-bar')[to]?.focus();
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>): void => {
    // Enter and Space are deliberately absent: each column is a real <button>, so the platform
    // already fires its click on both. A second implementation here is one that can drift from it.
    if (e.key === 'ArrowLeft') moveTo(cursor - 1);
    else if (e.key === 'ArrowRight') moveTo(cursor + 1);
    else if (e.key === 'PageUp') moveTo(cursor - PAGE);
    else if (e.key === 'PageDown') moveTo(cursor + PAGE);
    else if (e.key === 'Home') moveTo(0);
    else if (e.key === 'End') moveTo(shown.length - 1);
    else return;
    e.preventDefault();
  };

  const seconds = BUCKET_MS / 1000;

  return (
    <section className="timeline panel" aria-label="activity timeline">
      <div className="tl-side">
        <span>ELAPSED</span>
        <b>{span > 0 ? duration(span) : '—'}</b>
      </div>

      {/*
        A group, not an image. The window it covers is named here rather than left to be inferred
        from 220 unreadable columns, and so is what the arrow keys and Enter do — a strip of
        buttons with no text on them cannot explain itself any other way.
      */}
      <div
        ref={plot}
        className="tl-plot"
        role="group"
        aria-label={
          shown.length > 0
            ? `activity, one column per ${seconds} second${seconds === 1 ? '' : 's'} from ${clockSec(
                shown[0].t,
              )} to ${clockSec(
                shown[shown.length - 1].t,
              )} — arrow keys move along it, Enter seeks the room to a column`
            : 'activity — nothing has happened in this session yet'
        }
        onKeyDown={onKeyDown}
      >
        {shown.map((b, i) => {
          const total = bucketTotal(b);
          // Square-root, not linear: a single second with forty tool calls would otherwise flatten
          // every ordinary second in the strip to an invisible sliver.
          const h = peak > 0 ? Math.max(6, Math.round((Math.sqrt(total) / Math.sqrt(peak)) * 100)) : 0;
          const name = labelOf(b);
          return (
            <button
              key={b.t}
              type="button"
              className="tl-bar"
              // One tab stop for two hundred columns. Tabbing into the strip and needing two
              // hundred presses to leave it is not keyboard access, it is a room with a door.
              tabIndex={i === cursor ? 0 : -1}
              // Where the room is being replayed from — a claim about the app, not about focus,
              // which is why it is not `aria-selected` and not the focus ring.
              aria-current={seekTs !== null && b.t === seekTs ? 'true' : undefined}
              title={name}
              aria-label={name}
              onClick={() => {
                setCursorTs(b.t);
                onSeek(b.t);
              }}
            >
              {/* The button is the whole column; this is the data. Keeping them apart is what
                  gives a quiet second a full-height hit target and a visible focus ring instead
                  of the 2px sliver its own bar draws. */}
              <span className="tl-stack" style={{ height: `${h}%` }}>
                {SERIES.map(({ key, cls }) =>
                  b[key] > 0 ? (
                    <i key={key} className={cls} style={{ height: `${(b[key] / total) * 100}%` }} />
                  ) : null,
                )}
              </span>
            </button>
          );
        })}
        {shown.length === 0 && <span className="empty-note">no activity yet</span>}
      </div>

      <div className="tl-side" style={{ alignItems: 'flex-end' }}>
        <div className="tl-legend">
          {SERIES.map(({ key, label, cls }) => (
            <span key={key}>
              <i className={cls} />
              {label}
            </span>
          ))}
        </div>
        {/* The strip draws at most the recent window, while ELAPSED on the far side counts the
            whole session — two numbers a day-long session puts hours apart. Saying which slice
            the bars actually cover is what stops them being read as all of it.

            "Whole" is decided by count, not by clock: buckets exist only for seconds something
            happened in, so the first bar routinely sits seconds after `firstTs` (an opening user
            turn bumps no bucket) and a time comparison called almost every intact session
            truncated. If nothing was sliced here and the store never hit its cap, every bucket
            that ever existed is on screen — that is what "whole" means. */}
        <span>
          {turns} turns ·{' '}
          {shown.length === 0 || (shown.length === buckets.length && buckets.length < BUCKET_CAP)
            ? 'whole session'
            : lastTs - (shown[shown.length - 1].t + BUCKET_MS) < BUCKET_MS * 2
              ? `bars cover the last ${duration(shown[shown.length - 1].t + BUCKET_MS - shown[0].t)}`
              : // The covered stretch ended before the session did — an idle tail advances ELAPSED
                // but bumps no bucket, and "the last X" would claim a window that is long over.
                `bars cover ${duration(shown[shown.length - 1].t + BUCKET_MS - shown[0].t)} ending ${clockSec(
                  shown[shown.length - 1].t + BUCKET_MS,
                )}`}
        </span>
      </div>

      {/*
        What the room is showing, said out loud when it changes. `aria-current` marks the column,
        but a mark on one of two hundred siblings is only found by someone already standing on it;
        this is the announcement that a seek happened at all, and the only place the way back out
        of one is written down.
      */}
      <p className="sr-only" role="status">
        {seekTs === null
          ? 'The room is following the session live.'
          : `The room is showing ${clockSec(seekTs)}. Press Escape to resume live.`}
      </p>
    </section>
  );
});
