# Roundtable — debug it, polish it, and make the UI worth screenshotting

*(Paste §THE PROMPT into a fresh Claude Code session. Everything below it is the briefing that
prompt refers to — the verified state, the traps that already cost time, and the gates.)*

---

## THE PROMPT

In `D:\Relocated\AI Projects\roundtable` (branch `main`, clean, **v0.2.0**, 589 tests green,
`npx tsc --noEmit` clean, `npm run build` clean, CI 8/8 including both e2e legs):

The app works and is honest. It is not yet **good to look at**, and nobody has ever audited it as a
piece of interface rather than as a renderer. Three jobs, in this order:

1. **Debug.** Hunt real defects — wrong states, dead paths, things that break at sizes and in
   conditions nobody has run. Every finding gets reproduced before it gets fixed.
2. **Polish.** The unglamorous pass: empty states, error states, focus order, contrast, alignment,
   what a stranger sees in the first ten seconds.
3. **Refine the UI, drastically.** The shell around the room — top bar, rail, tabs, timeline,
   inspector, chat — is functional and plain. Make it deliberate. The room itself is under a
   contract (`docs/pixel-contract.md`) and is **not** the target; the frame around it is.

Read this whole file before touching anything. Work the phases in order and do not start at §3 —
a defect found in §1 usually changes what §3 should even look like.

**Hard constraints.** Read-only on `~/.claude`, never write there. Never weaken the Origin gate,
the loopback bind, or any claim in `SECURITY.md` — if a change makes a sentence there false, the
sentence gets rewritten in the same commit or the change does not land. **Never put
`Co-Authored-By: Claude` in a commit here** (owner order, 10.08 — it cost a history rewrite).
Do not commit unless I ask. Do not publish anything.

**The gates, every time, before you claim anything is done:** `npm test` · `npx tsc --noEmit` ·
`npm run build` · `npm run smoke` · and for anything visual, a rendered PNG you have actually
looked at. A screenshot you did not open is not evidence.

---

## Where things stand — do not redo this

- **What it is.** A read-only observer for Claude Code. It tails the JSONL transcripts under
  `~/.claude`, normalizes them to typed events, streams them over a loopback WebSocket, and draws
  the session as a 480×270 pixel-art office (nearest-neighbour upscaled) with a chat/agents/tools
  dock beside it and a scrubbable timeline under it.
- **Two ways to run it.**
  - `npm start` — hub (7411) + Vite (5173), the dev path.
  - `npx github:Kostakurta8/roundtable` — the packaged path: **the hub serves the built client from
    `dist/client` over its own port**, no Vite at all. ⚠ This is new (v0.2.0) and is the path most
    users will ever see. Any UI change must be checked in *both*, because only the packaged one
    goes through `dist/`, the injected socket URL, and the hub's static handler.
- **`npm run demo`** writes a synthetic `~/.claude` under the temp dir and points the hub at it —
  the only way to see a busy room without a real session. Clone-only today (see §First run).
- Published to npm as `claude-roundtable`: **not done, blocked on an npm account** (npmjs.com
  signup bot-walls automation). Out of scope for this session.

### The layout you will be working in

```
src/App.tsx                 630 lines — the shell: grid, dock, keyboard, theme wiring
src/index.css              1838 lines — every token and every surface; the room is NOT styled here
src/theme.ts                          — day / night / auto -> `data-theme` on <html>
src/ui/TopBar.tsx  Rail.tsx  Timeline.tsx  Inspector.tsx  Palette.tsx
      AgentsTab.tsx  ToolsTab.tsx  Help.tsx  MiniHead.tsx  format.ts  roster.ts
src/chat/Chat.tsx  MessageCard.tsx
src/office/PixelOffice.tsx  1545 lines — canvas, rAF loop, camera, accessibility layer
src/office/engine.ts        1410 lines — deterministic simulation (walks, seats, bubbles)
src/office/pixel/*                    — the room's renderer, under contract, 7 modules
src/store.ts                 933 lines — event fold, per-session state, 500-message cap
```

Tests that will catch you: `tests/dom.test.ts` (the accessibility layer), `tests/room.test.ts`
(hashes the composed room against `tests/room.baseline.json`), `tests/engine.test.ts` (pinned
coordinates), `tests/pixel.test.ts`, `tests/store.test.ts`, `e2e/live.spec.ts`.

---

## §1 Debug — what to actually hunt

Reproduce first, fix second, and prove the fix with a test that **fails on the pre-fix code**. A
gate that was green before and after is not a gate; check it by reverting your fix and watching it
go red.

Places defects are likely, in rough order of expected yield:

1. **The packaged path.** Everything below has only ever been exercised under Vite:
   `ROUNDTABLE_PORT=9000 npx github:...` (does the injected socket URL hold?), a second copy on a
   busy port, a client asset 404 after an upgrade, the `no-store` shell vs the immutable assets.
2. **Window sizes nobody runs.** The shell is a grid; the room is a fixed-aspect canvas. Try
   1280×720, 1366×768, 1920×1080, and a deliberately mean 1100×620. The rail, the dock and the
   timeline all compete for the same pixels. Look for: clipped controls, a room that stops being
   legible, a timeline that overlaps its own labels, horizontal scroll on `documentElement`.
   ⚠ Test overflow with `documentElement.scrollWidth` and a real `scrollTo` read-back —
   `body.scrollWidth` is not overflow and has produced a false alarm before.
3. **States other than "a busy live session":** no sessions at all · one session with two messages ·
   a finished session (nothing live) · hub down / socket dropped mid-session · a session with 100+
   agents · a transcript that gets rewritten under you (the hub sends `reset`) · a session whose
   backlog was truncated (`backlogTruncated`). Several of these have never been looked at.
4. **The 500-message cap and the tools/agents tabs at volume.** Chat is not virtualized. Find where
   it actually hurts and measure it before proposing react-virtuoso.
5. **Keyboard and focus.** There is a command palette, a theme cycle, camera keys, and a timeline.
   Tab through the whole app once. Anything focusable that shows no focus ring is a defect.
6. **Console.** Zero errors and zero warnings in a normal run is the bar; e2e already asserts a
   subset. A React key warning is a real finding, not noise.

---

## §2 Polish — the pass that decides whether a stranger stays

**First run is now the product's front door** and it has never been designed. Somebody who just ran
`npx github:Kostakurta8/roundtable` with no Claude Code history sees an empty office and no
explanation. Decide and implement what that screen says. Constraints: it must not lie about what
the app is, and it must not need a clone (`npm run demo` is unavailable on the packaged path —
verify this before designing around it; if the demo staging can be shipped in the package, that is
a candidate answer, and so is an honest, well-made empty state that says where transcripts live).

Then the ordinary list, all of it visible in one pass with `git diff` and a screenshot: empty and
error states for every panel · loading vs offline vs idle being visually distinct · number and time
formatting consistency (`src/ui/format.ts`) · truncation with a title attribute rather than a
mystery ellipsis · consistent iconography · contrast in **both** themes (check the night theme
properly, not just once) · hit targets · the `OFFLINE` state actually telling the user what to do.

---

## §3 Refine the UI, drastically

The bar: a screenshot of this app should be the reason somebody clicks the repo. Today it is a grey
shell around a beautiful room, and the mismatch is the problem — the office is crafted, the frame
around it is default.

Rules of engagement:

- **The room is not the target.** `src/office/pixel/*` is under `docs/pixel-contract.md`: modules
  import only `./art` and `./preview`, never React, never the store. Changing the room means
  re-blessing a baseline; do that only if you have a specific defect, not for taste.
- **Everything else is fair game**, but it is a refinement, not a rewrite: the information
  architecture (a room, a dock, a timeline, a rail) is correct and stays. What changes is type
  scale, spacing rhythm, surface hierarchy, colour discipline, motion, and the density of the
  dock — `src/index.css` is 1838 lines and is where most of this lives.
- **Tokens before pixels.** If a value is worth changing it is worth naming; `theme.ts` +
  `data-theme` is the existing hook and nothing should branch on the theme in JavaScript.
- **Day and night are both first-class.** The room repaints for night (it takes a `night` level,
  not CSS); the shell recolours. Both must look intentional.
- If the `impeccable` or `ui-ux-pro-max` skills are available in this session, load one before
  proposing a direction — and still make your own call.

Propose **two or three distinct directions** as rendered screenshots of the real app before
committing to one. Not descriptions — screenshots. Then pick one and say why.

---

## Traps — every one of these has already cost real time

**Verification**

- ⚠⚠⚠ **Local e2e can silently test a different application.** `playwright.config.ts` sets
  `reuseExistingServer: !process.env.CI`, so if anything else is on **5173** Playwright adopts it
  and every assertion fails against a stranger's app. This happened: the failure snapshot showed a
  "Queue / Library / Activity" page from another project. **Read the error-context snapshot before
  believing an e2e failure**, and check what owns 5173 first.
- ⚠⚠ `.actor` is a zero-size point in the DOM. Playwright must wait for `attached`, not `visible`.
- ⚠⚠ The camera is **eased**: a settled reading needs three agreeing samples, and the 2px bound in
  the camera test is the entire meaning of that test — never widen it.
- ⚠ `tests/room.test.ts` hashes exact pixels. Changing seat order or geometry moves the baseline
  legitimately; `npm run room` then **look at the PNGs**, then `npm run room:bless`. Blessing
  without looking turns a regression into the new truth.
- ⚠ `npm run sheet` renders sprite contact sheets; `npm run room` renders the composed room. The
  sheets prove a sprite, only the room proves they belong together.

**Runtime**

- ⚠⚠⚠ Vite's `strictPort` on 5173 is load-bearing: the hub's Origin gate names the dev ports plus
  its own. A moved port with a stale allowlist is a hub no page can reach, and it looks exactly
  like a crashed server — page loads, hub up, `OFFLINE` for ever.
- ⚠⚠⚠ The packaged client learns its port from `window.__ROUNDTABLE_WS__`, injected by the hub into
  the HTML it serves. It is accepted only if it matches a loopback `ws://` URL. Do not "simplify"
  that check.
- ⚠⚠ Answering an HTTP request before draining its body makes Node destroy the socket — the reply
  arrives as `ECONNRESET`. Visible on **Node 22 only**; four of six CI legs were green with that
  bug in. `req.resume()` is not the fix; the answer must wait for `end`.
- ⚠⚠ In tests, `fetch` reuses pooled connections across servers on the same port — use `node:http`
  with `agent: false`, as `tests/hub.test.ts` now does.
- ⚠ `workflowPhase` is written at run **termination**. Never draw it as live progress.
- ⚠ `findLast` is not in this project's `lib`.
- ⚠ `juice.ts` pulse timeline: nothing before ~0.25, arrival bloom at 0.85, gone by 0.95 — a
  movement test sampling 0.15 fails for the wrong reason.

**Process**

- ⚠⚠⚠ Background subagents here have stalled at a **600 s watchdog**, repeatedly, and the ones that
  stalled during a *reading* phase wrote nothing at all. If you delegate: one job each, a hard
  budget (≤20 files, ≤300 lines/file, no whole-corpus sweep), and tell them to **write the complete
  file first, then refine**. That is the only pattern that ever left work behind.
- ⚠⚠ Bash heredocs on this machine break on apostrophes — use the Write tool for file content.
- ⚠ `npm start` and `npm run e2e` cannot both be running; stop dev **by port**, children outlive the
  wrapper.

---

## Definition of done

1. `npm test` · `npx tsc --noEmit` · `npm run build` · `npm run smoke` all green, and **CI 8/8** if
   anything was pushed.
2. Every defect found in §1 is either fixed with a test that fails on the pre-fix code, or written
   down in the report with a reproduction and a reason it was left.
3. A before/after screenshot set at 1280×720 and 1920×1080, in **both** themes, of: the busy room,
   an idle room, the first-run screen, and one error state. Save them under `qa/ui/` and reference
   them in the report.
4. `SECURITY.md` and `README.md` still describe the app that now exists.
5. A short report: what was broken, what changed, what you chose not to do and why, and the one
   thing you would do next.

**Stop conditions.** If the work turns into a rewrite of the room, stop and ask. If a change would
make a `SECURITY.md` claim false and you cannot honestly rewrite the claim, stop and ask. If a fix
requires weakening a test's bound rather than satisfying it, stop and ask.
