# ROUNDTABLE — BUILD SESSION 1 (Observer MVP, Tasks 1-10)

Repo: `<repo>` (git; docs only — no code yet).

Read first, in order:
1. `docs/superpowers/specs/2026-08-02-roundtable-observer-design.md` — what + why (architecture, event model, behavior mapping)
2. `docs/superpowers/plans/2026-08-02-roundtable-observer-mvp.md` — 10 TDD tasks. EXECUTE THIS.
3. `docs/mockup/office-sim-v5.html` + `office-sim-v5-huddle.png` — approved visual; Task 10 ports it 1:1 into React.

Mission: execute the plan task-by-task using **superpowers:subagent-driven-development** (fresh subagent per task, review between tasks). Follow each task's RED-GREEN steps exactly; one commit per task with the message given in the plan.

Hard constraints (from spec — never relax):
- TypeScript `strict` everywhere; Node 20+; Vite + React 18 + Tailwind; vitest + Playwright.
- Server binds **127.0.0.1:7411 only**; zero external network calls.
- `~/.claude` access strictly **READ-ONLY**; `ROUNDTABLE_HOME` env var overrides the root — every test uses temp dirs, never the real one.
- Fixtures **SYNTHETIC only** — never copy real transcripts into the repo (private data).
- Unknown JSONL line types/fields are ignored, never crash (schema-drift tolerance).
- Windows-first: `node:path` joins everywhere; chokidar `usePolling` fallback.
- Visuals per mockup: natural office palette, humans, furniture ≤3× person width. No neon, no dark theme.

Definition of done for this session:
1. `npm test` green — tailer, parser, normalizer, sessions, store, mapping, engine suites.
2. Playwright e2e green — synthetic live append → thought bubble + chat card appear.
3. **Manual live proof (the real "verified" bar):** `npm run dev`, open a second Claude Code session, spawn a subagent in it, screenshot Roundtable rendering that REAL session (actor + chat message). e2e alone does not count as verified.
4. Commit history = one commit per task, plan messages verbatim.

If the on-disk schema differs from fixtures (Claude Code updated): trust disk, update fixtures + `fixtures/NOTES.md`, and report the diff in the session summary.

Traps (from memory `project_roundtable.md`):
- Playwright MCP blocks `file://` — preview via `python -m http.server` on localhost.
- Screenshots: pass ABSOLUTE output paths; default output dir is untraceable.
- `.msg-user` chat card needs its own `grid-template-columns: minmax(0,1fr)` or text wraps one word per line.
- Subagent transcripts live at `<slug>/<sessionId>/subagents/agent-<id>.jsonl` — NOT inline in the main jsonl.
- Agents never talk laterally (tree topology) — choreography is decorative, message content must stay real.

Scope guard: touch nothing outside the repo except reading `~/.claude`. No artifact publishing with real transcript content. P3-P5 (workflows/huddles, hooks fast-path, replay) are OUT of scope — separate plans after MVP validates.
