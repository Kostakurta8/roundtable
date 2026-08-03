/** Small hooks the shell shares. Nothing here knows what a session or an agent is. */
import { useEffect, useRef, useState } from 'react';

/**
 * A clock that ticks, for relative times.
 *
 * "4m ago" that was rendered once and never again is worse than no timestamp: it is a wrong one,
 * and it gets wronger the longer the window stays open. One shared interval per component tree,
 * at whatever coarseness the caller actually displays.
 */
export function useNow(everyMs = 5000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), everyMs);
    return () => clearInterval(id);
  }, [everyMs]);
  return now;
}

export type KeyHandler = (e: KeyboardEvent) => void;

/**
 * Document-level shortcuts, minus the ones that would fight a text field.
 *
 * Typing "t" into the feed's search box must not toggle the theme, so anything originating in an
 * input, a textarea or a contenteditable is ignored unless the binding carries a modifier — which
 * is what makes ⌘K work from inside the search box while `t` does not.
 */
export function useKeys(bindings: Record<string, KeyHandler>): void {
  const ref = useRef(bindings);
  ref.current = bindings;

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const target = e.target as HTMLElement | null;
      const typing =
        !!target &&
        (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable);
      const mod = e.ctrlKey || e.metaKey;
      if (typing && !mod && e.key !== 'Escape') return;

      const key = `${mod ? 'mod+' : ''}${e.key.length === 1 ? e.key.toLowerCase() : e.key}`;
      const handler = ref.current[key];
      if (!handler) return;
      e.preventDefault();
      handler(e);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);
}

/** Closes a popover when a pointer goes down anywhere outside it. */
export function useDismiss(open: boolean, close: () => void): React.RefObject<HTMLDivElement> {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent): void => {
      if (!ref.current?.contains(e.target as Node)) close();
    };
    // `pointerdown` rather than `click`, so the menu is gone before the click lands on whatever
    // was underneath it — otherwise dismissing feels like it takes two presses.
    document.addEventListener('pointerdown', onDown);
    return () => document.removeEventListener('pointerdown', onDown);
  }, [open, close]);
  return ref;
}

/**
 * Sticky-bottom scrolling for a live log.
 *
 * Keyed on a caller-supplied signal rather than on list length: once a feed hits its cap the
 * length stops changing, and a hook that watched it would silently stop following the live edge
 * for the rest of the session — precisely when the session is busiest.
 */
export function useStickToBottom<T extends HTMLElement>(
  signal: unknown,
  slack = 48,
): { ref: React.RefObject<T>; onScroll: () => void } {
  const ref = useRef<T>(null);
  const pinned = useRef(true);

  useEffect(() => {
    const el = ref.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  }, [signal]);

  const onScroll = (): void => {
    const el = ref.current;
    if (el) pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < slack;
  };

  return { ref, onScroll };
}
