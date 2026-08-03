/**
 * The command palette: every action in the app, findable by typing part of its name.
 *
 * The observer has grown enough switches — theme, panel, tabs, sessions, agents — that a row of
 * buttons for all of them would crowd out the room. One list, keyboard-first, is the honest
 * shape for that: the buttons in the top bar are shortcuts to the commands that live here.
 *
 * It is a modal dialog and now says so. It used to be a `role="dialog"` and nothing else: no
 * `aria-modal`, so a screen reader kept offering the whole room behind it; no focus trap, so Tab
 * walked straight out of the overlay into controls the user could not see; and no focus restore,
 * so closing it dropped focus on `<body>` and put a keyboard user back at the top of the document.
 *
 * The list was worse. Arrow keys moved a CSS class while focus stayed in the text field, which
 * means a screen reader user pressing Down heard nothing at all — the selection was a colour and
 * only a colour. The field is a combobox over a listbox now, which is the shape the widget always
 * had: focus never leaves the input, and `aria-activedescendant` names the row the arrows are on.
 */
import { useEffect, useMemo, useRef, useState } from 'react';

export type Command = {
  id: string;
  label: string;
  /** Right-aligned hint: a keyboard shortcut, or the group the command belongs to. */
  hint?: string;
  run: () => void;
};

/**
 * Option ids are positional rather than derived from the command's id: `aria-activedescendant`
 * needs an id that is unique in the document, and a command id is free-form text from a session's
 * own agent labels.
 */
const optionId = (i: number): string => `palette-opt-${i}`;

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function Palette({ commands, onClose }: { commands: Command[]; onClose: () => void }) {
  const [q, setQ] = useState('');
  const [cursor, setCursor] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const dialog = useRef<HTMLDivElement>(null);

  /**
   * Take focus, and give it back to whatever had it.
   *
   * The palette opens from three places — the top bar's ⌘K button, the shortcut, and nothing at
   * all — and only the first of those leaves a sensible element behind. Restoring it is what makes
   * "open the palette, change my mind, carry on" cost nothing; without it the price of pressing
   * Escape was every Tab stop between the top of the page and where you were.
   */
  useEffect(() => {
    const opener = document.activeElement;
    input.current?.focus();
    return () => {
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus();
    };
  }, []);

  const hits = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return commands;
    // Every term must appear somewhere in the row, so "th ni" finds "Theme: night" — cheaper to
    // type than an exact prefix and forgiving of the order they come to mind in.
    const terms = needle.split(/\s+/);
    return commands.filter((c) => {
      const hay = `${c.label} ${c.hint ?? ''}`.toLowerCase();
      return terms.every((t) => hay.includes(t));
    });
  }, [commands, q]);

  // A filter that shortens the list must not leave the cursor pointing past the end of it.
  const active = hits.length === 0 ? 0 : Math.min(cursor, hits.length - 1);

  useEffect(() => {
    const el = listRef.current?.children[active] as HTMLElement | undefined;
    el?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    } else if (e.key === 'Tab') {
      // The trap. The dialog holds exactly one focusable element today, so both directions land
      // back on it — but querying rather than hard-coding that means a close button added here
      // tomorrow is caught by the same three lines instead of quietly reopening the hole.
      e.preventDefault();
      const nodes = Array.from(dialog.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? []);
      if (nodes.length === 0) return;
      const from = nodes.indexOf(document.activeElement as HTMLElement);
      const step = e.shiftKey ? -1 : 1;
      nodes[(Math.max(0, from) + step + nodes.length) % nodes.length].focus();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      setCursor((c) => (hits.length === 0 ? 0 : (Math.min(c, hits.length - 1) + 1) % hits.length));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setCursor((c) => (hits.length === 0 ? 0 : (Math.min(c, hits.length - 1) + hits.length - 1) % hits.length));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const hit = hits[active];
      if (hit) {
        hit.run();
        onClose();
      }
    }
  };

  return (
    <div className="overlay" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        ref={dialog}
        className="palette"
        role="dialog"
        aria-modal="true"
        aria-label="commands"
        onKeyDown={onKeyDown}
      >
        <input
          ref={input}
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setCursor(0);
          }}
          placeholder="type a command…"
          aria-label="command search"
          // The combobox half of the pattern: focus stays here for the widget's whole life, and
          // the list below is described to assistive tech as this field's popup rather than as a
          // second thing on screen that happens to change colour.
          role="combobox"
          aria-expanded={hits.length > 0}
          aria-controls="palette-list"
          aria-activedescendant={hits.length > 0 ? optionId(active) : undefined}
          aria-autocomplete="list"
          autoComplete="off"
          spellCheck={false}
        />
        {/* Named apart from the dialog it sits in, so entering the widget does not announce the
            word "commands" twice before the first row is read. */}
        <ul id="palette-list" ref={listRef} role="listbox" aria-label="matching commands">
          {hits.map((c, i) => (
            <li
              key={c.id}
              id={optionId(i)}
              role="option"
              // The highlight and the announced state are now the same attribute. They used to be
              // a `.on` class and nothing, which is how the two could not disagree only because
              // one of them did not exist.
              aria-selected={i === active}
              onPointerEnter={() => setCursor(i)}
              onClick={() => {
                c.run();
                onClose();
              }}
            >
              {c.label}
              {c.hint && <span className="hint">{c.hint}</span>}
            </li>
          ))}
        </ul>
        {/* Outside the list: every child of a `listbox` has to be an option, and "nothing matches"
            is not something that can be chosen. */}
        {hits.length === 0 && <p className="empty-note">nothing matches “{q}”</p>}
      </div>
    </div>
  );
}
