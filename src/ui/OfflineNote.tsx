/**
 * The one sentence the app owes a person when the socket is down and a session is on screen.
 *
 * The pill in the top bar already said OFFLINE, and that was the whole of it: the feed kept
 * showing the last cards it had, the room kept its people, and nothing anywhere said what had
 * happened or what to do. The no-session panel had the explanation; a followed session had a
 * pill. This is the same explanation, for the case that actually occurs — the terminal running
 * the hub was closed, or the machine slept — placed where the eye already is.
 */
import { memo } from 'react';

export const OfflineNote = memo(function OfflineNote({ url }: { url: string }) {
  return (
    <div className="offline-note" role="status">
      <b>Not connected to the observer hub</b>
      <span>
        Retrying <code>{url}</code>. The hub is the terminal that ran <code>npx github:Kostakurta8/roundtable</code>{' '}
        or <code>npm start</code> — if it was closed, start it again. This page reconnects on its own, and what is
        shown here is the session as it stood when the connection dropped.
      </span>
    </div>
  );
});
