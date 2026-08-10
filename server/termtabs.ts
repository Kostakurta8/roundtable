/**
 * What the user's terminal calls each session.
 *
 * A Windows Terminal tab renamed by hand exists only inside that process: it is not in
 * `state.json` (309 bytes here, and no titles in it), the CLI never learns it, and a tab's
 * accessibility element carries the label with nothing identifying what runs inside it. The
 * tempting shortcut — pair the tabs with the sessions in order — was measured against this machine
 * and is wrong: two of four tabs swap places against their sessions' start times.
 *
 * So the mapping is *earned* rather than guessed. UI Automation hands back two things about the
 * active tab: the window title, which is that tab's label, and the text on its pane. That text is
 * the conversation, and the conversation is in exactly one transcript — so the pane says which
 * session the user is looking at, and the window title says what they call it. Match the two and
 * the pair is a fact.
 *
 * The consequences of "active tab only" are honest ones: a tab nobody has visited since the
 * observer started has no name here, and falls back to the CLI's own topic title. Nothing is ever
 * *guessed* — a session with no confident match keeps the name it already had.
 *
 * Windows-only by nature. Everywhere else this is inert and the caller sees `undefined`.
 */
import { execFile } from 'node:child_process';

/**
 * How much of the pane's text is asked for.
 *
 * The tail is what matters — it is the newest exchange, and therefore the part certain to be in
 * the transcript already. A whole scrollback would be megabytes across a poll loop. Six thousand
 * is a few screenfuls: a pane is mostly padding, and one measured here gave 285 usable characters
 * out of 1200 because a terminal pads every row it draws out to the window's full width.
 */
const PANE_TEXT_CHARS = 6000;

/** How long PowerShell gets before the read is abandoned. A hung probe must never stall a sweep. */
const PROBE_TIMEOUT_MS = 4000;

/**
 * The snippet length used to identify a session, in stripped characters.
 *
 * Long enough that no two sessions share one by accident, short enough to survive the pane holding
 * only part of the last message. Sixty characters of prose is around a sentence.
 */
export const MATCH_CHARS = 60;

/** How many independent snippets must point at one session before its name is believed. */
export const MIN_AGREEING_SNIPPETS = 2;

/**
 * Text with every space, newline and punctuation mark removed, lowercased.
 *
 * Terminals hard-wrap at the window's width and will split a word across two rows without adding
 * so much as a hyphen, so any comparison that preserves whitespace fails on exactly the long lines
 * most worth matching. Removing it entirely makes the wrap invisible; the letters are what carry
 * the identity anyway.
 */
export const squash = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, '');

/**
 * The one session whose recent text contains the pane's, or `undefined` when that is not exactly
 * one session.
 *
 * Ambiguity is answered with silence on purpose. Two sessions matching means the snippet was not
 * distinctive — a shared banner, an identical prompt echoed into a background job — and picking
 * either one would put a name on a session that may not own it. That is the failure this whole
 * mechanism exists to avoid, so it declines instead.
 */
export function matchSession(
  paneText: string,
  candidates: readonly { sessionId: string; text: string }[],
): string | undefined {
  const pane = squash(paneText);
  if (pane.length < MATCH_CHARS) return undefined;
  const haystacks = candidates.map((c) => ({ sessionId: c.sessionId, text: squash(c.text) }));

  // Walk backwards through the pane a snippet at a time rather than trusting its last line.
  //
  // The bottom of a Claude Code pane is the status bar and the input box — a token count, a
  // shortcut hint, a spinner — and none of that is in any transcript, so a single snippet taken
  // from the end matches nothing at all and the tab is never identified. The conversation is
  // directly above it. Stepping back finds it without needing to know how tall the chrome is.
  const votes = new Map<string, number>();
  for (let end = pane.length; end >= MATCH_CHARS; end -= MATCH_CHARS) {
    const needle = pane.slice(end - MATCH_CHARS, end);
    const hits = haystacks.filter((h) => h.text.includes(needle));
    // Only an unambiguous snippet votes. More than one session holding it means it was never
    // distinctive — a shared banner, a prompt echoed into two places — and the answer to that is
    // to keep looking rather than to pick one.
    if (hits.length === 1) votes.set(hits[0].sessionId, (votes.get(hits[0].sessionId) ?? 0) + 1);
  }

  // Two agreeing snippets, and no dissent.
  //
  // One is not enough, and this was measured rather than supposed: an observer's *own* transcript
  // quotes the sessions it is watching, so a single stray line of somebody else's screen quoted
  // anywhere in this session's history is enough to steal the name. Requiring two snippets that
  // both point at one session, with nothing pointing anywhere else, is what separates "this pane
  // belongs to that session" from "that session once mentioned this text".
  const ranked = [...votes.entries()].sort((a, b) => b[1] - a[1]);
  if (ranked.length !== 1) return undefined;
  return ranked[0][1] >= MIN_AGREEING_SNIPPETS ? ranked[0][0] : undefined;
}

export type ActiveTab = { title: string; text: string };

/**
 * The PowerShell that reads the terminal, as one line.
 *
 * `CASCADIA_HOSTING_WINDOW_CLASS` is Windows Terminal's own window class, so a machine running some
 * other terminal finds nothing and says so rather than reading a stranger's window. Only the active
 * pane is in the tree at all — the others are virtualised away by XAML — which is precisely why
 * this reads one tab and not four.
 */
const PROBE = [
  'Add-Type -AssemblyName UIAutomationClient,UIAutomationTypes;',
  '$r=[System.Windows.Automation.AutomationElement]::RootElement;',
  "$c=New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ClassNameProperty,'CASCADIA_HOSTING_WINDOW_CLASS');",
  '$w=$r.FindFirst([System.Windows.Automation.TreeScope]::Children,$c);',
  'if($null -eq $w){exit};',
  "$t=New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ClassNameProperty,'TermControl');",
  '$m=$w.FindFirst([System.Windows.Automation.TreeScope]::Descendants,$t);',
  'if($null -eq $m){exit};',
  '$p=$m.GetCurrentPattern([System.Windows.Automation.TextPattern]::Pattern);',
  `$x=$p.DocumentRange.GetText(${PANE_TEXT_CHARS});`,
  '[Console]::OutputEncoding=[System.Text.Encoding]::UTF8;',
  '@{title=$w.Current.Name;text=$x} | ConvertTo-Json -Compress',
].join('');

/**
 * The active tab's label and the text on its pane, or `undefined` for every reason this can fail.
 *
 * Every failure is the same answer — no terminal, not Windows, PowerShell missing, UI Automation
 * denied, a window that closed mid-read — because the caller's response to all of them is
 * identical: carry on with the name it already had. An observer must not be able to fall over
 * because of what some other application's window is doing.
 */
export async function readActiveTab(): Promise<ActiveTab | undefined> {
  if (process.platform !== 'win32') return undefined;
  return new Promise((resolve) => {
    const child = execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', PROBE],
      { timeout: PROBE_TIMEOUT_MS, windowsHide: true, maxBuffer: 1 << 20 },
      (err, stdout) => {
        if (err || !stdout.trim()) return resolve(undefined);
        try {
          const parsed: unknown = JSON.parse(stdout);
          if (!parsed || typeof parsed !== 'object') return resolve(undefined);
          const { title, text } = parsed as { title?: unknown; text?: unknown };
          if (typeof title !== 'string' || typeof text !== 'string') return resolve(undefined);
          const trimmed = title.trim();
          return resolve(trimmed.length > 0 ? { title: trimmed, text } : undefined);
        } catch {
          return resolve(undefined);
        }
      },
    );
    // A probe that outlives its timeout is killed rather than left holding a handle on the window.
    child.on('error', () => resolve(undefined));
  });
}
