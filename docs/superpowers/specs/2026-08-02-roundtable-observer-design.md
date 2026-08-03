# Roundtable — live multi-agent office for Claude Code (Observer MVP)

Date: 2026-08-02 · Status: **PARTLY SUPERSEDED — see below** · Session: planning (a2c2ce06)

> ## Superseded, 2026-08-03
>
> This document is kept because its §2 (what is actually on disk), its event vocabulary and its
> phase plan are still the design the code follows. Four decisions in it are not, and are marked
> **SUPERSEDED** where they appear. Read those corrections before treating any part of this file as
> current.
>
> | Where | What it says | What is true now |
> |---|---|---|
> | §3.3 | "One session rendered at a time (v1)." | Every session that is *running* is streamed at once, and a tab appears per session with agents working. `shared/protocol.ts`, `src/ws.ts`, `src/App.tsx`. |
> | §5 Client | "Office sim = plain DOM/CSS components … no canvas/WebGL needed" | The room is a 480×270 pixel-art canvas buffer blitted to a `<canvas>`, with a transparent DOM layer over it for accessibility and hit testing. `src/office/pixel/`, `src/office/PixelOffice.tsx`. `docs/pixel-contract.md` is the binding contract for the sprite modules. |
> | §5 Client | "Tailwind" / "react-virtuoso" | Tailwind is installed and entirely unused — there is not one utility class in `src/`. The feed windows itself (`RENDER_WINDOW` in `src/chat/Chat.tsx`); react-virtuoso was never added. |
> | §5 Run | "opens http://127.0.0.1:7411" | 7411 is the hub's WebSocket only; it answers HTTP with a 404. The app is Vite on 5173, and the hub's `Origin` allowlist names 5173/4173 — that pairing is load-bearing. |
>
> One more correction, to §2 rather than to a decision: a streamed response is written as several
> JSONL lines sharing one `message.id`, each repeating that response's usage *as it stood* — the
> first line says `output_tokens: 1` and the last says the total. Anything that reads usage per line
> is wrong by roughly a factor of two in one direction or 2.4 in the other. See
> `server/normalize.ts`.

## 1. What it is

Local web app ("Roundtable") that visualizes REAL Claude Code sessions on this machine as an
animated office floor: each agent (main orchestrator + subagents + workflow agents) is a human
character at a desk. Characters work (typing, screen code lines), think (thought bubbles from real
`thinking` blocks), talk (speech bubbles), walk to each other and huddle at a round meeting table
when agents exchange results. Right side: group-chat feed of the same events in text form with
collapsible "internal monologue" per message. Read-only observer — never writes, never interferes.

Approved by user in this session:
- Scope: **Observer MVP** (no hooks required in v1, no SDK cockpit).
- Visual direction: **realistic office floor, natural colours, human characters that walk and
  communicate** (mockup `office-sim-v5`, artifact b2b58b54, approved direction after 4 iterations).
- Deliverables path: mockup → design doc → implementation plan (this doc is step 2).

## 2. Verified data reality (probed 2026-08-02 on this machine, CC v2.1.220)

All on disk, no API needed. Evidence gathered live this session:

| Source | Path | Contains |
|---|---|---|
| Main session transcript | `~/.claude/projects/<cwd-slug>/<sessionId>.jsonl` | user/assistant lines; content blocks `text`, `thinking`(+signature), `tool_use`, `tool_result`; `usage` (tokens incl. cache); `permission-mode`, `hook_success`, `file-history-snapshot`, `attachment` lines; `version`, `cwd`, `gitBranch`, timestamps |
| Subagent transcripts | `<slug>/<sessionId>/subagents/agent-<agentId>.jsonl` + `agent-<agentId>.meta.json` | full per-agent conversation, `isSidechain:true`, `agentId`, per-message `model` (e.g. haiku for cavecrew), parentUuid chain |
| Workflow agents | cwd-slugged dirs `...-<sessionId>-subagents-workflows-wf-<id>` (+ `journal.jsonl` per Workflow docs) | per-workflow-agent transcripts, journal of returns |
| Live session registry | `~/.claude/sessions/<pid>.json` | running/recent sessions → live discovery |
| Background tasks | `~/.claude/tasks/<uuid>/` | task registry |
| File snapshots | `~/.claude/file-history/<sessionId>/` | rewind snapshots (v2 diffs source; v1 derives diffs from Edit tool_use old/new strings) |
| Prompt history | `~/.claude/history.jsonl` | cross-session prompts |

174 historical sessions exist in the home slug alone → replay library for free.

Hard truths the design honors:
- **Agents never talk to each other directly.** Topology is a tree (orchestrator ↔ children).
  "Debate" exists only when orchestration relays outputs (adversarial verify, judge panels). The
  office metaphor renders the tree honestly: results are "walked over" to the orchestrator; a
  refutation of agent X's claim is walked to X's desk. Semantic content is always real; the
  walking/coffee choreography is decorative and never invents facts.
- Thinking may be empty for some models (haiku probe: empty string + signature) → bubble only when
  non-empty text exists.
- Transcripts append per completed message (no token streaming) → update granularity is
  message/tool-event level; that is enough for the sim.

## 3. Architecture

```
~/.claude (read-only)                     Roundtable server (Node 20+, localhost only)
┌────────────────────────┐   watch    ┌──────────┐  parse   ┌────────────┐  broadcast  ┌─────────────┐
│ projects/**/*.jsonl    │ ─────────► │ chokidar │ ───────► │ normalizer │ ──────────► │ ws  :7411   │
│ projects/**/subagents/ │  (poll     │ tailer   │  byte-   │ → Event[]  │   JSON      │             │
│ sessions/*.json        │  fallback) │          │  offset  │            │             └──────┬──────┘
└────────────────────────┘            └──────────┘          └────────────┘                    │
                                                                                              ▼
                                                            Vite + React + TS strict + Tailwind client
                                                            ┌──────────────────────┬───────────────┐
                                                            │ OFFICE SIM (DOM/CSS) │ GROUP CHAT    │
                                                            │ actors·desks·bubbles │ feed+monologue│
                                                            └──────────────────────┴───────────────┘
```

### 3.1 Normalized event model (server → client)

`SessionSeen{id, cwd, live}` · `AgentSeen{agentId, type, label, model}` ·
`UserMessage{text}` · `AgentText{agentId, text}` · `Thinking{agentId, text, tokens}` ·
`ToolStart{agentId, tool, target}` / `ToolResult{agentId, ok}` (derived: tool_use → next tool_result) ·
`FileEdit{agentId, path, diffSummary}` · `AgentSpawn{parentId, agentId, prompt}` ·
`AgentDone{agentId, resultText, tokens}` · `Usage{agentId, in, out, cacheR, cacheW}` ·
`WorkflowPhase{title}` (P3). Every event carries `ts` + monotonic `seq`.

### 3.2 Behavior mapping (event → office)

| Real event | Office behavior | Chat |
|---|---|---|
| AgentSpawn | new human walks in from door to a free desk; desk materializes if needed | system chip "spawned X" |
| Thinking (non-empty) | thought bubble over head (truncated, click → full in chat) | monologue section on next message |
| ToolStart Bash/Grep/Read | typing pose + screen code-lines animate + status chip | tool chip |
| FileEdit | papers on desk + chip `Edit path` | chip w/ path |
| AgentText / AgentDone | walks note to orchestrator desk (short trip), speech bubble = first sentence | full message card |
| Verdict patterns (REFUTED/CONFIRMED in structured output) | walks to claim-owner's desk, speech bubble | verdict card, red/green border |
| ≥3 agents exchanging within a window / workflow phase barrier | huddle at roundtable | system line "huddle @ roundtable" |
| Idle > 90s while others run | coffee walk (decorative) | — |
| Session idle / done | lights dim slightly, agents sit back | — |

Determinism: all choreography is a pure function of the event stream (agentId-seeded), so replay
renders identically.

### 3.3 Scaling & multi-session

- Desks spawn on a grid; >12 actors → overflow "hot-desk" roster strip (visual cap).
- Sidebar session switcher: live sessions (from `sessions/*.json` + mtime<30s) + recent history.
  ~~One session rendered at a time (v1).~~ **SUPERSEDED 2026-08-03:** the hub streams every running
  session at once and the client holds one `RtState` and one office engine per session. A tab strip
  appears over the room when more than one session has agents working — where "working" means an
  agent other than `main`, not finished, and either active inside 90 s or holding a tool call open.
  Switching tabs discards nothing.
- Replay: same pipeline fed from a historical file with a time scrubber (P5).

## 4. Visual design (locked by mockup office-sim-v5)

Natural office: oak floor + planks, greige wall, daylight window pools, standing whiteboard
(task + hypotheses), kitchen w/ coffee machine (steam, LED), plants, round wooden ROUNDTABLE on a
ring rug. Humans ~30×54px: skin/hair variety, shirt = agent identity hue (muted naturals:
teal/violet/amber/rose/charcoal), back view when working (screens visible with animated code lines),
front view when talking; walk cycle = legs+arms swing. HUD: glass panels — top bar (wordmark,
session, LIVE, Σ tokens·$), agents legend w/ mini-face avatars + live status, right group-chat
(372px) with same avatars, verdict-bordered cards, collapsible monologue, system lines. Fonts:
Cascadia/ui-monospace for labels, Segoe UI for chat. No neon; semantic green/red only.

## 5. Tech choices

- **Server**: Node 20+, TypeScript strict, `chokidar` (usePolling fallback on Windows), `ws`.
  Incremental JSONL tail via per-file byte offsets; never re-parse whole files. Binds 127.0.0.1
  only (transcripts contain secrets). No persistence in v1 (in-memory; replay reads from disk).
- **Client**: Vite + React 18 + TS strict + ~~Tailwind~~. ~~Office sim = plain DOM/CSS components +
  ~200-line TS behavior engine … no canvas/WebGL needed at this actor count. Chat feed virtualized
  (react-virtuoso).~~
  **SUPERSEDED 2026-08-03:** the DOM room was deleted. The office is a 480×270 pixel-art buffer
  painted by `src/office/pixel/scene.ts` and blitted to a `<canvas>`, with a transparent layer of
  real focusable DOM elements positioned over each sprite — a canvas is a picture, and a picture is
  unreadable to a screen reader, a keyboard and a test alike. The behaviour engine survived and grew
  (`src/office/engine.ts`): actor state machines, waypoint walking, hot-desking, a break corner, and
  a deterministic command log that any past moment can be rebuilt from. Tailwind is installed and
  has zero utility classes anywhere in `src/`; the feed windows itself rather than virtualizing.
- **Tests**: vitest (parser, normalizer, behavior scheduler — fixtures = real transcript excerpts
  captured in P0); Playwright e2e (synthetic session file appended live → assert actor/chat).
- **Run**: `npm run dev` → server + client. ~~opens http://127.0.0.1:7411~~ **SUPERSEDED:** 7411 is
  the hub's WebSocket and answers plain HTTP with a 404; the app is Vite on 5173. The hub gates the
  WebSocket handshake on `Origin` against 5173/4173, so Vite's `strictPort` is load-bearing — a dev
  server that quietly moved to 5174 would be refused by the hub.

## 6. Build phases

- **P0 · Schema fixtures (0.5 session)** — copy 3 real transcripts (plain, subagent-heavy,
  workflow) into `fixtures/`, write schema notes, lock parser contracts. Verify subagent meta.json
  fields; locate workflow journal path precisely.
- **P1 · Tail → chat (1 session)** — server watcher+parser+ws; client chat feed + session picker;
  live tail of a real session incl. subagent files. Exit: watching THIS kind of session live.
- **P2 · Office sim (1-2 sessions)** — port mockup scene to React components; behavior engine;
  event mapping incl. spawn/done trips, thoughts, verdicts. Exit: real session renders as living
  office.
- **P3 · Workflows + multi-session (1 session)** — journal ingestion, phases → huddles, session
  switcher, >5-agent desk grid.
- **P4 · Hooks + polish (0.5-1 session, optional)** — PostToolUse/SessionStart hook POSTs for
  <100ms tool states (append to existing hooks config, fire-and-forget), sounds toggle, settings.
- **P5 · Replay (0.5 session)** — scrubber over historical sessions.

## 7. Risks / open questions

1. Transcript schema is undocumented → pin with fixtures + tolerant parser (unknown line types
   ignored, never crash). Re-verify on CC updates.
2. Subagent `meta.json` exact fields (label? type?) — P0 item; fallback = parse Task tool_use input
   in parent transcript.
3. Workflow transcript dir naming — P0 confirms real path from an actual run.
4. Windows FS event reliability — chokidar polling fallback (1s) acceptable.
5. Huge sessions (MB transcripts, 100s of events) — offset tailing + virtualization; sim renders
   only current state, not history.
6. Privacy: localhost-only, no telemetry, never publish transcript content (artifact demos use fake
   data only).

## 8. Out of scope (v1)

Hooks (v1.5/P4), SDK cockpit (send messages/interrupt — future), editing anything, multi-machine,
auth, packaging/distribution beyond `npm run dev`, TTS/sound design beyond a toggle stub.
