---
name: stats
description: Read every Claude Code transcript on this machine and report what they say about your own fan-out — how much of your output is written inside subagents, what a child costs before it starts, which hooks have ever fired. Read-only.
allowed-tools: Bash(npx *)
disable-model-invocation: true
---

Roundtable read every transcript under `~/.claude`. Its report, exactly as printed:

!`npx -y https://github.com/Kostakurta8/roundtable/releases/latest/download/roundtable.tgz --stats`

Show the report to the user unchanged, in a code block. Then add at most three short observations about *their* numbers — which line is most unusual and what it means for how they use subagents. Keep the report's own caveats (the per-line usage over-count, hooks that fire without writing a record); do not restate them as your own findings. Do not run anything else.
