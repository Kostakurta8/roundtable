/**
 * Theme: day office, night office, or whatever the OS says.
 *
 * The choice is written to `data-theme` on the document element, which is the single hook
 * `index.css` hangs its palette off — nothing in the shell branches on the theme in JavaScript, so
 * a new surface only has to name a token to be themed.
 *
 * The room is the exception, and deliberately so: it is a canvas, not a stylesheet, so `App` reads
 * the resolved theme and hands `PixelOffice` a `night` level instead. The same office after hours,
 * lit by its desk lamps rather than by its windows — a repaint, not a recolour.
 */
import { useCallback, useEffect, useState } from 'react';

export type ThemeChoice = 'day' | 'night' | 'auto';
export type Resolved = 'light' | 'dark';

const KEY = 'roundtable.theme';
const ORDER: readonly ThemeChoice[] = ['auto', 'day', 'night'];

const isChoice = (v: unknown): v is ThemeChoice => v === 'day' || v === 'night' || v === 'auto';

function stored(): ThemeChoice {
  try {
    const v = localStorage.getItem(KEY);
    return isChoice(v) ? v : 'auto';
  } catch {
    return 'auto'; // storage disabled (private mode, file://) — not a reason to fail to render
  }
}

const systemDark = (): boolean =>
  typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: dark)').matches;

export const resolve = (choice: ThemeChoice, dark: boolean): Resolved =>
  choice === 'auto' ? (dark ? 'dark' : 'light') : choice === 'night' ? 'dark' : 'light';

export type ThemeApi = {
  choice: ThemeChoice;
  resolved: Resolved;
  set: (choice: ThemeChoice) => void;
  /** Steps auto → day → night → auto, for the toolbar button and the keyboard shortcut. */
  cycle: () => void;
};

export function useTheme(): ThemeApi {
  const [choice, setChoice] = useState<ThemeChoice>(stored);
  const [dark, setDark] = useState(systemDark);

  // Only meaningful while the choice is `auto`, but the listener is cheap and always-on avoids a
  // subscribe/unsubscribe cycle every time the user toggles.
  useEffect(() => {
    if (typeof matchMedia !== 'function') return;
    const mq = matchMedia('(prefers-color-scheme: dark)');
    const onChange = (e: MediaQueryListEvent): void => setDark(e.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  const resolved = resolve(choice, dark);

  useEffect(() => {
    const root = document.documentElement;
    root.dataset.theme = resolved;
    // Tells the browser which scrollbar and form-control palette to draw, so the built-in chrome
    // does not stay light against a night office.
    root.style.colorScheme = resolved;
  }, [resolved]);

  const set = useCallback((next: ThemeChoice): void => {
    setChoice(next);
    try {
      localStorage.setItem(KEY, next);
    } catch {
      // preference simply does not persist; the session still honours it
    }
  }, []);

  const cycle = useCallback((): void => {
    setChoice((prev) => {
      const next = ORDER[(ORDER.indexOf(prev) + 1) % ORDER.length];
      try {
        localStorage.setItem(KEY, next);
      } catch {
        /* not persisted */
      }
      return next;
    });
  }, []);

  return { choice, resolved, set, cycle };
}
