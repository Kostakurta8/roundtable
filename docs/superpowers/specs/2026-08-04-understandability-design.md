# Understandability pass — 2026-08-04

Session goal (owner's words): *"the app MUST BE easier to work with and understand."*
Owner pre-authorized the whole session ("do everything that you want and can"), so the usual
design-approval gate is compressed into the session report. Everything below was observed either
in the source or by clicking through the running app with Playwright before it was designed.

## What was observed

1. Clicking an off-site ghost selects nobody: `PixelOffice.tsx`'s stage `onClick` clears the
   selection unless the click landed inside `.actor, .desk, .fixture, .cam-ctl` — `.ghost` is not
   in that list, so the ghost's own `onPick` fires and the stage immediately un-picks.
2. Hovering a ghost never shows the peek card: the card's box chain is
   `boxOf(hover) ?? deskBoxOf(hover)`; an off-site agent has neither, and `ghostBoxOf` is never
   consulted.
3. Escape does not close the session picker. `useDismiss` only listens for outside pointerdown;
   the shell's Escape chain (palette → seek → selection) does not know the picker exists. Live
   consequence observed: ⌘K opened the palette *over* the open picker, two stacked menus.
4. A `<task-notification>` block (harness machinery on the `user` lane) was latched as the
   session's TASK — rendered on the whiteboard and as the feed title. `SOURCE_MARKERS` in
   `server/normalize.ts` has no entry for it, so it classifies as `human`.
5. The activity strip draws at most the last 220 one-second buckets, but the only visible times
   beside it are `ELAPSED 14h 39m` and `480 turns · 1s buckets` — nothing states the window, so
   the bars read as the whole session.
6. The AGENTS rail in a 67-agent session is a wall of visually identical rows, almost all `done`;
   the one working agent is indistinguishable at a glance.
7. There is no in-app explanation of anything: what a desk, bubble, verdict colour, doorway exit
   or bottom-strip head means; what TOK/EST/≥ mean; what the keys are. Only README explains, and
   the observer's audience is exactly the person who has not read it.
8. `favicon.ico` 404s on every load; the tab has no identity.
9. A page reload silently follows the *newest-touched* session, not the one that was on screen.
   Observed live: reload during a busy sibling session switched the room without being asked.

## Design

Nine independent fixes, smallest honest version of each:

- **G1 ghost click** — add `.ghost` to both `closest(…)` guards (click and double-click).
- **G2 ghost peek** — box chain becomes `boxOf ?? deskBoxOf ?? ghostBoxOf`.
- **E1 escape** — `useDismiss` also closes on Escape, via a *capture-phase* document keydown that
  calls `close()`, `preventDefault()` and `stopPropagation()` so the bubble-phase `useKeys`
  handler never also acts on the same press. Menus close innermost-first.
- **T1 task honesty** — `SOURCE_MARKERS` gains `[/^\s*<task-notification>/, 'reminder']`.
  Unit tests: the block classifies as `reminder`; the store's task latch ignores it.
- **W1 timeline window** — the right caption becomes `N turns · showing last <duration>` (or
  `· whole session` when the strip covers everything). No geometry changes.
- **R1 rail triage** — rail header shows `K working` beside the total when K > 0; rows whose
  phase is `done` get an `.arow.done` class dimmed in CSS (full opacity on hover/selection).
- **H1 help overlay** — new `src/ui/Help.tsx`: a `role="dialog"` overlay opened by a `?` top-bar
  button, the `?` key, and a palette command. Three short sections: what the room means (desks,
  bubbles, verdict colours, leaving, off-site strip), what the numbers mean (TOK, EST, `≥`,
  token bars), the keys. Closes on Escape (ahead of seek-clear in the chain), backdrop click,
  and its own ✕. Static DOM; no engine coupling.
- **F1 favicon** — inline SVG data-URI in `index.html` matching the wordmark (ring + dot).
- **P1 sticky pin** — the followed session id is written to `localStorage`; on boot it is
  restored if that session still exists in the hello roster, else newest-touched as today.

Non-goals: no engine/pixel-module changes, no protocol changes, no new panels, no slug decoding
in the picker (a Claude slug is not reversible — `sf-data` may be a real hyphen), no reordering
of the rail (its order mirrors office seating on purpose).

## Verification

`npm test` (374 + new), `npx tsc --noEmit`, `npm run e2e` (stop the app by port first, restart
after), then a real-click Playwright pass on the running app: ghost click selects, ghost hover
peeks, Escape closes picker then palette then seek, help opens from button/key/palette, timeline
caption states the window, task no longer shows `<task-notification>`, favicon loads, reload
stays on the pinned session.
