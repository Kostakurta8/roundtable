# Roundtable — make the office mean something (paste into a fresh Claude Code session)

---

## THE PROMPT

In `<repo>` (branch `feat/observer-mvp`, nothing committed, 149 tests
green, `npx tsc --noEmit` clean): the pixel-art office renderer is built and looks right. Now make
it **say something**.

The room currently answers "twelve agents exist, some are typing". It cannot answer "is this going
well". The root cause is not art — it is that `src/office/mapping.ts` turns eleven event kinds into
six commands and **drops five of them**, including `toolResult` (did it work), `agentSpawn` (who
asked whom), and `agentDone` (so nobody ever leaves the room). Widen that seam first and most of
the rest gets cheap.

Work the ten items in `docs/SESSION_PROMPT_ALIVE.md` §"The actual task", in that order. The first
three are the ones that change how the room reads; do not start at the bottom.

Read `docs/SESSION_PROMPT_ALIVE.md` in full before touching anything — it carries the verified
facts, the traps that already cost time, and the visual-review loop that is not optional.

Hard constraints: **read-only on `~/.claude`, never write there.** Keep `npm run dev` running until
I say stop. Do not commit unless I ask. Use as many subagents as the work needs, but read the
subagent budget note in §Traps first — the last session lost two modules to it.

---

## Where things stand

Everything in this section is done and verified. Do not redo it.

### Shipped

- **A pixel-art canvas renderer.** 480×270 internal buffer, nearest-neighbour upscale, painter
  order by floor row. Replaced the DOM+CSS room entirely (`Office.tsx`, `Actor.tsx`, `scene.css`,
  `realism.css` are deleted).
- **Seven modules**, ~6300 lines: `art` (palette, sprite format, blitter, 3×5 font), `environment`
  (wall, floor, windows, door, whiteboard, rug, lamps), `furniture` (desks, chairs, monitors,
  roundtable, storage), `characters` (16×24 people, 8 hair silhouettes), `props` (clutter, bubbles,
  nameplates), `effects` (steam, dust, shafts, grades), `scene` (composition), plus
  `PixelOffice.tsx` (canvas, rAF, camera, accessibility layer) and `pixel.css`.
- **Life:** walk cycles, idle breathing, per-agent blink, typing with screen flicker, speech
  bubbles with a fixed-box typewriter, thought clouds, coffee steam, plant sway, dust in the light
  shafts, footstep puffs, chair swivel, door swing on arrival, `!`/`?` pops, day↔night as an eased
  repaint rather than a stylesheet swap.
- **A new floor plan.** Two banks of six facing each other across an open middle, filled
  alternating sides. `POD_ROW_PITCH_Y` 90 → 187 (the old pitch drew every row through the one above
  it), `MAX_SEATS` 12 → 13.
- **An offline render harness** — see §The visual loop. It is the reason the art is right.

### Verified facts — do not re-derive

| Fact | Detail |
|---|---|
| The room is blind to half the stream | `mapping.ts` handles `agentSeen`, `thinking`, `toolStart`, `agentText`, `usage`. It drops `userMessage`, `toolResult`, `fileEdit`, `agentSpawn`, `agentDone`. `toolStart` carries `tool` and `target` but both are flattened into one status string, so the room knows an agent is busy and never at what. |
| `agentDone` already exists | `{ kind: 'agentDone'; ref; ok: boolean; ts; seq }` in `shared/events.ts`. Hot-desking needs no new plumbing from the server. |
| `agentSpawn` carries the link | `{ childAgentId, prompt, toolUseId }`. Parent→child arrows are a render away. |
| Facing is not recoverable from the engine | `ActorState` has `flip`/`away`, and "walking right" and "walking toward the camera" are both `flip:false, away:false`. `scene.ts` differences the position between frames instead. Do not try to fix this in the engine — it is tested and the renderer is the right place. |
| The canvas is not the accessibility story | Every actor also gets a real focusable `.actor` element, positioned over its sprite by the frame loop, carrying `data-agent`, `role`, `aria-label`, and the bubble text. Clicks, keyboard, screen readers and `e2e/live.spec.ts` all run on those, not on pixels. |
| React is not in the frame loop | The engine lives in a ref; the loop writes the canvas and the DOM marks imperatively. React re-renders only when the *cast* changes. Reintroducing a per-frame `setState` re-renders the whole tree sixty times a second for a walk across the floor. |
| Determinism is enforced | No `Math.random`, no `Date.now` anywhere in `src/office/pixel/`. Every animation phase comes from accumulated tick time and an integer seed. `tests/pixel.test.ts` asserts two Scenes fed the same ticks paint byte-identical buffers. Replay depends on this. |
| The context is three calls wide | The renderer uses only `fillStyle`, `globalAlpha`, `fillRect`. The preview harness implements exactly that subset — anything else silently no-ops there and looks different in the browser. |
| Nameplate height is a contract | 8px without `sub`, 14px with. `scene.ts` subtracts exactly that when stacking a bubble above it. |

### Traps that already cost time

- **Subagent budget is the big one.** The first sprite workflow told five agents to "render the
  contact sheet and look at it, at least three times". Each pass reads a multi-megapixel PNG. All
  five blew past a ~70-minute per-agent limit and were killed — and the two that had not written
  their file yet (`characters.ts`, `props.ts`) left **nothing**. Tell every sprite subagent: *write
  the complete file first, then refine; at most two look passes; render at zoom 3.* Recovery cost
  an hour.
- **`art.ts` shipped with eleven broken glyphs.** The font was authored as flat 15-character runs
  and `B N O R S` and half the digits rendered as unrelated shapes — invisible until something was
  rendered. It is now `FONT_ROWS`, five rows of three per glyph. Do not "tidy" it back into runs.
- **`drawArt` with `tint` used to paint transparent pixels**, so every silhouette and drop shadow
  was a solid rectangle. **`pool()` was a pixel wider on one side**, so every light pool was
  lopsided. Both fixed, both now tested. They were found by rendering, not by reading.
- **`*/` inside a block comment ends the comment.** Writing a glob like `wf_*/` in a `/** … */`
  corrupted `hub.ts` into 30 parse errors. Rephrase, never inline that glob.
- **Dev and e2e cannot both run.** `npm run e2e` binds its own hub on 7411 and `npm run dev` holds
  it. Stop dev by **port**, not by stopping the npm wrapper — the children outlive it.
- **Vite `strictPort` is load-bearing.** The hub's Origin allowlist names 5173/4173; silent port
  drift means the app renders but never connects.
- **Subagents leave scratch files.** Tell read-only agents explicitly not to write, and run
  `git status` after every wave.
- **Engine tests pin literal coordinates.** Changing the floor plan means updating the seat
  assertions in `tests/engine.test.ts` — that is correct and expected, they encode the geometry
  table on purpose. Three of them plus one routing test needed it last time.
- **The kitchen lane clamps.** The top desk row now sits *above* `WAYPOINTS.coffeeLane.y`, so a
  route to the coffee machine drops to the lane's turn before joining the aisle. That is the
  engine's own guard against walking through the counter, not a bug.
- **The chair is drawn in front of a seated person**, not behind. They face their monitor away from
  the camera, so what you see is a head and shoulders over a chair back.

### The visual loop — not optional

```
npx tsx scripts/sheet.ts <module> [zoom]   # .preview/<module>.png — one module's sprites
npx tsx scripts/sheet.ts all               # every module
npx tsx scripts/room.ts [seconds]          # .preview/room-day.png + room-night.png, the whole office
```

`scripts/pixpreview.ts` is a software canvas implementing the three context calls the renderer
uses, plus a PNG encoder over node's zlib. No browser, no dev server, no session needed.

**Open the PNG with the Read tool and look at it.** Every defect listed above was found this way
and none of them by reading source. Each module exports `PREVIEW: PreviewItem[]`
(`src/office/pixel/preview.ts`); anything new must appear there, and anything animated must declare
`frames` so the motion can be judged from a strip.

`docs/pixel-contract.md` is the binding contract for the sprite modules: exact signatures, the
palette, the anchor rule, and the house style. Read it before editing any of them.

---

## The actual task

Ten items, in order. The first three change how the room reads; the rest refine it.

### 1. Widen the command seam — do this first

`src/office/mapping.ts` and `src/office/engine.ts`. Everything else is cheaper afterwards.

Add commands for the five dropped events, and stop flattening `toolStart`:

- `tool` — carry the **tool kind** (`Read` / `Edit` / `Write` / `Bash` / `Grep` / `WebFetch` /
  `Task` / …) and its target, not just a label string.
- `toolEnd` — from `toolResult`, with `ok`.
- `spawn` — from `agentSpawn`: parent, child, prompt.
- `done` — from `agentDone`, with `ok`.
- `edit` — from `fileEdit`, with the path.

`mapEvent` is pure and fully tested (`tests/mapping.test.ts`); keep it that way and extend the
tests alongside. The engine gains new *states* to report on `ActorState` (current tool kind, last
outcome, finished) — resist adding behaviour to the engine that the renderer could derive.

### 2. Fix the walk — three real defects

`src/office/pixel/characters.ts`.

- **Lockstep.** Line ~436: `step = Math.floor(t / 110) % 4`, with no `seed`. Every walking agent is
  on the same frame at the same instant, so a crowd reads as one animation. Phase by seed.
- **Skating.** The cycle is driven by wall time, not by distance travelled, so feet slide whenever
  speed or frame delta changes. Drive it from accumulated distance — `scene.ts` already tracks
  per-actor movement in `Mem.stepAcc` for footstep puffs.
- **One gait.** Derive stride length (±1px), cycle length (±15%), bob amplitude and a slight lean
  from the seed. Twelve people, twelve walks.

Then: a 2-frame **turn** instead of an instant facing flip, and a step of accel/decel at each end of
a trip so people settle rather than stop dead.

### 3. Hot-desking — let people leave

Spec §3.3. The room seats 13 and a workflow spawns forty; today nobody ever leaves, so a long
session fills every chair with finished agents and pushes live ones off-site.

With `done` (item 1): a finished agent stands, walks to the door, and exits. Its seat frees, and the
longest-waiting off-site agent walks in and takes it. The seats then *mean* "currently working",
and the room generates constant motivated motion for free.

The engine currently never removes an actor — `Engine.order` and `byId` only grow. That is the
change. `WAYPOINTS.door` and `doorLane` already exist and every arrival already uses them.

### 4. Tool-shaped postures and reactions

`characters.ts` (new acts) + `scene.ts` (choosing them from the new `ActorState`).

| tool | posture |
|---|---|
| `Read` / `Grep` / `Glob` | leans back holding a sheet up, occasional page-turn |
| `Edit` / `Write` | the current typing, faster, more keys lit |
| `Bash` | turns to a terminal; screen flashes green or red on the result |
| `WebFetch` / `WebSearch` | stands, walks to a window, looks out (the windows are already there) |
| `Task` | stands, walks to the door, hands off a clipboard |
| waiting on children | leans back, hands behind head, screen dims |

Reactions from `toolEnd.ok`: a fist-pump on a `CONFIRMED` verdict, head-in-hands on a failure, and
papers scattered on the floor at a desk that keeps failing.

### 5. Idle variety, secondary motion, body variety

- **Five idle micro-actions** on a seeded schedule — stretch, sip the mug, scratch, lean back, spin
  the chair. Four to eight frames each. This is what kills "everyone is a statue".
- **Secondary motion:** head-turn toward whoever is currently speaking (a 1px head offset and an
  eye shift is enough), weight shift while standing, chair recoil on sitting, and bubbles popping in
  over two frames instead of appearing.
- **Body variety:** two or three heights and two builds, plus seeded accessories — glasses,
  headphones, a lanyard, a beanie. Headphones read especially well at this size. 8 hair × 3 heights
  is 24 silhouettes instead of 8.
  **One structural cost:** `CHAR.h` is a constant that `scene.ts` uses for hit boxes and nameplate
  placement. Variable heights need a `charHeight(seed)` accessor and every reader updated.

### 6. Make the room legible

- **Spawn lines.** A thin dotted parent→child line for ~2s after a spawn, with the label. This is
  literally the reference image's "ASSIGN TASK" arrow, and `parentId` / `spawnDepth` / `workflowId`
  are already in `RtState` and drawn nowhere.
- **Monitor content by tool kind** — code lines / a scrolling log / a page / a magnifier — and
  **screen colour by phase**: working blue, waiting amber, error red, done grey.
- **Cost as a physical object.** The paper stack on a desk grows with tokens spent. No numbers, and
  legible at a glance — right now $160 and 66M tokens live only in the top bar.
- **A done desk looks done:** chair pushed in, monitor off, desk tidy.
- **The off-site strip** needs labels on hover, colour by phase, and a busy-first sort. Today it is
  23 anonymous heads.
- **The whiteboard is underused** — it is the natural anchor for what this session is and how it is
  going.

### 7. Interaction

- **Hover** an agent or a desk → highlight plus a small card (name, tool, tokens, cost, elapsed)
  without committing a selection. The single biggest interaction win.
- **The camera is half-built and the comment over-claims it.** `PixelOffice.tsx` says "a drag pans"
  and there is no drag handler; the wheel zooms about the room's centre rather than the cursor; and
  the `follow` state only writes a data attribute and drives nothing. Fix all four, add keyboard
  (arrows pan, ± zoom, F follow, Esc home), double-click-an-agent to zoom to them, and a visible
  zoom affordance.
- **Clickable fixtures:** the whiteboard opens the session panel, the roundtable filters chat to
  cross-agent messages.
- **Subtree highlight:** click a parent, dim everyone outside its spawn tree.

### 8. Huddle and coffee break

The two behaviours `docs/superpowers/specs/2026-08-02-roundtable-observer-design.md` §3.2 mapped and
nobody built. Every waypoint exists and is unused.

- **Huddle** — three or more agents exchanging inside a window walk to the roundtable
  (`WAYPOINTS.tableN/W/E/S`, `tableLane`). The roundtable is currently furniture nobody has ever
  sat at.
- **Coffee break** — an agent idle more than 90s while others work walks to the machine
  (`WAYPOINTS.coffee`, `coffeeLane`). Mind the lane clamp noted in §Traps.

### 9. Replay

Spec P5, and the largest item. Everything needed is present: `state.buckets`, a monotonic `seq`, and
an engine that is deterministic by construction and has a test proving it.

A scrubber over a historical session: seek rebuilds an `Engine` and replays the command stream up to
that point with synthetic deltas. This is what turns the app from a live toy into an observer.
Do it last, as its own project.

### 10. Debt worth clearing

- **Static layer cache.** The wall, floor and fixtures are repainted every frame and only change on
  a night shift or a resize. Cache them into a second buffer.
- **The DOM layer writes every frame** — `transform` plus `setAttribute` for 13 elements at 60fps,
  ~800 style writes a second. Write only on change.
- **Reduced motion is half-honoured.** The simulation slows to a 500ms tick but the effects still
  animate at that tick, so steam and dust *jump*. They should freeze.
- **No `aria-live` on bubbles** — a screen reader user never learns that an agent spoke.
- **No visual regression test.** The PNG harness exists; hashing `room-day.png` and failing on an
  unintended change would have caught three of the defects found by eye last session.
- **The room uses ~63% of the stage height.** The roster rail forces a left inset, so the fit is
  width-limited and the band above is filled with a stepped ceiling. An adaptive buffer height —
  extra rows below 270 as a foreground apron — would fill the stage and add depth.
  `PIX` is currently a fixed constant; `SceneInput` would have to carry the height.
- Known art weak spots, self-reported by their authors: the chair's side view is thin and does not
  lean; front and back chairs are near-identical; thought-bubble puffs are rounded squares rather
  than circles; the floor's course pitch is perfectly regular, giving a faint corduroy at distance.

---

## Running it

```
npm run dev        # hub on ws://127.0.0.1:7411/ws + vite on http://localhost:5173
npm test           # vitest, 149 passing
npx tsc --noEmit   # clean
npm run e2e        # playwright — stop dev first, it wants port 7411 itself
npx tsx scripts/room.ts     # the whole office to a PNG, no browser needed
```

Verify by clicking through the real UI, not by asserting on evaluated state. `elementFromPoint` at
an actor's centre should return that actor's own element — that is what proves the accessibility
layer is really on top of the sprite it claims to label.

## Architecture, one paragraph

`server/tail.ts` byte-offset tails the JSONL → `server/parse.ts` tolerantly parses a line →
`server/normalize.ts` turns it into typed `Ev` (assigning a process-monotonic `seq`) →
`server/hub.ts` watches with chokidar, derives cross-file events, keeps a replay backlog and
broadcasts over a loopback WebSocket gated on `Origin` → `src/ws.ts` batches frames →
`src/store.ts` folds them into `RtState` (pure, de-duplicated by `seq`) → the dock panels render
that state, while `src/office/mapping.ts` turns the same events into commands for the deterministic
simulation in `src/office/engine.ts`, and `src/office/pixel/scene.ts` paints whatever the latest
tick reported into a 480×270 buffer that `PixelOffice.tsx` blits and hangs the accessibility layer
over. Shared wire types live in `shared/` and are the only thing both halves import.

## Open, not blocking

- Nothing is committed. The pixel renderer, the harness, the contract and the new floor plan are all
  uncommitted on `feat/observer-mvp`.
- `npm run e2e` has not been run since the renderer swap — the port conflict with a dev server that
  was asked to stay up. Its `.actor` and canvas-sizing assertions were verified live in the browser
  instead, and the one stale assertion (a `.scene` CSS transform that no longer exists) was updated.
- No memory file was written: writing to `~/.claude` was forbidden. Lift that and the facts table
  above is worth saving.
