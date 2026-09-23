---
name: gif
description: Turn this Claude Code session into a looping timelapse GIF of the Roundtable pixel office — every subagent as a person who walks in, works, reports and leaves. Writes one file in the working directory.
argument-hint: "[--bare] [--seconds N] [--full] [--out file.gif]"
allowed-tools: Bash(npx *)
disable-model-invocation: true
---

Roundtable just rendered this session into a GIF. Its report:

!`npx -y https://github.com/Kostakurta8/roundtable/releases/latest/download/roundtable.tgz --gif --session ${CLAUDE_SESSION_ID} $ARGUMENTS`

Tell the user, briefly:

- the full path of the file it wrote, so they can open it, and how long the clip is;
- if the report says the clip shows the session's task, agent names and speech: that they should look at it before posting it anywhere, and that `/roundtable:gif --bare` draws the same run with none of that text. If the report does not say so, the clip is already bare or staged — do not add the warning;
- if the file landed inside a git repository, that it is untracked and probably should not be committed.

If the report is an error instead, show it as it is and suggest `/roundtable:gif --demo`, which renders a staged session and needs nothing of theirs. Do not run anything else.
