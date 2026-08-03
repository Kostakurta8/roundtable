# Roundtable — make it true, then make it plural (paste into a fresh Claude Code session)

---

## THE PROMPT

In `<repo>` (branch `feat/observer-mvp`, **nothing committed**, 223 tests
green, `npx tsc --noEmit` clean): the pixel office is built, alive and legible. The last session
widened the event seam, gave the room hot-desking, postures, a break corner, a replay engine and a
visual-regression baseline — and then audited the whole app against real data and found that some
of what it shows is **wrong**.

This session has three jobs, in this order:

1. **Make the numbers true.** The headline figures are roughly half the truth.
2. **Make the proof run.** The e2e suite has never executed against the current renderer.
3. **Make it plural.** One new feature: when more than one session has agents working, the user
   gets a tab per session and can look at the agents in each.

Then work the backlog in §"Ranked backlog" as far as it goes.

Read this file in full before touching anything. Everything in §"Verified facts" was measured this
session — do not re-derive it, and do not assume it is still true without the cheap check named
beside it.

Hard constraints: **`~/.claude` is read-only — never write there** (the memory directory is the one
exception, and only when I ask). Keep `npm run dev` running until I say stop. Do not commit unless I
ask. Use as many subagents as the work needs, but read §"Traps" first.

---

## Verified facts — measured, not guessed

| Fact | Evidence | Cheap re-check |
|---|---|---|
| **Token + cost figures are ~50% low.** `server/normalize.ts` keeps the *first* line's `usage` for a response id. A streamed response's first line carries `output_tokens: 1`; the last carries the total. | Scanned all 2,548 transcripts under `~/.claude/projects/C--Users-dev`: 26,094 of 62,943 responses diverge. First-wins 39.7M vs last-wins 80.3M output tokens. Worst file: 15,682 shown vs 180,134 real. | Group `message.usage` by `message.id`; compare `[0]` to `[len-1]`. |
| `last` is always `max` | Same scan, whole corpus. | — |
| Divergence is concentrated in **subagent** transcripts | A 25-file sample of recent main-session files showed 0% — do not sample narrowly and conclude it is fixed. | — |
| **`agentDone` fires while the agent is still working.** The hub derives it from the parent's `tool_result`, which returns immediately for `run_in_background` spawns. | 246 spawns where `agentDone` precedes the child's last written line, by up to 995 s. | Compare `agentDone` ts to the child transcript's last mtime/line. |
| **e2e has two independent blockers.** Port 7411 (dev holds it) *and* `e2e/live.spec.ts:94` asserts `.hud-top .pill-live`, a class deleted in the pixel rewrite. | `.hud-top` exists only in `docs/mockup/`. `e2e/artifacts/test-results/.last-run.json` says `failed` — on EADDRINUSE, so nobody has ever seen the selector fail. | `grep -r hud-top src/` |
| The **4000-event backlog cap is not a practical limit** | Largest real session (192 MB across 16 files) produces 2,246 events. | — |
| The Origin gate and `strictPort` are sound | Audited. | — |
| Main transcripts contain **zero** `isSidechain: true` lines | 136,705 lines scanned. | — |
| Absent `is_error` correctly means success | 4,208 real cases. | — |
| Rate cards match every model id present **except `<synthetic>`** | `shared/models.ts` vs corpus. `<synthetic>` carries usage and has no card. | — |
| Fixtures are **7 hand-written synthetic lines** | `fixtures/NOTES.md` says SYNTHETIC. No real transcript, no workflow fixture. | `wc -l fixtures/*.jsonl` |
| Tailwind is installed, configured and injected — **and unused** | Zero utility classes anywhere in `src/`. | grep for `flex|grid|p-[0-9]|text-sm` in `className` |

---

## Job 1 — make the numbers true

**1a. Last-wins usage.** `server/normalize.ts` — emit the usage from the *last* line carrying a
given `message.id`, not the first. The comment above it currently claims every line "carries an
identical copy… the object is the same on all of them anyway". That is false; delete the claim
along with the behaviour. Because the store *accumulates* usage deltas, you cannot simply emit
twice — either buffer until the id changes, or emit a correction the store folds by replacing
rather than adding. Whichever you pick, write the test with a real two-line response shape.

**1b. `<synthetic>` has no rate card.** If it lands first, `modelSeen` latches it, the agent is
priced at nothing, and the whole HUD flips to `≥` floor mode. Decide: give it a zero-cost card that
is *explicitly* zero, or exclude it from `modelSeen`. Say which and why.

**1c. `modelSeen` latches the first model forever.** 7% of real transcripts carry more than one
model (a `/model` switch or an overload fallback). Price per-line, or at least re-latch when the
model changes and say so in the UI.

**1d. Compaction summaries are rendered as the human's own words** and can become the whiteboard
task. `server/normalize.ts` has no `isCompactSummary`. A compaction line emits `userMessage` with
`source: 'human'` and ~14,500 chars beginning "This session is being continued from a previous
conversation that ran out of context." `src/store.ts` latches the first human-sourced turn as
`state.task`. Detect it and give it its own `UserSource`.

**1e. A truncated or rewritten transcript duplicates the whole session.** `server/tail.ts` rewinds
to offset 0 and the hub drops that file's Normalizer, but every line is re-published with **fresh
`seq`**, so `src/store.ts`'s idempotence guard cannot reject it: every message twice, every token
twice, cost doubled. The client needs to be told to reset — there is a `reset` path in `src/ws.ts`
already, it just is not triggered by this.

**1f. Lines over 1 MiB are dropped and their tool calls hang forever.** 126 lines ≥ 1 MiB across 17
of 200 transcripts; on one file all 4 skipped lines were `tool_result`, so 4 chips spin forever and
`activeTools` never returns to 0. `TailStats.skipped` counts this and `Tailer.snapshot()` has **zero
callers** — the loss is invisible. Surface it, and consider resolving orphaned calls on a timeout.

**1g. `MAX_DRAIN_PASSES` gives up silently.** A 67.4 MB transcript read only 45.2 MB in 64 passes,
leaving 22.2 MB unread; a *historical* session never retries because `armRescan` only re-pumps
subagent files. Either keep draining or say plainly that the tail is incomplete.

---

## Job 2 — make the proof run

**2a.** Fix `e2e/live.spec.ts:94` (`.hud-top .pill-live` → the real `TopBar` markup) and whatever
else the renderer rewrite invalidated. Read the whole spec first; its resize assertion is now close
to a tautology (it compares the canvas width to the stage width, which CSS guarantees) and it never
clicks anything.

**2b.** Run it. `npm run e2e` binds its own hub on 7411 and `npm run dev` holds it — **stop dev by
port, not by killing the npm wrapper** (the children outlive it), run e2e, then bring dev back.
Ask me before you stop the dev server.

**2c.** Extend it to cover what this codebase actually asserts about itself: that
`document.elementFromPoint` at an actor's centre returns that actor's own `.actor` element; that
the off-site strip's `.ghost` marks are focusable and labelled; that `.rt-crier` announces settled
speech once; that the camera controls work from the keyboard; that scrubbing the timeline and
pressing "resume live" round-trips.

---

## Job 3 — the new feature: multi-session tabs

**What the user asked for, verbatim:** *"properly analyze if there are more than 1 session that has
agents working, if it has, a tab appears with the name of the session, so the user could look at
all of the different agents in the different sessions."*

**Today** the client follows exactly one session: `useRtStream(sessionId, sink)` opens a socket, sends
one `follow`, and a session switch **drops the socket and resets all state** (`src/ws.ts`). The
design spec froze this deliberately ("One session rendered at a time (v1)", §3.3). You are lifting
that restriction.

**Design notes — decide these explicitly and write down why:**

- **"Has agents working" needs a real definition.** The hub's roster `live` flag is only
  "registered *and* touched < 90 s" — that says the *session* is alive, not that agents are working.
  A session with one idle main agent must not raise a tab. Propose a definition (e.g. ≥1 agent other
  than `main` seen, with an unresolved tool call or activity inside a window) and defend it.
- **The hub must summarise sessions it is not following.** Today it only tails the followed session.
  Either (a) it computes a cheap per-session summary (agent count, active tools, last activity) for
  live sessions without a full follow, or (b) the protocol grows a multi-follow. `Ev.ref` already
  carries `sessionId`, and `shared/protocol.ts` already has an unused `UnfollowCmd`. Option (a) is
  much cheaper and is probably right for the tab *strip*; option (b) is needed for the tab *contents*.
- **One `RtState` per followed session.** `src/store.ts` is single-session. Key it, or hold a map of
  stores. Do not merge two sessions into one `RtState` — the roster, totals and task would all lie.
- **One office per session.** `Engine`, `Recorder` and `Scene` are all single-room. A tab switch
  should not reset the room it switches away from; keep the engine warm and ticking (it is cheap)
  and only *paint* the visible one. Watch the frame loop: `PixelOffice` currently assumes one `Sim`.
- **`sessionSeen` is declared, handled in the store and in `mapping.ts`, tested — and emitted by
  nothing.** This feature is its chance to finally earn its place, or to be deleted.
- **Bound it.** 174 historical sessions exist in this slug alone. Tabs are for sessions with agents
  working *now*, not a session browser — the existing picker in `TopBar` is the browser.

**Acceptance:** with two real Claude Code sessions running agents at once, a tab strip appears
naming both; clicking a tab shows that session's room, roster, feed and totals; switching back does
not reset either; with one session (or none) working, no tab strip appears at all. Verify with two
genuinely concurrent sessions, not fixtures.

---

## Ranked backlog — after the three jobs

### P1 — the app is misleading or broken

1. **`agentDone` fires early and `retire()` is permanent.** `src/office/engine.ts` gives up the desk
   and seat with no un-retire path, while the agent keeps working for minutes. Either gate
   `agentDone` on the child's transcript going quiet, or make retirement reversible.
2. **Pressing `B` strands the room in the past.** `⏵ resume live` lives in `.dock-foot`, and
   `.app.dock-hidden .dock { display: none }`. Also hidden at `max-height ≤ 620px`. Move the control
   somewhere that cannot be hidden, add a palette command, and let `Escape` clear a seek.
3. **`verdictOf` has forked.** `src/store.ts` uses `\bREFUTED\b`; `src/office/mapping.ts` still uses
   `.includes()` — while its comment insists the two match "exactly". "UNREFUTED" makes the office
   walk a red confront the chat card does not show. Share one implementation; test the boundary.
4. **Both clickable fixtures are aimed wrong.** `PixelOffice.tsx` `BOARD_BOX` treats `y:35` as a
   centre; `drawWhiteboard` takes a *base*, so the board occupies y 6..35 — the TASK text is
   unclickable and 15 rows of bare wall are. `TABLE_BOX` has the same class of error. Give the scene
   a `boxOf`-style accessor for fixtures so nothing has to guess.
5. **`RAIL_INSET` is a hard-coded 264 that two media queries invalidate.** `--rail-w` drops to 210 at
   ≤1180px, and `.rail` is `display: none` at ≤900px while `App.tsx` still passes 264 — the room is
   squeezed by a rail that is not rendered.
6. **The top bar clips its own controls below ~900px.** Every child is `flex: none`, no media query
   touches `.topbar`, and `body { overflow: hidden }` means the overflow is clipped, not scrollable:
   ⌘K, the theme button and the dock toggle become mouse-unreachable.
7. **Seeking re-yanks the feed on every incoming message.** `Chat.tsx`'s scroll effect lists `shown`
   in its deps and `shown` is a fresh array per event batch, so `scrollIntoView` re-fires several
   times a second while a seek is held.

### P2 — real capability gaps

8. **The timeline is mouse-only and invisible to assistive tech.** `role="img"` on the plot makes
   every bar presentational; the bars are bare `div`s with `onClick`, no `tabIndex`, no key handler.
   It is the app's only time-travel affordance.
9. **Replay is an engine with no scrubber.** `Replay.advance`, `Replay.position`, `frameAt`,
   `Recorder.truncated`, `Recorder.span`, `Recorder.clear` have zero non-test callers. Build the
   scrubber the spec promised (P5): drag, play/pause, a position marker, and render `truncated` so
   the user is told where history begins.
10. **A failing tool call can never be explained.** `toolResult` carries `ok: boolean` and nothing
    else; `RtTool` has no error field. The UI counts failures and colours them red, and that is the
    end of the trail. `ToolsTab` also has no search and no outcome filter, and its rows are inert.
11. **Workflow journals are never read.** The spec names `journal.jsonl` and P3 promised "journal
    ingestion, phases → huddles". `workflowId` is threaded end to end; `WorkflowPhase` does not exist
    anywhere. The huddle currently triggers on message exchange, not on a phase barrier.
12. **`fileEdit` has no diff.** Spec §3.1 is `FileEdit{agentId, path, diffSummary}`; `old_string` and
    `new_string` are read nowhere and `~/.claude/file-history/` is never opened. Nothing ever shows
    what changed.
13. **~25% of tool calls carry no `target`** — every MCP tool, every `Agent` spawn, `TaskCreate`,
    `ToolSearch`, `WebSearch`, `Skill`. `Agent` calls carry `description` and `subagent_type`; MCP
    tools carry `query`/`prompt`. Sample those too.
14. **The sidecar's `parentAgentId` is ignored** — 6 real depth-2 sidecars carry it and it is the
    authoritative parent link. The tree is instead rebuilt from `state.spawns[toolUseId]`, which
    yields no parent if the spawn was trimmed.
15. **Turn counts silently cap and then lie.** `MSG_CAP` pins `msgs.length` at 1000; the timeline and
    the CHAT badge both render it as the turn count. `state.trimmed` is tracked but never added back.
16. **The activity strip is a ~4-minute window labelled with a whole-session elapsed time**, with no
    axis labels and no statement of the window outside an `aria-label` on a `role="img"`.
17. **Zero sessions produces three contradictory statements at once** — pill says LIVE, header says
    "no session followed", body says "waiting for the session to say something".
18. **Reduced motion has never executed.** `SceneInput.still` is set by nothing in any test or
    script, and `PixelOffice` swaps the whole rAF loop for `setInterval` — a second frame-loop
    implementation with no coverage anywhere.
19. **`pending.open` is unbounded** and `resolveTool` is O(msgs) per result.
20. **Switching tabs destroys the feed's local state** — search text, lane filters, render window.
21. **The command palette is not a real dialog** — no `aria-modal`, no focus trap, no focus restore,
    and arrow keys move a visual class while focus stays in the input with no `aria-activedescendant`.

### P3 — dead weight, drift, polish

22. **`PixelOffice.tsx` is 1,428 lines with zero unit tests**, and `vitest.config.mts` is
    `environment: 'node'` with no jsdom installed, so no DOM test is currently *possible*. Six pure
    units need no DOM and are simply not exported: `blitOf`, `toBuffer`, `clampCam`, `subtreeOf`,
    `actLine`, `noteLine`. `toBuffer` is never asserted to invert `blitOf`, though the file header
    claims "there is no second copy of that arithmetic to drift".
23. **The visual-regression test is blind to the real palette.** `scripts/roomCast.ts` duplicates all
    32 hex values of `store.ts`'s `LOOKS` and indexes them by array position rather than by
    `agentLook`'s hash — so editing the real table cannot move the baseline.
24. **Things asserted only by a hash**: that the six `ToolAct` pictures draw differently from each
    other; that the nine break-corner poses are not nine identical standing sprites; the verdict
    bubble tint; the whiteboard spend bar. `tests/pixel.test.ts`'s glyph-collision test shows the
    cheap fix — assert N buffers are pairwise distinct.
25. **Dead**: `POD_ROW_PITCH_Y`, `ActorState.heard` (written, expired, emitted, read by no renderer),
    `Cmd.prompt.from`, `art.ts` `artHeight`, `furniture.ts` `drawStool` (the scene declines it —
    `characters.ts` has the real one), `effects.ts` `sparkle` and `breathe`, `props.ts`
    `drawHangingPlant` and `drawCable`, `sessionSeen`, `childAgentId` (always `'pending'`),
    `MAX_LINE_BYTES`, `parse.ts`'s `isSidechain`, Tailwind entirely, `.sr-only`, `.time-hidden`,
    `.msg-body code`.
26. **`effects.ts` `LAMPS` is a stale copy of the old floor plan** — it warms x 79 and 146 (now the
    break corner and empty floor) and has no entry over the right-hand bank. It renders every night
    frame. Its comment claims it cannot import another pixel module; it already imports `./art`.
27. **Duplication that will drift**: FNV-1a three times (`store.ts`, `engine.ts`, `scene.ts`) so an
    agent's appearance seed and its pace seed can decouple; window centres `[72,149,278]` in three
    files; `WALL_H` hardcoded in `effects.ts`; `clamp01` four times; the three-shot `SHOTS` table in
    `tests/room.test.ts`, `scripts/bless.ts` and `scripts/room.ts`; `characters.ts` hardcodes
    `WALK_PX_PER_S = 45` while `scene.ts` derives it from `SPEED_PX_PER_S * S`.
28. **Stale comments**: `hooks.ts` "one shared interval" (there are two); `App.tsx`'s `memo(Chat)`
    rationale; `shared/events.ts` `EV_KINDS` "used by the client's filter UI" (no such UI);
    `engine.ts` has an orphaned doc block for a step kind that no longer exists; `PixelOffice.tsx`'s
    DeskMark doc is stranded above `GhostMark`; `scene.ts` claims the rug cannot drift from the
    routing (only the centre is derived; the size differs by ~38px).
29. **Fixtures are synthetic and tiny.** Real transcripts contain secrets and must never be
    committed — but nothing validates the parser against real data. A gitignored local corpus test
    would close this without a privacy risk.
30. **`SPEND_FULL_USD = 25`** in `PixelOffice.tsx` is an arbitrary display reference for the
    whiteboard bar. Decide whether it should be configurable or derived.
31. **Not built from ALIVE §10**: the static layer cache (needs a second canvas and `drawImage`,
    which the preview harness's three-call context cannot express — it has to live in `PixelOffice`
    behind a `Scene` split) and the adaptive buffer height / foreground apron (`PIX` is a fixed
    constant; `SceneInput` would have to carry the height).
32. **Never read**: `~/.claude/history.jsonl`, the `~/.claude/tasks/` background-task registry,
    `~/.claude/file-history/` snapshots. `useRtStream` exposes `root` "so the UI can name it rather
    than assume it" and nothing consumes it — there is no way to open the underlying transcript.

---

## Traps that have already cost time

- **Subagent budget.** A wave of sprite agents was told to "look at the contact sheet at least three
  times"; every one blew a ~70-minute limit reading multi-megapixel PNGs and was killed, and the two
  that had not written their file left **nothing**. Tell every art subagent: *write the complete file
  first, then refine; at most two look passes; render at zoom 3.*
- **Reserved `Look` slots.** `S s H h T t P` are filled from the `Look` at draw time. Putting one in
  an `Art`'s `map` does nothing — that is how `LEGS_WALK` frames 0 and 2 stayed byte-identical
  through a commit that claimed to fix them.
- **`*/` inside a block comment ends the comment.** Writing a glob like `wf_*/` in a `/** … */` once
  corrupted `hub.ts` into 30 parse errors. Rephrase; never inline that glob.
- **Dev and e2e cannot both run.** Stop dev by **port**, not by stopping the npm wrapper.
- **Vite `strictPort` is load-bearing** — the hub's Origin allowlist names 5173/4173.
- **Engine tests pin literal coordinates on purpose.** Changing the floor plan means updating them;
  that is correct and expected.
- **The kitchen lane clamps.** The top desk row sits *above* `WAYPOINTS.coffeeLane.y`, so a coffee
  route drops to the lane's turn before joining the aisle. That is the guard against walking through
  the counter, not a bug.
- **Subagents leave scratch files.** Tell read-only agents explicitly not to write, and run
  `git status` after every wave.
- **Do not trust a narrow sample.** The token undercount reads 0% across 25 recent main-session
  files and 50% across all 2,548. Measure the whole corpus before concluding anything about the data.
- **The MCP browser wedges** if a subagent leaves a session open. A standalone Playwright script run
  from inside the repo works around it and binds nothing.

---

## The visual loop — not optional

```
npx tsx scripts/sheet.ts <module> [zoom]   # .preview/<module>.png — one module's sprites
npm run room                               # .preview/room-{day,night,spawn}.png — the whole office
npm run room:bless                         # rewrite tests/room.baseline.json
```

**Open the PNG with the Read tool and look at it.** `tests/room.test.ts` hashes three shots against
`tests/room.baseline.json`; when it fails and the change was intended, render, *look*, then bless.
Blessing without looking is how a regression becomes the baseline — I did it once this session,
caught it, and re-blessed against a render I had actually reviewed.

`docs/pixel-contract.md` is the binding contract for the sprite modules. **`docs/superpowers/specs/`
is stale** — it describes the deleted DOM room ("plain DOM/CSS components… no canvas needed") and
should be updated or explicitly marked superseded early in this session.

## Verifying

`npm test` · `npx tsc --noEmit` · `npm run e2e` (stop dev by port first — ask me).

Verify by clicking through the real UI, not by asserting on evaluated state. `elementFromPoint` at
an actor's centre should return that actor's own element — that is what proves the accessibility
layer is really on top of the sprite it claims to label. Note that agents standing close together
in the break corner genuinely occlude one another; 6/6 reachable at rest is the bar, not 6/6 always.

## Architecture, one paragraph

`server/tail.ts` byte-offset tails the JSONL → `server/parse.ts` tolerantly parses a line →
`server/normalize.ts` turns it into typed `Ev` (assigning a process-monotonic `seq`) →
`server/hub.ts` watches with chokidar, derives cross-file events, keeps a replay backlog and
broadcasts over a loopback WebSocket gated on `Origin` → `src/ws.ts` batches frames →
`src/store.ts` folds them into `RtState` (pure, de-duplicated by `seq`) → the dock panels render
that state, while `src/office/mapping.ts` turns the same events into commands for the deterministic
simulation in `src/office/engine.ts`, `src/office/replay.ts` records those commands so any past
moment can be rebuilt, and `src/office/pixel/scene.ts` paints whatever the latest tick reported into
a 480×270 buffer that `PixelOffice.tsx` blits and hangs the accessibility layer over. Shared wire
types live in `shared/` and are the only thing both halves import.
