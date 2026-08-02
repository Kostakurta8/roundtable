/**
 * Behavior mapping: the pure translation from the hub's normalized event stream (`Ev`) into
 * commands the office simulation understands (`Cmd`). `mapEvent` never touches the DOM, the
 * clock, or any store — the same event (and the same roster) always produces the same
 * commands, which is what lets the office engine (Task 9) be driven straight off this layer
 * with no simulation running yet.
 */
import type { Ev } from '../../shared/events';

export type Cmd =
  | { op: 'ensureActor'; agentId: string }
  | { op: 'think'; agentId: string; text: string }
  | { op: 'workBurst'; agentId: string; label: string } // typing + screen anim
  | { op: 'deliver'; agentId: string; to: 'main'; text: string } // walk to orchestrator, speak
  | { op: 'confront'; agentId: string; to: string; text: string; verdict: 'ok' | 'err' }
  | { op: 'status'; agentId: string; text: string };

const THINK_MAX = 90;
const SENTENCE_MAX = 120;

/** A glance, not the transcript: plain char-count truncation, no ellipsis marker. */
const cap = (s: string, max: number): string => (s.length > max ? s.slice(0, max) : s);

/**
 * Verdicts are the uppercase markers an agent writes when it confirms or refutes a claim.
 * Matching is case-sensitive on purpose (prose like "confirmed the fix" is not a verdict) and
 * mirrors `src/store.ts`'s `verdictOf` exactly: the chat card and the office confront read the
 * same events and must agree on which messages are verdicts, so the known limitation (an
 * unbounded substring — "UNREFUTED" would misfire) is shared rather than fixed in only one of
 * the two places that need to agree.
 */
const verdictOf = (text: string): 'ok' | 'err' | undefined =>
  text.includes('REFUTED') ? 'err' : text.includes('CONFIRMED') ? 'ok' : undefined;

/**
 * The first sentence of a message, for a speech bubble: up to and including the first
 * `.` / `!` / `?`, or up to (excluding) the first newline; the whole text if none of those
 * appear. Trimmed, then capped at ~120 chars either way.
 */
function firstSentence(text: string): string {
  const t = text.trim();
  const idx = t.search(/[.!?\n]/);
  const cut = idx === -1 ? t : t[idx] === '\n' ? t.slice(0, idx) : t.slice(0, idx + 1);
  return cap(cut.trim(), SENTENCE_MAX);
}

/**
 * The roster agent named in `text`, if any — scanned in the roster's own (insertion) order so
 * the result is deterministic. `main` is never returned here: it is already the fallback, and
 * counting it as a match would let the literal substring "main" (present in ordinary words like
 * "domain" or "remains", and in phrases like "main branch") shadow a genuinely named agent
 * whenever main happens to be first in the roster — which it usually is, being the first agent
 * seen.
 */
function namedInRoster(text: string, roster: ReadonlySet<string>): string | undefined {
  for (const id of roster) {
    if (id && id !== 'main' && text.includes(id)) return id;
  }
  return undefined;
}

/** Mirrors `src/App.tsx`'s HUD token formatting: plain below 1000, one-decimal `k` at/above it. */
const fmtTok = (n: number): string => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

/**
 * Translates one normalized event into zero or more office commands.
 *
 * `roster` is the set of agent ids seen so far. The caller (Task 10) accumulates it from this
 * module's own `ensureActor` commands as the stream plays; `mapEvent` only ever reads it, so it
 * stays pure with respect to its arguments and keeps no module-level mutable state of its own.
 */
export function mapEvent(ev: Ev, roster: ReadonlySet<string> = new Set<string>()): Cmd[] {
  switch (ev.kind) {
    case 'agentSeen':
      return [{ op: 'ensureActor', agentId: ev.ref.agentId }];

    case 'thinking':
      return [{ op: 'think', agentId: ev.ref.agentId, text: cap(ev.text, THINK_MAX) }];

    case 'toolStart': {
      const label = `${ev.tool} ${ev.target ?? ''}`.trim();
      return [{ op: 'workBurst', agentId: ev.ref.agentId, label }];
    }

    case 'agentText': {
      const verdict = verdictOf(ev.text);
      if (verdict) {
        const to = namedInRoster(ev.text, roster) ?? 'main';
        return [{ op: 'confront', agentId: ev.ref.agentId, to, text: firstSentence(ev.text), verdict }];
      }
      // Main talking with no verdict is not a trip across the room — the chat feed already
      // shows it, and main cannot walk a note to itself.
      if (ev.ref.agentId === 'main') return [];
      return [{ op: 'deliver', agentId: ev.ref.agentId, to: 'main', text: firstSentence(ev.text) }];
    }

    case 'usage': {
      const total = ev.inTok + ev.outTok;
      return [{ op: 'status', agentId: ev.ref.agentId, text: `${fmtTok(total)} tok` }];
    }

    // `userMessage`, `toolResult`, `fileEdit`, `agentSpawn`, `sessionSeen` (which carries no
    // `ref` at all), and any future kind this layer does not yet know: the office reacts to
    // these only indirectly, through the other events they arrive alongside.
    default:
      return [];
  }
}
