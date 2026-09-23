---
name: watch
description: Open the Roundtable office in the browser — a live, read-only view of this machine's Claude Code sessions, with every subagent as a person at a desk and a timeline you can rewind.
allowed-tools: Bash(npx *)
disable-model-invocation: true
---

Start the Roundtable observer for the user.

Run this with the Bash tool, **in the background** (`run_in_background: true`) — it is a server and does not exit on its own:

```
npx -y https://github.com/Kostakurta8/roundtable/releases/latest/download/roundtable.tgz
```

It serves the office on http://localhost:7411 and opens the browser itself. Wait a few seconds, read its output once, and tell the user:

- the address it printed, and that the tab opens on the most recent session — this one;
- that it only reads `~/.claude`, binds to localhost, and makes no outbound connection;
- that it keeps running in the background until they stop it or end the session.

If the output says port 7411 is already in use, Roundtable is already running: tell them to open http://localhost:7411 and do not start a second copy.
