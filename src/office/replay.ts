/**
 * Replay: the same office, wound back to any moment it has seen.
 *
 * This is what turns the app from a live toy into an observer. The room is already deterministic
 * by construction — `mapEvent` is pure, `Engine` takes time through exactly one door (`tick`), and
 * `tests/engine.test.ts` proves two engines fed the same commands and the same tick sequence come
 * out identical — so a scrubber does not need snapshots, diffs or an undo log. It needs the
 * command stream and a clock, and it can rebuild any instant from the beginning.
 *
 * Two things make that honest rather than merely cheap:
 *
 *   - **Deltas come from the events' own timestamps, not from the wall clock.** Winding to a
 *     moment means replaying the real gaps between the things that happened, so a bubble that was
 *     four seconds old at that moment is four seconds old here too, and a walk that was half
 *     finished is still half finished.
 *   - **Rewinding rebuilds; playing forward continues.** An engine cannot un-tick, so seeking
 *     backwards starts a fresh one and winds it. Seeking forwards — which is what dragging a
 *     scrubber to the right and what plain playback both do — carries on from where it is, so the
 *     common case costs only the commands actually crossed.
 *
 * **The one limit, stated rather than discovered later.** The engine integrates each walk segment
 * against the time it is handed, so advancing a segment in twenty small steps and advancing it in
 * one large one differ in the last bits of a float: playing forward to a moment and dragging
 * straight to it agree to about a picometre of scene position, not bit for bit. Everything
 * discrete — who is in the room, what they are holding, which pose, which bubble and how old —
 * is identical either way, and the renderer rounds positions to whole canvas pixels before it
 * draws them, so nothing here is visible. It is written down because "deterministic" is a word
 * this codebase uses precisely, and this is the edge of what it buys.
 *
 * Nothing here reads the clock, touches the DOM or knows what a canvas is.
 */
import type { ActorState } from './engine';
import { Engine, IDLE_COFFEE_MS } from './engine';
import type { Cmd } from './mapping';

/** One command, stamped with the moment the event that produced it actually happened. */
export type Entry = { readonly ts: number; readonly cmd: Cmd };

/**
 * How many commands a session keeps for scrubbing.
 *
 * A day-long session produces far more than this, and an uncapped log is a leak with a scrubber
 * attached. What falls off the front is *counted*, and `truncated` says so out loud — a scrubber
 * that silently refuses to go back past an invisible line is worse than one that admits where its
 * history begins. Twenty thousand commands is roughly a long working session and a few megabytes.
 */
export const REPLAY_CAP = 20_000;

/**
 * The command log, as the live stream fills it.
 *
 * Entries are kept in **arrival order**, which is `seq` order, and not sorted by `ts`. The hub
 * assigns `seq` monotonically across the whole process, so arrival order is the causal order; a
 * transcript's own timestamps are not always monotonic (two files being tailed, a clock that
 * stepped) and sorting by them would reorder cause after effect. The cost is that a delta can come
 * out negative, which `Replay` clamps rather than obeys.
 */
export class Recorder {
  private readonly log: Entry[] = [];
  private lost = 0;

  record(ts: number, cmd: Cmd): void {
    this.log.push({ ts: Number.isFinite(ts) ? ts : 0, cmd });
    if (this.log.length > REPLAY_CAP) {
      this.log.shift();
      this.lost += 1;
    }
  }

  /** The log itself. Callers read it; only `record` writes it. */
  entries(): readonly Entry[] {
    return this.log;
  }

  /** How many commands the cap has dropped off the front. Never hidden. */
  get truncated(): number {
    return this.lost;
  }

  /** The span the log can actually rebuild, or `undefined` when nothing has been recorded. */
  get span(): { from: number; to: number } | undefined {
    if (this.log.length === 0) return undefined;
    let from = this.log[0].ts;
    let to = from;
    for (const e of this.log) {
      if (e.ts < from) from = e.ts;
      if (e.ts > to) to = e.ts;
    }
    return { from, to };
  }

  clear(): void {
    this.log.length = 0;
    this.lost = 0;
  }
}

/**
 * The largest gap replay will actually simulate between two commands.
 *
 * Real sessions have holes in them — an agent waits nine minutes for a build, and nothing is
 * recorded in between. Handing that whole gap to `tick` is correct, but it is also unbounded work
 * in the one place a scrubber has to feel immediate, so it is capped.
 *
 * **The cap is derived from the engine's own slowest behaviour, not chosen.** It was a flat thirty
 * seconds on the reasoning that "past the point where every queue has drained, more time changes
 * nothing anyone can see" — which stopped being true the moment the office learned to send an
 * agent for coffee after ninety seconds of idleness. A flat cap below that threshold does not
 * merely truncate an idle gap, it *deletes a behaviour*: the live room shows the coffee walk and
 * the replay of the very same session silently does not. Tying the number to `IDLE_COFFEE_MS`
 * means the next time-based behaviour that outlives it breaks the arithmetic here rather than
 * quietly disappearing from history.
 */
export const MAX_GAP_MS = IDLE_COFFEE_MS + 30_000;

/**
 * A scrubbable office.
 *
 * Hand it a log and it can put the room at any moment in it. `advance` plays forward at whatever
 * rate the caller feeds it, so the same object serves both the scrubber and the play button.
 */
export class Replay {
  private engine = new Engine();
  /** How far into `log` has been applied. */
  private cursor = 0;
  /** The moment the engine currently stands at. */
  private at = 0;

  constructor(private readonly log: readonly Entry[]) {
    this.at = log.length > 0 ? log[0].ts : 0;
  }

  /** The moment the room is currently showing. */
  get position(): number {
    return this.at;
  }

  /** The first moment this log can honestly rebuild. */
  get from(): number {
    return this.log.length > 0 ? this.log[0].ts : 0;
  }

  /** The last moment it knows anything about. */
  get to(): number {
    let to = this.from;
    for (const e of this.log) if (e.ts > to) to = e.ts;
    return to;
  }

  /**
   * Puts the room at `ts`.
   *
   * Seeking backwards throws the engine away and winds a new one from the start of the log, since
   * a simulation cannot be un-ticked. Seeking forwards continues from where it is, which is the
   * case a dragged scrubber and ordinary playback are both made of.
   */
  seek(ts: number): ActorState[] {
    const want = Number.isFinite(ts) ? ts : this.at;
    if (want < this.at) {
      this.engine = new Engine();
      this.cursor = 0;
      this.at = this.from;
    }
    return this.wind(want);
  }

  /**
   * Plays forward by `dtMs` of session time and returns the frame.
   *
   * Playback is seeking with a smaller step: the same winding, so a played frame and a seeked one
   * at the same instant are the same room.
   */
  advance(dtMs: number): ActorState[] {
    const dt = Number.isFinite(dtMs) ? Math.max(0, dtMs) : 0;
    return this.wind(this.at + dt);
  }

  /** Everyone the office has no chair for at this moment. */
  offsite(): readonly string[] {
    return this.engine.offsite();
  }

  /**
   * Applies every command up to `want`, ticking the real gaps between them.
   *
   * Commands sharing a timestamp — a burst is normal, one transcript line yields several — are
   * applied together before the clock moves, so the office sees them as simultaneous rather than
   * inventing an ordering with time in between.
   */
  private wind(want: number): ActorState[] {
    let frame: ActorState[] | undefined;
    while (this.cursor < this.log.length && this.log[this.cursor].ts <= want) {
      const ts = this.log[this.cursor].ts;
      // A negative step means the stream's own timestamps went backwards, which happens when two
      // transcripts are tailed at once. Arrival order is the causal truth; the clock is not
      // allowed to run backwards because of it.
      const gap = Math.min(MAX_GAP_MS, Math.max(0, ts - this.at));
      if (gap > 0) {
        frame = this.engine.tick(gap);
        this.at += gap;
      }
      while (this.cursor < this.log.length && this.log[this.cursor].ts === ts) {
        this.engine.apply(this.log[this.cursor].cmd);
        this.cursor += 1;
      }
      this.at = Math.max(this.at, ts);
    }
    const tail = Math.min(MAX_GAP_MS, Math.max(0, want - this.at));
    this.at = want;
    // Always tick, even by zero: the caller asked for a frame, and a seek that landed exactly on a
    // command's own timestamp must still report the room rather than nothing.
    return this.engine.tick(tail) ?? frame;
  }
}

/**
 * The room as it stood at one moment, from scratch.
 *
 * The one-shot form, for a caller that wants a frame and not a scrubber — a thumbnail, a test, a
 * diff between two instants. `Replay` is what a scrubber should hold, because it keeps the engine
 * and only pays for the commands a drag actually crosses.
 */
export function frameAt(log: readonly Entry[], ts: number): ActorState[] {
  return new Replay(log).seek(ts);
}
