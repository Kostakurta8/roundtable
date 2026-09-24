/**
 * The strip above the hosted demo that says what it is, and how to get the real thing.
 *
 * Two jobs, in this order. The first is honesty: the room below is a replay of a staged session,
 * and a stranger arriving from a link has no way to know that unless the page says so — the app's
 * own words ("running", the status pill) are true of a hub and false of a recording. The second is
 * the reason the demo exists at all: the one command that runs it on your own sessions, one click
 * from the clipboard.
 *
 * It shrinks rather than closes. On a phone the status pill in the top bar is squeezed out of
 * sight, so a strip that could be dismissed entirely would take the only "this is a replay" on the
 * screen with it. Shrunk, it is one slim row: the label, the copy button, the star.
 *
 * Only ever rendered by `./main.tsx`, the pages entry. The local app never imports this directory,
 * so it never draws a link that leaves the machine.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { demoPace } from './source';

export const INSTALL = 'npx https://github.com/Kostakurta8/roundtable/releases/latest/download/roundtable.tgz';
export const REPO = 'https://github.com/Kostakurta8/roundtable';

/** Per tab rather than for ever: a returning visitor is owed the sentence again. */
const COMPACT_KEY = 'rt.demo.compact';
const COPIED_MS = 1600;

const wasCompact = (): boolean => {
  try {
    return sessionStorage.getItem(COMPACT_KEY) === '1';
  } catch {
    return false; // storage denied — the whole strip, which is the honest default
  }
};

type Copy = 'idle' | 'copied' | 'select';

export function DemoBanner() {
  const [pace] = useState(demoPace);
  const [compact, setCompact] = useState(wasCompact);
  const [copy, setCopy] = useState<Copy>('idle');
  const cmdRef = useRef<HTMLElement>(null);

  useEffect(() => {
    if (copy === 'idle') return;
    const t = setTimeout(() => setCopy('idle'), COPIED_MS);
    return () => clearTimeout(t);
  }, [copy]);

  // After the render that put the command on screen, not before: a shrunk strip has no command
  // to select until it has grown back.
  useLayoutEffect(() => {
    const el = cmdRef.current;
    const sel = typeof window.getSelection === 'function' ? window.getSelection() : null;
    if (copy !== 'select' || !el || !sel) return;
    const range = document.createRange();
    range.selectNodeContents(el);
    sel.removeAllRanges();
    sel.addRange(range);
  }, [copy, compact]);

  /**
   * The clipboard API is refused outside a secure context and by some embedded browsers — the
   * in-app browsers X and Slack open links in among them, which is exactly where this page gets
   * opened. Selecting the text is the fallback that always works: the person is one Ctrl+C or one
   * long-press away instead of looking at a button that did nothing.
   */
  const onCopy = useCallback(() => {
    const selectIt = (): void => {
      setCompact(false);
      setCopy('select');
    };
    if (!navigator.clipboard?.writeText) {
      selectIt();
      return;
    }
    navigator.clipboard.writeText(INSTALL).then(() => setCopy('copied'), selectIt);
  }, []);

  const toggle = useCallback(() => {
    setCompact((was) => {
      try {
        sessionStorage.setItem(COMPACT_KEY, was ? '0' : '1');
      } catch {
        // not remembered past this page — the strip simply comes back whole on a reload
      }
      return !was;
    });
  }, []);

  const copyLabel =
    copy === 'copied' ? (
      'Copied ✓'
    ) : copy === 'select' ? (
      'Selected'
    ) : compact ? (
      <>
        Copy install<span className="demo-long"> command</span>
      </>
    ) : (
      'Copy'
    );

  return (
    <aside className={compact ? 'demo-bar compact' : 'demo-bar'} aria-label="about this demo">
      <p className="demo-what">
        <span className="demo-tag" title={pace.title}>
          STAGED REPLAY · {pace.label}
        </span>
        {!compact && (
          <>
            <span className="demo-long">Nothing here is anyone&rsquo;s real session. Run it on yours:</span>
            <span className="demo-short">Not anyone&rsquo;s real session.</span>
          </>
        )}
      </p>
      {compact ? (
        <button type="button" className="demo-btn demo-copy" onClick={onCopy} title={INSTALL} aria-label="copy the install command">
          {copyLabel}
        </button>
      ) : (
        <div className="demo-install">
          <code ref={cmdRef} className="demo-cmd" title={INSTALL}>
            {INSTALL}
          </code>
          <button type="button" className="demo-btn demo-copy" onClick={onCopy} aria-label="copy the install command">
            {copyLabel}
          </button>
        </div>
      )}
      {/* Said once, out loud, because a button whose label changes is silent to a screen reader. */}
      <span className="sr-only" role="status">
        {copy === 'copied' ? 'install command copied' : copy === 'select' ? 'install command selected' : ''}
      </span>
      <a className="demo-btn demo-star" href={REPO} target="_blank" rel="noopener noreferrer">
        <span aria-hidden="true">★</span> Star<span className="demo-long"> on GitHub</span>
      </a>
      <button
        type="button"
        className="demo-btn demo-toggle"
        onClick={toggle}
        aria-expanded={!compact}
        aria-label={compact ? 'show the whole banner' : 'shrink this banner'}
        title={compact ? 'show the install command' : 'shrink'}
      >
        {compact ? '▾' : '×'}
      </button>
    </aside>
  );
}
