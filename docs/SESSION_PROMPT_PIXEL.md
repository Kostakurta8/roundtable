# Roundtable — pixel-art office renderer (paste into a fresh Claude Code session)

---

## THE PROMPT

In `<repo>` (branch `feat/observer-mvp`, everything below already
built, 131 tests green, nothing committed): replace the office renderer with a **2.5D pixel-art
canvas renderer** in the style of an HD-2D pixel office — chunky hard-edged pixels, saturated
teal/wood palette, dark outlines, characters at desks with distinct hair and shirts, dense props,
warm lamp pools and cool monitor glow. Then make it **alive**: walk cycles, idle breathing, blink,
typing, animated thought/speech bubbles, steam, plant sway, dust motes in the light, day/night.

Use as many subagents as the work needs — sprite authoring parallelises cleanly by module.

Hard constraints: **read-only on `~/.claude`, never write there** (that includes the memory
directory). Keep `npm run dev` running until I say stop. Do not commit unless I ask.

---

## Where things stand

Everything in this section is done and verified — do not redo it.

### This session shipped

- **Server rewrite.** Cache tokens, agent sidecar ingestion, workflow subagents, spawn→done
  correlation, roster push, watch eviction, bounded tailing.
- **New data model.** `RtState` with per-agent `TokenUse`, cost estimate, tool history, phase,
  spawn tree, activity buckets, `seq` de-duplication.
- **New shell UI.** CSS-grid app (top bar / stage / dock / timeline), light+night themes, tabbed
  dock (Chat/Agents/Tools), roster rail, actor inspector, command palette (Ctrl+K), keyboard
  shortcuts, chat search + lane filters, activity timeline with seek-to-turn.
- **28 audited defects fixed** (a 44-agent adversarial audit workflow; findings were verified by
  independent refuters, not just reported).

### Verified facts about the data — do not re-derive

| Fact | Detail |
|---|---|
| Cache tokens dominate | Real usage: `input_tokens:2, cache_creation:19103, cache_read:28931, output:897`. Counting only in+out understates a turn ~50×. |
| One response spans many lines | An assistant response is written as one JSONL line **per content block**, each repeating an identical `usage` object. De-duplicate on `message.id` or totals come out ~2.4× high. |
| Agent sidecars are gold | `subagents/agent-<id>.meta.json` = `{agentType, description, toolUseId, spawnDepth, model}`. `description` is the human label; `toolUseId` is the only link back to the parent's `Task` call. |
| Workflow agents hide deeper | `subagents/workflows/wf_<id>/agent-*.jsonl` — a second level `subagentFiles` must scan. `journal.jsonl` there only records `{"type":"started"}`; no phase names, no results. |
| Session registry | `~/.claude/sessions/<pid>.json` = `{sessionId, cwd, name, status, updatedAt, version}`. Gives real session names and liveness. A file outlives its process — pair it with recent mtime. |
| Line sizes are brutal | 287 lines over 1 MiB across 53 transcripts; largest 3,995,799 bytes. The tailer must be able to step over one. |

### Traps that already cost time

- **`*/` inside a block comment ends the comment.** Writing a glob like `wf_*/` in a `/** … */`
  corrupted `hub.ts` into 30 parse errors. Rephrase, never inline that glob.
- **`.floor` is `inset: 0`** and paints the wall band as the top stop of one gradient. Anything
  drawn "behind the wall" is invisible — a separate ceiling plane was wasted work.
- **Default parameters swallow explicit `undefined`.** `f(x, ok = true)` called as `f(x, undefined)`
  uses `true`. Cost one wrong test.
- **`window` as a React state name** shadows the DOM global. Renamed to `limit`.
- **Vite `strictPort` is load-bearing.** The hub's Origin allowlist names 5173/4173; silent port
  drift means the app renders but never connects.
- **Audit subagents have write tools.** Three left scratch files in the repo (`tests/zz_*.test.ts`,
  `__verify_tmp.ts`). Tell read-only agents explicitly not to write, and `git status` after.
- **Dev-server children outlive the wrapper.** `TaskStop` on `npm run dev` leaves node holding
  5173/7411; kill by port.

---

## The actual task

### 1. Renderer swap

The current room is DOM + CSS (`src/office/Office.tsx`, `scene.css`, `realism.css`). It cannot get
crisp — every realism attempt came out as a soft airbrushed diagram, which is what triggered this
rewrite. Replace it with a canvas renderer.

**Already written, use it:** `src/office/pixel/art.ts` — the substrate. 480×270 internal canvas,
locked palette (`PAL`), string-rows sprite format (`Art`), run-merged blitter (`drawArt`),
recolour slots (`Look`: skin/hair/shirt/trouser), banded light `pool()`, and a 3×5 pixel font
(`drawText`, `drawTextOutlined`) — a webfont would anti-alias to mush against hard pixels.

Scale the canvas up with `image-rendering: pixelated`, `ctx.imageSmoothingEnabled = false`.

**Do not touch the simulation.** `src/office/engine.ts` owns positions in a fixed 1600×900 basis
and is fully tested (walk queues, waypoints, pod seating, `MAX_SEATS = 12`, `MAX_QUEUED_TRIPS = 2`).
The renderer maps that basis to 480×270 — a straight ÷3.333 — and draws whatever the latest tick
reports. Same for `mapping.ts`.

Suggested module split (parallelises across agents; each owns exactly one file):

```
src/office/pixel/art.ts          DONE — palette, Art format, blitter, font, pools
src/office/pixel/characters.ts   idle/walk/sit/type/talk/think frames, front/side/back
src/office/pixel/furniture.ts    desks, chairs, monitors, cabinets, shelves, roundtable
src/office/pixel/environment.ts  floor tiles, wall panels, windows, door, rug, ceiling lights
src/office/pixel/props.ts        mugs, papers, keyboards, plants, coffee machine, printer, bubbles
src/office/pixel/effects.ts      steam, dust motes, screen flicker, sway, footstep puffs
src/office/pixel/scene.ts        composition + painter-order draw loop  (own this yourself)
src/office/PixelOffice.tsx       canvas element, rAF, camera, hit-testing  (own this yourself)
```

Give sprite agents the `art.ts` contract, the palette keys, the exact sprite dimensions you want,
and the reference look. Review every returned sprite by rendering it — pixel art authored blind is
frequently wrong.

### 2. Animation and life

Walk cycle · idle breathing · blink · typing hands + screen flicker · thought bubble with animated
dots · speech bubble typewriter · coffee steam · plant sway · dust motes in the light shafts ·
chair swivel on sit · door swing on arrival · footstep puffs · warm/cool light shift between day
and night · emote pops (`!` on a failed tool, `?` when idle).

Animation clocks must be driven off the tick delta, not `Date.now()` — the engine is deterministic
and the renderer should stay replayable.

### 3. Features the design spec asked for and nobody built

`docs/superpowers/specs/2026-08-02-roundtable-observer-design.md` §3.2 lists two behaviours that
were mapped but never implemented:

- **Huddle** — ≥3 agents exchanging inside a window walk to the roundtable. All the waypoints
  already exist (`WAYPOINTS.tableN/W/E/S`, `tableLane`).
- **Coffee break** — an agent idle >90s while others work walks to the machine. `WAYPOINTS.coffee`
  and `coffeeLane` exist.

Also worth doing:

- **Ghost deck for overflow.** The room seats 12; a workflow spawns 40+. Today the surplus is one
  line of text (`+37 more working off-site`). Make it a strip of small pixel avatars along the
  bottom with live status — the information is already in `RtState`.
- **Camera.** Follow the selected actor, zoom, pan. Selection already works end to end
  (rail ↔ room ↔ inspector ↔ chat filter).
- **Replay.** Everything needed is present: `state.buckets`, monotonic `seq`, a deterministic
  engine. A scrubber over a historical session is the last big feature (spec P5).

---

## Running it

```
cd "<repo>"
npm run dev        # hub on ws://127.0.0.1:7411/ws + vite on http://localhost:5173
npm test           # vitest, 131 passing
npx tsc --noEmit   # clean
npm run e2e        # playwright
```

Ports are pinned with `strictPort` on purpose. If a stale dev server holds them, kill by port —
stopping the npm wrapper is not enough.

Verify in the browser by clicking through the real UI, not by asserting on evaluated state.

## Architecture, one paragraph

`server/tail.ts` byte-offset tails the JSONL → `server/parse.ts` tolerantly parses a line →
`server/normalize.ts` turns it into typed `Ev` (assigning a process-monotonic `seq`) →
`server/hub.ts` watches with chokidar, derives cross-file events, keeps a replay backlog and
broadcasts over a loopback WebSocket gated on `Origin` → `src/ws.ts` batches frames →
`src/store.ts` folds them into `RtState` (pure, de-duplicated by `seq`) → the dock panels render
that state, while `src/office/mapping.ts` turns the same events into commands for the
deterministic simulation in `src/office/engine.ts`. Shared wire types live in `shared/` and are the
only thing both halves import.

## Open, not blocking

- Nothing is committed. 22 modified files, 6 new paths, all on `feat/observer-mvp`.
- The whiteboard shows "waiting for a task…" on very long sessions: the hub's 4000-event backlog
  can drop the opening prompt. Honest, but worth a nicer fallback.
- No memory file was written this session — writing to `~/.claude` was forbidden. Lift that and
  the facts table above is worth saving.
