/**
 * Naming a session after the terminal tab it is running in.
 *
 * The mapping cannot be looked up anywhere — a hand-renamed Windows Terminal tab is not on disk,
 * and a tab's accessibility element says nothing about the process inside it — so it is earned by
 * finding the text on the active pane inside exactly one transcript. Everything below is about the
 * one property that matters: it must decline rather than guess, because a name on the wrong
 * session is worse than no name at all.
 */
import { describe, expect, it } from 'vitest';
import { MATCH_CHARS, MIN_AGREEING_SNIPPETS, matchSession, readActiveTab, squash } from '../server/termtabs';

/** `n` snippets' worth of distinctive prose, so a pane can carry more than one voting snippet. */
const prose = (seed: string, snippets: number): string =>
  Array.from({ length: snippets }, (_, i) => `${seed}${i}`.padEnd(MATCH_CHARS + 4, 'x')).join(' ');

describe('squash', () => {
  it('erases the wrap a terminal introduces', () => {
    // A terminal breaks a line at the window's width without adding a hyphen or a space, so the
    // same sentence is spelt differently on screen and in the transcript. Only the letters survive.
    expect(squash('the tail\nstops on a 4 MB line')).toBe(squash('the tailstops on a 4MB line'));
    expect(squash('Refine — the intro!')).toBe('refinetheintro');
  });
});

describe('matchSession', () => {
  it('names the session whose recent text the pane is showing', () => {
    const pane = prose('alpha', MIN_AGREEING_SNIPPETS + 1);
    const owner = matchSession(pane, [
      { sessionId: 'a', text: `chatter ${pane} chatter` },
      { sessionId: 'b', text: prose('beta', 4) },
    ]);
    expect(owner).toBe('a');
  });

  it('declines when only one snippet agrees', () => {
    // One is the dangerous number. An observer's own transcript quotes the sessions it watches, so
    // a single line of somebody else's screen appearing anywhere in this session's history would
    // otherwise be enough to take the name off the session that owns it.
    const pane = `${'q'.repeat(MATCH_CHARS)}${prose('alpha', 1)}`;
    const owner = matchSession(pane, [
      { sessionId: 'a', text: prose('alpha', 1) },
      { sessionId: 'b', text: prose('beta', 4) },
    ]);
    expect(owner).toBeUndefined();
  });

  it('declines when two sessions hold the same text', () => {
    // A background job inherits its parent's task, and a shared banner is on every screen. Neither
    // is evidence about which tab is on display.
    const pane = prose('shared', 4);
    const owner = matchSession(pane, [
      { sessionId: 'a', text: pane },
      { sessionId: 'b', text: pane },
    ]);
    expect(owner).toBeUndefined();
  });

  it('declines when two different sessions each win a snippet', () => {
    // Contradiction is not a majority. If the pane points at two sessions at once, the read is
    // wrong however many votes either of them has.
    const pane = `${prose('alpha', 2)} ${prose('beta', 2)}`;
    const owner = matchSession(pane, [
      { sessionId: 'a', text: prose('alpha', 2) },
      { sessionId: 'b', text: prose('beta', 2) },
    ]);
    expect(owner).toBeUndefined();
  });

  it('declines on a pane too short to identify anything', () => {
    expect(matchSession('hi', [{ sessionId: 'a', text: prose('alpha', 4) }])).toBeUndefined();
  });

  it('declines when there is nothing to match against', () => {
    expect(matchSession(prose('alpha', 4), [])).toBeUndefined();
  });

  it('ignores the status bar the pane ends with', () => {
    // The bottom of a Claude Code pane is a token count and a shortcut hint, which are in no
    // transcript anywhere. A matcher that only looked at the end of the pane would never identify
    // a single tab — this is the regression that behaviour would be.
    const chrome = ' ? for shortcuts 184.38M tokens $4.12 ';
    const owner = matchSession(`${prose('alpha', 3)}${chrome}`, [
      { sessionId: 'a', text: prose('alpha', 3) },
    ]);
    expect(owner).toBe('a');
  });
});

describe('readActiveTab', () => {
  it('is silent on anything that is not Windows', async () => {
    // The whole mechanism is one platform's accessibility API. Everywhere else it must be inert
    // rather than absent — the caller keeps whatever name it already had, on every OS in CI.
    if (process.platform === 'win32') return;
    await expect(readActiveTab()).resolves.toBeUndefined();
  });
});
