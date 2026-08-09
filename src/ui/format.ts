/** Formatting the HUD and every panel share, so two places can never disagree on a number. */
import type { SessionSummary } from '../../shared/protocol';

/** Compact token counts: plain below 1000, one decimal `k`, then `M`. */
export function tokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

/**
 * A dollar estimate. `undefined` means no rate card for that model, which is not the same as free
 * — it prints as a dash so nobody reads a missing price as a zero one.
 */
export function money(n: number | undefined): string {
  if (n === undefined) return '—';
  if (n === 0) return '$0.00';
  if (n < 0.01) return '<$0.01';
  return `$${n.toFixed(2)}`;
}

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** How long ago, from a fixed `now` the caller supplies so this stays a pure function. */
export function ago(ts: number, now: number): string {
  const d = Math.max(0, now - ts);
  if (d < MIN) return `${Math.round(d / 1000)}s ago`;
  if (d < HOUR) return `${Math.round(d / MIN)}m ago`;
  if (d < DAY) return `${Math.round(d / HOUR)}h ago`;
  return `${Math.round(d / DAY)}d ago`;
}

/** A span, as a duration rather than a clock time: `4.2s`, `1m 20s`, `2h 05m`. */
export function duration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < MIN) return `${(ms / 1000).toFixed(1)}s`;
  if (ms < HOUR) return `${Math.floor(ms / MIN)}m ${String(Math.floor((ms % MIN) / 1000)).padStart(2, '0')}s`;
  return `${Math.floor(ms / HOUR)}h ${String(Math.floor((ms % HOUR) / MIN)).padStart(2, '0')}m`;
}

export const clip = (s: string, max: number): string =>
  s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s;

export const oneLine = (s: string): string => s.replace(/\s+/g, ' ').trim();

/** Wall-clock, for a message header. */
export const clock = (ts: number): string =>
  new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

export const clockSec = (ts: number): string =>
  new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

/**
 * An ISO string for a `<time dateTime>`, or `undefined` when the timestamp is not a real instant.
 * `new Date(NaN).toISOString()` throws, and it would throw inside a render — taking the whole
 * panel down over one malformed transcript line.
 */
export function isoOrUndefined(ts: number): string | undefined {
  if (!Number.isFinite(ts)) return undefined;
  try {
    return new Date(ts).toISOString();
  } catch {
    return undefined;
  }
}

const SHORT_ID = 8;
export const shortId = (id: string): string => (id.length > SHORT_ID ? id.slice(0, SHORT_ID) : id);

/**
 * The last two segments of a path, which is the part that identifies a file to a person.
 * Kept as text; the CSS truncates from the left so a long path loses its head, not its name.
 */
export function shortPath(p: string): string {
  const parts = p.split(/[\\/]/).filter(Boolean);
  return parts.length <= 2 ? p : parts.slice(-2).join('/');
}

/** The last segment of a directory, ignoring a trailing separator. `undefined` if there is none. */
export function pathLeaf(p: string | undefined): string | undefined {
  if (p === undefined) return undefined;
  const parts = p.split(/[\\/]/).filter((s) => s.trim().length > 0);
  return parts[parts.length - 1];
}

/**
 * What a session is called: the CLI's own name for it, else the head of its id.
 *
 * This is the identity and it never changes shape — a person who has learnt that the tab reading
 * `dev-c8` is theirs must find the same word there a minute later.
 */
export const sessionName = (s: SessionSummary): string => s.name ?? shortId(s.sessionId);

/**
 * The one line that tells a session apart from its neighbours.
 *
 * The name cannot do it: the CLI builds it from the working directory's leaf plus a counter, so
 * six sessions started in the same place are `dev-c8`, `dev-52`, `dev-ff` — six labels that
 * differ by two hex characters and by nothing anyone can choose between. What actually
 * distinguishes them is what they were asked to do, which is what `label` carries.
 *
 * The fallbacks are real data, never a written-in sentence: a session with no opening prompt yet
 * has nothing to say about itself, and printing "new session" or "idle" would be this file making
 * a claim on the session's behalf. The leaf of the working directory is at least true, and the
 * transcript's own slug is true when even that is unknown.
 */
export function sessionAbout(s: SessionSummary): string {
  const label = s.label?.trim();
  if (label) return label;
  return pathLeaf(s.cwd) ?? s.slug;
}

/**
 * What an edit did to a file: `+12 −3`, or nothing at all.
 *
 * Each half appears only when it is known, because absent and zero are different facts — the tool
 * call not carrying enough to count is not the same as a change that added no lines, and printing
 * the first as `+0` states a measurement nobody made. A real minus sign, not a hyphen: these sit
 * next to a path, and `-3` beside a filename reads as part of it.
 */
export function editLines(added: number | undefined, removed: number | undefined): string | undefined {
  const parts: string[] = [];
  if (added !== undefined) parts.push(`+${added}`);
  if (removed !== undefined) parts.push(`−${removed}`);
  return parts.length > 0 ? parts.join(' ') : undefined;
}
