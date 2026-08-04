/**
 * The help overlay: what the room means, in the room's own words.
 *
 * The office is a metaphor, and a metaphor nobody explains is a puzzle: a first-time viewer sees
 * desks, bubbles and a doorway and has no way to know that leaving is *good* news. README says all
 * of this, but the person standing in front of the observer is exactly the person who has not read
 * it. One static page, reachable from the top bar, the `?` key and the palette, is the cheapest
 * honest fix.
 *
 * Deliberately a plain dictionary — no live state, no numbers of its own. The moment this panel
 * starts reporting anything, it can start being wrong; a glossary cannot.
 *
 * Dialog conventions are the palette's: `aria-modal`, focus taken on open and returned on close,
 * Tab held inside, Escape and the backdrop both close it.
 */
import { useEffect, useRef } from 'react';

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** One glossary row: the thing on screen, then what it means. */
function Row({ term, children }: { term: string; children: React.ReactNode }) {
  return (
    <div className="help-row">
      <dt>{term}</dt>
      <dd>{children}</dd>
    </div>
  );
}

function Key({ k, does }: { k: string; does: string }) {
  return (
    <div className="help-row">
      <dt>
        <kbd>{k}</kbd>
      </dt>
      <dd>{does}</dd>
    </div>
  );
}

export function Help({ onClose }: { onClose: () => void }) {
  const dialog = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const opener = document.activeElement;
    dialog.current?.querySelector<HTMLElement>(FOCUSABLE)?.focus();
    return () => {
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus();
    };
  }, []);

  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation(); // the shell's Escape must not also clear a seek behind the overlay
      onClose();
    } else if (e.key === 'Tab') {
      e.preventDefault();
      const nodes = Array.from(dialog.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? []);
      if (nodes.length === 0) return;
      const from = nodes.indexOf(document.activeElement as HTMLElement);
      const step = e.shiftKey ? -1 : 1;
      nodes[(Math.max(0, from) + step + nodes.length) % nodes.length].focus();
    }
  };

  return (
    // Closed on `click`, not `pointerdown`: an overlay that unmounts on the down-stroke lets the
    // up-stroke's click land on the room underneath, where it reads as a floor click and clears
    // the selection — the same fall-through family the ghost marks had.
    <div className="overlay" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div
        ref={dialog}
        className="help"
        role="dialog"
        aria-modal="true"
        aria-labelledby="help-title"
        onKeyDown={onKeyDown}
      >
        <header className="help-hd">
          <b id="help-title">WHAT AM I LOOKING AT</b>
          <span className="spacer" />
          <button type="button" className="btn icon" aria-label="close help" onClick={onClose}>
            ✕
          </button>
        </header>

        {/* A tab stop of its own: the body scrolls, the shell's `body { overflow: hidden }` means
            nothing else does, and a scroll region only the mouse can reach hides the KEYS section
            from exactly the audience a keys section is for. Being focusable also folds it into the
            dialog's Tab trap via the FOCUSABLE query's `[tabindex]` clause. */}
        <div className="help-body" tabIndex={0} role="region" aria-label="help contents">
          <section aria-label="the room">
            <h3>THE ROOM</h3>
            <dl>
              <Row term="a person at a desk, typing">that agent is running tools right now</Row>
              <Row term="a thought cloud">a real thinking block from the transcript, as it lands</Row>
              <Row term="walking over, speech bubble">the agent is reporting a result to the orchestrator</Row>
              <Row term="a green or red bubble">
                a CONFIRMED or REFUTED verdict — the only saturated colours in the app
              </Row>
              <Row term="leaving through the door">
                finished. Good news, not a bug: the chair frees up, and the agent keeps its row, its
                tokens and everything it said in the AGENTS panel
              </Row>
              <Row term="coming back through the door">
                it was reported done too early and is still working — background agents do that
              </Row>
              <Row term="small heads along the bottom">
                more agents than chairs; they are real — hover, click or tab to them
              </Row>
              <Row term="the whiteboard">the session's task — click it to open the full feed</Row>
              <Row term="the roundtable">click it to see only what agents said to each other</Row>
            </dl>
          </section>

          <section aria-label="the numbers">
            <h3>THE NUMBERS</h3>
            <dl>
              <Row term="TOK">every token the session has billed, cache reads and writes included</Row>
              <Row term="EST">
                a cost estimate from published list prices. A leading ≥ means some model here has no
                rate card, so the true figure is higher
              </Row>
              <Row term="bar beside an agent">its share of tokens, against the session's biggest spender</Row>
              <Row term="a number on a session tab">agents working in that session right now</Row>
              <Row term="ELAPSED">
                the whole session's span — the bars beside it cover only the recent window they say
                they do
              </Row>
            </dl>
          </section>

          <section aria-label="keys">
            <h3>KEYS</h3>
            <dl>
              <Key k="⌘K / Ctrl+K" does="command palette — every action, agent and session by name" />
              <Key k="1 2 3" does="chat / agents / tools panel" />
              <Key k="B" does="show or hide the side panel" />
              <Key k="T" does="day → night → follow the system" />
              <Key k="? " does="this overlay" />
              <Key k="arrows · + −" does="pan and zoom the room; Home re-centres; F follows the selection" />
              <Key k="Esc" does="close the top thing: menu, palette, this, a held seek, the selection" />
              <Key k="Enter on the strip" does="rewind the room to that second; Esc resumes live" />
            </dl>
          </section>
        </div>

        <footer className="help-ft">
          read-only · watches the transcripts Claude Code already writes · nothing leaves this
          machine
        </footer>
      </div>
    </div>
  );
}
