/**
 * The inspector: everything known about one agent, pinned over the room next to it.
 *
 * It opens by clicking a person in the office or a row in the rail, which is what makes the room
 * navigable rather than merely pretty — a face at a desk becomes a name, a model, a bill, and the
 * last thing it said.
 *
 * At phone width it is a sheet instead (`sheet`, from `useSheet`): pinned over a 380×300 room, the
 * card took 220×285 of it — the person you had just tapped was under the card that described them.
 * The sheet rises over the dock below the room, so the room stays whole above it; it goes away the
 * way a sheet does, by swiping it down or tapping anywhere that is not it, and Escape and ✕ still
 * close it for a keyboard. It is not a dialog: nothing behind it is inert, and focus is not taken.
 */
import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { modelInfo } from '../../shared/models';
import { displayPhase, type RtMsg, type RtState } from '../store';
import { clip, clockSec, duration, editLines, money, oneLine, shortPath, tokens } from './format';
import { agentInk, MiniHead } from './MiniHead';

const LAST_TOOLS = 5;
const EXCERPT = 180;

/** The width at which the inspector becomes a sheet — the stylesheet's phone breakpoint. */
const SHEET_QUERY = '(max-width: 560px)';

/**
 * How far down a swipe has to carry the sheet to close it, or how fast (px/ms) a shorter flick has
 * to be going. Less than that and it springs back: a thumb resting on the header is not a dismissal.
 */
const SWIPE_CLOSE_PX = 64;
const SWIPE_CLOSE_SPEED = 0.5;

/** Whether the inspector is a sheet at the current width. Follows the window as it resizes. */
export function useSheet(): boolean {
  const [on, setOn] = useState(() => typeof matchMedia === 'function' && matchMedia(SHEET_QUERY).matches);
  useEffect(() => {
    if (typeof matchMedia !== 'function') return;
    const mq = matchMedia(SHEET_QUERY);
    const sync = (): void => setOn(mq.matches);
    sync();
    mq.addEventListener('change', sync);
    return () => mq.removeEventListener('change', sync);
  }, []);
  return on;
}

export type InspectorProps = {
  state: RtState;
  agentId: string;
  now: number;
  onClose: () => void;
  /** A bottom sheet over the dock rather than a card over the room. */
  sheet?: boolean;
};

export const Inspector = memo(function Inspector({ state, agentId, now, onClose, sheet = false }: InspectorProps) {
  const root = useRef<HTMLElement>(null);
  // Read through a ref: the shell hands over a fresh closure on every render, and the listeners
  // below would otherwise be torn down and re-added every time an event arrived.
  const close = useRef(onClose);
  close.current = onClose;

  /**
   * Where focus was when the inspector opened — the person or roster row that opened it. Closing
   * from inside used to drop focus on `<body>`, which sends a keyboard user back to the top of the
   * page; it goes back to what opened it instead, or to the room if that has gone.
   */
  const opener = useRef<Element | null>(null);
  useEffect(() => {
    opener.current = document.activeElement;
  }, []);

  const dismiss = useCallback((): void => {
    if (root.current?.contains(document.activeElement)) {
      const back = opener.current;
      const to = back instanceof HTMLElement && back.isConnected ? back : document.querySelector<HTMLElement>('.office');
      to?.focus();
    }
    close.current();
  }, []);

  // A tap anywhere that is not the sheet puts it away. Not the room, which answers its own taps —
  // the floor clears the selection, a person changes it, and a drag across it is a pan — and not a
  // roster row, which is a different selection rather than "away".
  useEffect(() => {
    if (!sheet) return;
    const onDown = (e: PointerEvent): void => {
      const t = e.target;
      if (!(t instanceof Element) || root.current?.contains(t)) return;
      if (t.closest('.office, .arow')) return;
      close.current();
    };
    document.addEventListener('pointerdown', onDown);
    return () => document.removeEventListener('pointerdown', onDown);
  }, [sheet]);

  /** The swipe in progress: where it started, when, and how far down it has carried the sheet. */
  const swipe = useRef<{ id: number; y: number; t: number; dy: number } | null>(null);

  const onPointerDown = (e: React.PointerEvent<HTMLElement>): void => {
    if (!sheet || !(e.target instanceof Element)) return;
    // The header is the handle: the body scrolls, and a swipe that started in it would fight that.
    if (!e.target.closest('.sheet-grab, h3, .sub') || e.target.closest('button')) return;
    swipe.current = { id: e.pointerId, y: e.clientY, t: e.timeStamp, dy: 0 };
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      // A pointer that has already ended cannot be captured (and jsdom has no capture at all); the
      // swipe still works off the events in flight, it just stops if the thumb leaves the sheet.
    }
  };
  const onPointerMove = (e: React.PointerEvent<HTMLElement>): void => {
    const s = swipe.current;
    if (!s || s.id !== e.pointerId) return;
    s.dy = Math.max(0, e.clientY - s.y);
    // Under the finger, not eased toward it: this is direct manipulation.
    e.currentTarget.style.transition = 'none';
    e.currentTarget.style.transform = `translateY(${s.dy}px)`;
  };
  const endSwipe = (e: React.PointerEvent<HTMLElement>): void => {
    const s = swipe.current;
    if (!s || s.id !== e.pointerId) return;
    swipe.current = null;
    const speed = s.dy / Math.max(1, e.timeStamp - s.t);
    if (e.type === 'pointerup' && (s.dy >= SWIPE_CLOSE_PX || (s.dy > 12 && speed >= SWIPE_CLOSE_SPEED))) {
      // Left where the finger took it: springing back up for one frame before unmounting reads as
      // the sheet refusing, then giving in.
      close.current();
      return;
    }
    e.currentTarget.style.transition = '';
    e.currentTarget.style.transform = '';
  };

  const a = state.agents[agentId];
  if (!a) return null;

  const model = a.model ? modelInfo(a.model).short : undefined;
  const parent = a.parentId ? state.agents[a.parentId] : undefined;
  const alive = a.lastTs > a.firstTs ? a.lastTs - a.firstTs : 0;
  const recent = state.tools.filter((t) => t.agentId === agentId).slice(-LAST_TOOLS).reverse();
  const last: RtMsg | undefined = [...state.msgs].reverse().find((m) => m.agentId === agentId);
  const shown = displayPhase(a, now);

  return (
    <aside
      ref={root}
      className={sheet ? 'inspector panel sheet' : 'inspector panel'}
      aria-label={`details for ${a.label ?? a.id}`}
      onKeyDown={(e) => {
        // Escape from inside closes it and goes no further: the shell's own Escape would also end a
        // held seek behind it, which is not what closing a panel meant.
        if (e.key !== 'Escape') return;
        e.stopPropagation();
        dismiss();
      }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endSwipe}
      onPointerCancel={endSwipe}
    >
      {/* The handle a sheet is pulled down by. Decoration to a screen reader: ✕ and Escape are the
          same action, and both are reachable. */}
      {sheet && <div className="sheet-grab" aria-hidden="true" />}
      <button type="button" className="btn icon close" onClick={dismiss} aria-label="close">
        ✕
      </button>

      <h3>
        <MiniHead agentId={a.id} /> <span className="agent-ink" style={agentInk(a.id)}>
          {a.label ?? a.id}
        </span>
      </h3>
      <div className="sub">
        {model ?? 'model unknown'}
        {a.agentType ? ` · ${a.agentType}` : ''}
        {a.workflowId ? ` · ${a.workflowId}` : ''}
      </div>

      <dl className="kv">
        <dt>PHASE</dt>
        <dd>
          {shown.phase}
          {shown.status ? ` · ${clip(shown.status, 26)}` : ''}
        </dd>
        <dt>ID</dt>
        <dd title={a.id}>{a.id}</dd>
        {parent && (
          <>
            <dt>PARENT</dt>
            <dd title={parent.id}>{parent.label ?? parent.id}</dd>
          </>
        )}
        <dt>TOKENS</dt>
        <dd>{tokens(a.tokens)}</dd>
        <dt>IN / OUT</dt>
        <dd>
          {tokens(a.use.in)} / {tokens(a.use.out)}
        </dd>
        <dt>CACHE</dt>
        <dd>
          {tokens(a.use.cacheRead)} r · {tokens(a.use.cacheWrite)} w
        </dd>
        <dt>EST</dt>
        <dd>{money(a.cost)}</dd>
        <dt>TURNS</dt>
        <dd>{a.says}</dd>
        <dt>ACTIVE</dt>
        <dd>{alive > 0 ? duration(alive) : '—'}</dd>
        <dt>LAST SEEN</dt>
        <dd>{a.lastTs > 0 ? `${duration(Math.max(0, now - a.lastTs))} ago` : '—'}</dd>
      </dl>

      {recent.length > 0 && (
        <>
          <div className="section-hd">RECENT TOOLS</div>
          {recent.map((t) => {
            const lines = editLines(t.added, t.removed);
            return (
              <div className={t.ok === false ? 'trow failed' : 'trow'} key={t.id}>
                <span className={`phase ${t.ok === undefined ? 'working' : 'idle'}`} aria-hidden="true" />
                <span className="tool">{t.tool}</span>
                <bdi className="target">{t.target ? shortPath(t.target) : ''}</bdi>
                {/* What this agent did to that file, on the row that names it. */}
                {lines && <span className="edits">{lines}</span>}
                <span className="ms">{t.ms === undefined ? clockSec(t.ts) : duration(t.ms)}</span>
              </div>
            );
          })}
        </>
      )}

      {last && (
        <>
          <div className="section-hd">LAST MESSAGE</div>
          <div style={{ color: 'var(--ink-2)', fontSize: 10, lineHeight: 1.6 }}>
            {clip(oneLine(last.text), EXCERPT)}
          </div>
        </>
      )}
    </aside>
  );
});
