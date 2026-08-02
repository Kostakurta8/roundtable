/**
 * The observer shell: a session picker, the room (still a placeholder — the office view fills
 * it), and the group chat of whichever session is being followed.
 */
import { useEffect, useRef, useState } from 'react';
import { Chat } from './chat/Chat';
import { USER } from './store';
import { useRtStream } from './ws';

const SHORT_ID = 8;
const TITLE_MAX = 96;

const shortId = (id: string): string => id.slice(0, SHORT_ID);

const tokens = (n: number): string => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

const ago = (mtime: number): string => {
  const s = Math.max(0, Math.round((Date.now() - mtime) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
};

const clip = (s: string, max: number): string =>
  s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s;

export default function App() {
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);
  const menu = useRef<HTMLDivElement>(null);
  const { state, sessions, truncatedDropped, connected } = useRtStream(sessionId);

  // Follow the most recently touched session as soon as the roster lands: the observer exists
  // to show what is happening now, and the hub sorts its roster newest first. A session the
  // user picked themselves is never overridden.
  useEffect(() => {
    if (sessionId === null && sessions.length > 0) setSessionId(sessions[0].sessionId);
  }, [sessionId, sessions]);

  // A dropdown that cannot be dismissed by clicking away reads as a stuck UI.
  useEffect(() => {
    if (!picking) return;
    const onDown = (e: PointerEvent): void => {
      if (!menu.current?.contains(e.target as Node)) setPicking(false);
    };
    document.addEventListener('pointerdown', onDown);
    return () => document.removeEventListener('pointerdown', onDown);
  }, [picking]);

  const current = sessions.find((s) => s.sessionId === sessionId);
  const firstPrompt = state.msgs.find((m) => m.agentId === USER)?.text;
  const title = firstPrompt
    ? `TASK · ${clip(firstPrompt.replace(/\s+/g, ' ').trim(), TITLE_MAX)}`
    : (current?.slug ?? 'no session followed');

  return (
    <>
      <div className="office">
        <div className="office-note">
          THE ROOM
          <span>the office view seats these agents here</span>
        </div>
      </div>

      <div className="hud hud-top glass">
        <span className="wordmark">
          <svg width="13" height="13" viewBox="0 0 14 14" aria-hidden="true">
            <circle cx="7" cy="7" r="5.6" fill="none" stroke="#3E9AA8" strokeWidth="1.6" />
            <circle cx="7" cy="7" r="2" fill="#3E9AA8" />
          </svg>
          ROUNDTABLE
        </span>

        <div className="session-menu" ref={menu}>
          <button
            type="button"
            className="session-pick"
            aria-expanded={picking}
            onClick={() => setPicking((p) => !p)}
          >
            {current ? (
              <>
                <span className="slug">{current.slug}</span> / <b>{shortId(current.sessionId)}</b>
              </>
            ) : (
              <span className="slug">{sessions.length > 0 ? 'pick a session' : 'no sessions'}</span>
            )}
            ▾
          </button>

          {picking && (
            <ul className="session-list glass">
              {sessions.map((s) => (
                <li key={s.sessionId}>
                  <button
                    type="button"
                    className={s.sessionId === sessionId ? 'on' : undefined}
                    onClick={() => {
                      setSessionId(s.sessionId);
                      setPicking(false);
                    }}
                  >
                    <b>{shortId(s.sessionId)}</b>
                    <span className="slug">{s.slug}</span>
                    <time dateTime={new Date(s.mtime).toISOString()}>{ago(s.mtime)}</time>
                  </button>
                </li>
              ))}
              {sessions.length === 0 && <li className="empty">no sessions on this machine yet</li>}
            </ul>
          )}
        </div>

        <span className={connected ? 'pill pill-live' : 'pill pill-off'}>
          {connected && <span className="live-dot" />}
          {connected ? 'LIVE' : 'OFFLINE'}
        </span>
        <span className="cost">Σ {tokens(state.totalTok)} tok</span>
        <span className="roster">{Object.keys(state.agents).length} AGENTS</span>
      </div>

      <Chat state={state} title={title} live={connected} truncatedDropped={truncatedDropped} />
    </>
  );
}
