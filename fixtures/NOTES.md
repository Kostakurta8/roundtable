# Fixture schema notes

These fixtures are SYNTHETIC — hand-written lines that replicate the on-disk transcript schema
verified live on this machine (CC v2.1.220, probed 2026-08-02). They never contain real
transcript content. Source: verified-schema table from
`docs/superpowers/specs/2026-08-02-roundtable-observer-design.md` §2.

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

## Fixture files in this directory

- `main-session.jsonl` — synthetic main-session transcript: user turn, assistant turn with
  `thinking` + `text` + `tool_use` (Grep), user turn with a `tool_result`, assistant turn spawning
  a subagent via `tool_use` (Task), and a `file-history-snapshot` line (must be tolerated/ignored
  by the parser).
- `agent-abc123.jsonl` — synthetic subagent transcript for `agentId: "abc123"`: `isSidechain:true`
  lines, a user turn (the spawn prompt) and an assistant turn with `text` only (no tool use).
- `agent-abc123.meta.json` — minimal subagent metadata (P0 stub; refined with real fields once
  probed against a live subagent run in a later task).
