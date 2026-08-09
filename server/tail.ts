/**
 * Incremental JSONL tailing by byte offset.
 *
 * The files under `~/.claude` are appended to by another process while this one reads them, and
 * they get large — a long session is tens of megabytes, and a single line carrying a pasted image
 * can be megabytes on its own. So every read here is bounded: a call returns at most
 * `MAX_BATCH_BYTES` worth of complete lines and leaves its offset mid-file, and a caller that
 * wants to catch up loops until `readNew` comes back empty.
 */
import { closeSync, openSync, readSync, statSync } from 'node:fs';

/**
 * The most one `readNew` call will pull off disk. Large enough that catching up on a fresh
 * session is a handful of calls, small enough that a 40 MB transcript never becomes a 40 MB
 * Buffer — the reason a first read used to allocate the entire file at once.
 */
export const MAX_BATCH_BYTES = 1 << 20; // 1 MiB

const NL = 0x0a;

export type TailStats = {
  /** How many times a file was seen to shrink, i.e. truncated or replaced under us. */
  resets: number;
  /** How many oversized lines were skipped unparsed. */
  skipped: number;
};

export class Tailer {
  private readonly offsets = new Map<string, number>();
  private readonly stats: TailStats = { resets: 0, skipped: 0 };

  /**
   * @param onReset Called when a file is found shorter than the offset held for it, i.e. it was
   *   truncated or replaced. Everything after that point is a *different* file's content, so the
   *   caller has to discard whatever per-file state it was accumulating (a Normalizer's "have I
   *   announced this agent" latch, above all) or the replayed lines fold into stale state.
   * @param onSkip Called when an oversized line is stepped over, with the file it was stepped
   *   over in. `stats.skipped` counts the same event, but a global counter cannot say *whose*
   *   tail lost a line — and the loss is not cosmetic: a skipped `tool_result` is a tool chip
   *   that spins for the rest of the session, because the result that would end it never
   *   arrives. Attributing the skip to a file is what lets a caller attribute it to a session.
   */
  constructor(
    private readonly onReset?: (filePath: string) => void,
    private readonly onSkip?: (filePath: string) => void,
  ) {}

  /** Byte offset currently held for a path; 0 if it has never been read. */
  offsetOf(filePath: string): number {
    return this.offsets.get(filePath) ?? 0;
  }

  /** Drops all state for a path, so a watch that is torn down does not leak an entry per file. */
  forget(filePath: string): void {
    this.offsets.delete(filePath);
  }

  /**
   * Process-wide totals. Useful for a health readout, but not for telling a user what *their*
   * session lost — one tailer serves every watched file, so these numbers cannot be attributed.
   * That is what `onReset` and `onSkip` are for.
   */
  snapshot(): TailStats {
    return { ...this.stats };
  }

  /**
   * Complete lines appended since the last call, at most `MAX_BATCH_BYTES` of them.
   *
   * Returns `[]` at end of file, so `while (readNew(p).length) …` is the way to drain a file that
   * grew by more than one batch. Throws only if the file cannot be opened or stat'd at all — the
   * caller treats that as "not readable right now" and retries on the next filesystem event.
   */
  readNew(filePath: string): string[] {
    const size = statSync(filePath).size;
    let off = this.offsets.get(filePath) ?? 0;

    // Shorter than where we were reading means the file was truncated or swapped for a new one
    // with the same name. Holding the old offset would make this tail permanently blind, so the
    // honest recovery is to start over: what follows is a different file's bytes.
    if (size < off) {
      this.stats.resets += 1;
      off = 0;
      this.offsets.set(filePath, 0);
      this.onReset?.(filePath);
    }
    if (size === off) return [];

    const want = Math.min(size - off, MAX_BATCH_BYTES);
    const buf = Buffer.allocUnsafe(want);
    const read = this.fill(filePath, buf, off);
    if (read === 0) return [];

    const chunk = buf.subarray(0, read);
    const lastNl = chunk.lastIndexOf(NL);

    if (lastNl === -1) {
      // No terminator anywhere. Two cases, and they must be told apart: a batch that came back
      // full is a line longer than a batch, and stepping over it is the only way forward; a short
      // read is the writer being mid-line, and the rest of that line is still on its way.
      //
      // Note what the oversize test is: a full batch containing no newline is *itself* the proof
      // that the line is longer than a batch, and nothing else is measured. An earlier version
      // kept a separate, larger line cap, and any line between the two sizes filled a whole batch
      // without a terminator while still failing the "is it oversized yet" question — so the
      // offset never moved and the file was wedged forever. Never reintroduce a second cap here.
      if (read === want && want === MAX_BATCH_BYTES) {
        this.stats.skipped += 1;
        this.offsets.set(filePath, off + read); // the next newline resynchronizes
        this.onSkip?.(filePath);
      }
      return [];
    }

    this.offsets.set(filePath, off + lastNl + 1);

    const out: string[] = [];
    let start = 0;
    while (start <= lastNl) {
      let end = chunk.indexOf(NL, start);
      if (end === -1 || end > lastNl) end = lastNl;
      if (end > start) out.push(chunk.toString('utf8', start, end));
      start = end + 1;
    }
    return out;
  }

  /**
   * Reads until the buffer is full or the file ends.
   *
   * `readSync` is allowed to return fewer bytes than asked for, and does on large reads and on
   * some filesystems — a single call that trusted its return value would silently drop the
   * remainder of the batch and then resume from an offset that had never been read.
   */
  private fill(filePath: string, buf: Buffer, position: number): number {
    const fd = openSync(filePath, 'r');
    try {
      let got = 0;
      while (got < buf.length) {
        const n = readSync(fd, buf, got, buf.length - got, position + got);
        if (n <= 0) break; // end of file
        got += n;
      }
      return got;
    } finally {
      closeSync(fd);
    }
  }
}
