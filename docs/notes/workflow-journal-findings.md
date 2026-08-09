# What a Workflow run actually leaves on disk

Investigation notes, written against the live corpus on one developer machine
(78 completed Workflow runs, 164 session transcripts). Everything below was read
from real files, not from the design spec. Where the spec and the disk disagree,
the disk wins.

All paths are redacted to `<home>/.claude/projects/<slug>/<sessionId>/…`.
Where a value would identify a person or a client project it is replaced with a
placeholder and marked — **keys, types and structure are verbatim**.

---

## TL;DR

1. **`journal.jsonl` is not a phase log.** It is a memoization / resume ledger.
   It contains no phases, no timestamps, no tool-use ids, no labels, and no
   ordering information beyond append order. The spec's promise of
   "journal ingestion, phases → huddles" does not describe this file.
2. **Phases are real, and they live somewhere else** — in a per-run
   `<sessionId>/workflows/wf_<id>.json`, a sibling of the `subagents/` tree the
   hub already walks.
3. **That file is created exactly once, at the moment the run terminates.** It
   does not exist while the workflow is running. Proven below with NTFS
   creation-vs-write timestamps.
4. Consequence: a `workflowPhase` event can honestly answer *"which agents
   belonged to which phase"* and *"which phase was in flight when the run
   ended"*. It **cannot** answer *"which phase is this running workflow in right
   now"*, because no on-disk artifact carries that while the run is live.

---

## 1. Where the files are

```
<home>/.claude/projects/<slug>/
  <sessionId>.jsonl                                  <- main transcript
  <sessionId>/
    subagents/
      agent-<id>.jsonl                               <- plain Task children
      agent-<id>.meta.json
      workflows/
        wf_<runId>/
          journal.jsonl                              <- the memoization ledger
          agent-<id>.jsonl                           <- workflow children
          agent-<id>.meta.json
    workflows/
      wf_<runId>.json                                <- THE PHASE ARTIFACT
    tool-results/
      <toolUseId>.txt
```

Note the two different `workflows` directories. `sessions.ts` already walks the
first one (`subagents/workflows/wf_<id>/`) in `subagentFiles` and `agentDirs`.
The second one — `<sessionId>/workflows/` — is a **peer of `subagents/`**, is not
touched anywhere in the codebase today, and is where the phase data is.

Corpus counts: 78 `journal.jsonl` files and 78 `<sessionId>/workflows/wf_*.json`
files. One-to-one; `runId` in the JSON equals the `wf_<id>` directory name.

---

## 2. `journal.jsonl`, verbatim

Two record types, and only two. Here are the first two lines of a real journal,
copied byte-for-byte apart from nothing — these values are content hashes and
opaque agent ids, so there is nothing to redact:

```
{"type":"started","key":"v2:2785ede222eaf8a006545c946be52b09462864de8330b8947066fb127efed7c1","agentId":"a5c55524867d2296b"}
{"type":"started","key":"v2:a4da925a81bd6fb691844665b918ebe50bae6b5e82b9966122e725fb673b9945","agentId":"a18b7f490b13fc9ca"}
```

Key sets, measured across two files (28 lines and 733 lines):

| `type`    | keys present                          |
| --------- | ------------------------------------- |
| `started` | `type`, `key`, `agentId`              |
| `result`  | `type`, `key`, `agentId`, `result`    |

* `key` is `v2:` + a 64-hex-character digest. It is a **cache key over the task
  input**, not an identifier of anything a human named. The same `key` appears on
  the `started` line and later on the matching `result` line — that pairing is
  the only structure in the file.
* `agentId` is the same id as in the sibling `agent-<agentId>.jsonl` filename,
  i.e. it joins directly to `AgentFile.agentId` in `server/sessions.ts`.
* `result` is the child's structured output — an arbitrary object (in one sample,
  `{"results": [...], "notes": ...}` where each entry was
  `{"command", "exitCode", "outcome", "detail"}`). Shape is defined by the
  workflow script, not by the runtime.

**What `journal.jsonl` does not have:** no `timestamp`, no `phase`, no
`phaseIndex`, no `toolUseId`, no `label`, no `state`, no `model`, no
`durationMs`. `started` and `result` lines interleave in completion order, so you
can recover a partial ordering of starts and finishes, but not wall-clock times
and not phase boundaries.

This is a resume ledger: on a re-run, a task whose `key` already has a `result`
is skipped. That is the whole purpose of the file.

**Conclusion: nothing about phases can be recovered from `journal.jsonl`.**

---

## 3. `<sessionId>/workflows/wf_<runId>.json` — the real artifact

Top-level keys, from a real 32 KB file (identifying strings replaced):

```
runId            : string    "wf_68d85889-210"        (== the wf_ dir name)
timestamp        : string    ISO-ish date
taskId           : string    "wp8mdbvpv"
script           : string    the workflow source, 4 080 chars here
scriptPath       : string    absolute path to the generated script
result           : object    workflow-defined final payload
agentCount       : number    7
logs             : string[]  e.g. ["[redacted one-line run summary]"]
durationMs       : number    256708
summary          : string    one-line description of the run
workflowName     : string    "[redacted]"
status           : string    "completed" | "failed" | "killed"
startTime        : number    epoch ms, 1784391685756
phases           : object[]  [{ "title": "Replay" }]
defaultModel     : string    "claude-opus-4-8[1m]"
workflowProgress : object[]  <- the useful part
totalTokens      : number    526281
totalToolCalls   : number    52
```

### 3a. `phases` (top level)

An array of `{ title: string, detail?: string }`. Verbatim from a two-phase run:

```json
[{"title":"Play"},{"title":"Verify"}]
```

and with the optional field:

```json
[{"title":"Review","detail":"one agent per image slot, vision-based"}]
```

**Trap: this array is not reliably complete.** In one real run it holds a single
entry (`Review`) while `workflowProgress` proves the run had two phases
(`Review` and `Load`) and agents were attributed to both. Do not treat top-level
`phases` as the phase roster. It is a declaration written by the script author,
not a record of what ran.

### 3b. `workflowProgress` — authoritative

An array with exactly two discriminated row types. Measured across the whole
corpus: 1 584 `workflow_agent` rows and 156 `workflow_phase` rows, no others.

**`workflow_phase` rows** carry exactly `type`, `index`, `title`:

```json
{"type":"workflow_phase","index":1,"title":"Review"}
{"type":"workflow_phase","index":2,"title":"Load"}
```

**`workflow_agent` rows** carry, across the corpus, this key set:

```
type, index, label, phaseIndex, phaseTitle, agentId, model, state,
startedAt, queuedAt, attempt, lastAttemptReason, lastToolName,
lastToolSummary, promptPreview, lastProgressAt, tokens, toolCalls,
durationMs, resultPreview
```

A real row, with the free-text fields cut down and identifying strings replaced:

```json
{
  "type": "workflow_agent",
  "index": 1,
  "label": "[redacted phase-prefixed label, e.g. \"verify:<item>\"]",
  "phaseIndex": 1,
  "phaseTitle": "Replay",
  "agentId": "aba4aaa8607df8133",
  "model": "claude-opus-4-8[1m]",
  "state": "done",
  "startedAt": 1784391685798,
  "queuedAt": 1784391685774,
  "attempt": 1,
  "lastToolName": "StructuredOutput",
  "lastToolSummary": "[redacted]",
  "promptPreview": "[redacted, ~400 chars, ends with a one-character ellipsis]",
  "lastProgressAt": 1784391762855,
  "tokens": 78762,
  "toolCalls": 7,
  "durationMs": 77057,
  "resultPreview": "[redacted, ~400 chars]"
}
```

`state` takes four values, corpus-wide:

| `state`    | count |
| ---------- | ----: |
| `done`     | 1 455 |
| `error`    |    42 |
| `progress` |    33 |
| `start`    |    54 |

`label` is optionally suffixed `" (retry N)"` when `attempt > 1`; `attempt` is
the number, so parse `attempt`, never the label.

### 3c. `workflowProgress` is a snapshot, not an append log

Verified on a killed 89-agent run: 89 `workflow_agent` rows, 89 **distinct**
`index` values. One row per agent, holding that agent's last known state. So the
frozen `start` / `progress` states in a killed run are the runtime's final
observation of agents that never finished — not a history of transitions.

### 3d. Trap: `phaseIndex` is not execution order

In that same killed run, the very first agent row (`index: 1`) has
`phaseIndex: 2, phaseTitle: "Load"`, and agents 2..89 have
`phaseIndex: 1, phaseTitle: "Review"`. The `Load` phase ran *first* and is
numbered *second*. `index` on a phase row is a declaration/registration id, not
a position in time.

If you need phases in the order they ran, order by the minimum `queuedAt` (or
`startedAt`) of the agents attributed to each phase. Do not sort by `index`.

### 3e. What each row ties back to

`agentId`, and nothing else. It is the same opaque id used for
`agent-<agentId>.jsonl`, for `journal.jsonl`'s `agentId`, and for
`AgentFile.agentId` in `server/sessions.ts`. There is **no** `toolUseId` on these
rows, so a phase cannot be tied to a parent tool call directly — only through the
agent.

This matters because `Workflow` is deliberately not in `SPAWN_TOOLS`, so workflow
children never emit `agentSpawn`. `agentId` is the only bridge between a phase
and anything the hub already knows about.

---

## 4. The decisive finding: the file is written once, at the end

If the phase artifact were updated during a run, a polling hub could stream live
phase transitions. It is not. NTFS keeps a creation time, so this is directly
measurable — for each file, compare `CreationTime` and `LastWriteTime` against
`startTime` and `startTime + durationMs` taken from inside the file:

| run          | status    | `startTime` | `startTime+durationMs` | file created | last written |
| ------------ | --------- | ----------- | ---------------------- | ------------ | ------------ |
| 4.3 min run  | completed | 19:21:25.756 | 19:25:42.464          | 19:25:42.461 | 19:25:42.461 |
| 4.7 min run  | killed    | 16:45:24.102 | 16:50:05.820          | 16:50:05.908 | 16:50:05.909 |
| 25.8 min run | completed | 17:44:38.166 | 18:10:26.903          | 18:10:26.900 | 18:10:26.900 |

In every case the file is **created** at the instant the run ends — 4 minutes,
and in one case 26 minutes, after the workflow started — and never modified
again. Creation and last-write are the same millisecond.

Corroborating evidence:

* All 78 files on disk carry a terminal `status`: 69 `completed`, 6 `killed`,
  3 `failed`. Not one is `running` or missing a status. If the file were opened
  at run start, at least one crashed run out of 78 would have left a non-terminal
  file behind.
* The file contains end-of-run-only fields — `durationMs`, `logs`, `result`,
  `totalTokens`, `totalToolCalls` — on every single one of the 78, including all
  6 killed runs.

**There is no live source.** Checked and ruled out:

* The main session transcript does not carry phase records. `workflow_phase`
  matches in 5 of 164 transcripts, and every match inspected was a transcript in
  which an agent had *read* one of these JSON files — the hits are line-numbered
  `Read` tool output, i.e. self-contamination, not native events.
* Workflow child sidecars carry nothing. Every
  `subagents/workflows/wf_*/agent-*.meta.json` on the machine is 48 bytes and
  identical: `{"agentType":"workflow-subagent","spawnDepth":1}`. No `description`,
  no `toolUseId`, no phase. Zero meta files corpus-wide contain the string
  `phase`.

---

## 5. What this means for a `workflowPhase` event

The data supports an event, with one honest limitation stated up front.

**Answerable:**

* the full phase roster of a finished run, with titles;
* which agents belonged to each phase, by `agentId`, joining cleanly to the
  hub's existing agent model;
* per-agent `state`, `attempt` and timing within a phase;
* for a `killed` or `failed` run, which phase was in flight when it died —
  the phase containing the agents left at `start` / `progress`;
* the run's terminal `status`.

**Not answerable, at any cost, from any file on disk:**

* the current phase of a *running* workflow. The artifact does not exist yet.
  A `workflowPhase` event necessarily arrives at, or after, the moment the run
  ends. A consumer must not render it as live progress.

**Cost profile — favourable.** Because the file is written exactly once and never
mutated, an `(mtimeMs, size)` cache means the hub parses each run's JSON at most
once for the process lifetime, and thereafter a sweep costs one `stat` per
session directory. The files are large (32 KB – 1.4 MB, dominated by `script`,
`promptPreview` and `resultPreview`), so a byte cap is still required, and the
existing `MAX_SIDECAR_BYTES` of 64 KiB is far too small to reuse here — it would
silently drop most runs.

---

## Budget

Files opened from the corpus: **9** distinct (2 `journal.jsonl`, 1
`agent-*.meta.json`, 3 `wf_*.json`, plus 3 sampled via bounded `grep -o`).
No file was read beyond what was needed; the largest single read was a 733-line
journal. No unbounded corpus walk was performed — directory listings and
`ripgrep` with `head_limit` did the locating.
