---
title: What 1,469 Claude Code transcripts taught me about subagents
published: false
description: Subagents wrote more output than all my main sessions combined, and the obvious way to count tokens over-reports by 94%. What the JSONL files say, and how to count them.
tags: ai, claude, opensource, productivity
cover_image: https://raw.githubusercontent.com/Kostakurta8/roundtable/main/media/social-preview.png
---

<!--
Publishing notes (delete this block before publishing):
- dev.to crops cover images to 1000×420; the social preview is 1280×640, so check the crop in the
  editor preview. The title text sits on the left and should survive.
- Every number below is from the author's machine on 2026-09-18 (the README's example run). If you
  rerun `--stats` before publishing, replace them all at once so they stay consistent.
- The code block in "The per-line trap" was run against a synthetic transcript and prints
  `per line: 1300  deduplicated: 500  over-count: 160.0%` for three lines of one response plus a
  second response and a truncated last line.
-->

I use Claude Code with a lot of subagents. On my machine, a run that fans out spawns seven of them
at the median, and the main transcript I'm watching shows a list of `Task` calls and, eventually, a
summary. It says very little about what the children actually did.

So I built a viewer for it, [Roundtable](https://github.com/Kostakurta8/roundtable), which replays
sessions as a small pixel-art office with one person per agent. To put a token count on each person
I had to read the JSONL transcripts carefully, and the numbers kept disagreeing with what I
expected. Eventually I wrote a command that counts them properly and ran it across every transcript
on my machine: 1,469 sessions and 513 subagents.

Here's what they said. Your numbers will be different, and the last section shows how to get them.

## Where the files are

Claude Code writes one JSONL file per session, plus one per subagent:

```
~/.claude/projects/<project>/
  <session>.jsonl                  the main transcript
  <session>/subagents/
    agent-<id>.jsonl               a Task subagent
    agent-<id>.meta.json
    workflows/wf_<run>/
      agent-<id>.jsonl             a subagent spawned by a workflow
      journal.jsonl                not an agent
```

Two of these trip people up. Workflow children live one directory deeper than Task children, so a
walk that only looks at `subagents/*.jsonl` misses them. And `journal.jsonl` sits right next to
them but isn't an agent at all: it's a ledger of the workflow's cached results, with no timestamps
and no usage. Count it as a child and you'll have one phantom agent per workflow run.

## 1. Most of the output isn't in the transcript you watch

```
1,469 session transcripts, 51 of them spawned subagents
513 children  (327 task, 186 workflow)  median 7 per run

children wrote 58.4% of the output of the runs that spawned them
across every session on this machine, children are 52.6% of all output
  (24,694,800 vs 22,269,746 written in main transcripts)
```

Only 51 of my 1,469 sessions spawned subagents. Those 51 runs produced 513 children, and **the
children wrote more output tokens than every main transcript on the machine put together**: 24.7M
against 22.3M, counting the 51 fan-out runs' own main transcripts on the other side.

Inside the runs that fanned out, children wrote 58% of the output. The conversation you're
watching live is under half of what a fan-out run produces.

This is the most practical finding here. If you think of your usage in terms of the conversations
you had, and you use subagents, you're looking at the smaller half. "I barely use my quota" can
simply mean "I don't spawn subagents".

## 2. The per-line trap: +94%

This is the one that cost me the most time.

```
usage blocks: 130,017 lines describe 63,025 responses
  summing per line reports 90,961,379 output tokens against 46,964,546 real (+93.7%)
  and it is not evenly spread: main transcripts +195.4%, subagent transcripts +1.9%
```

A single assistant response isn't written as one line. A turn with some thinking, a paragraph of
text and a few tool calls is written as several lines, one per content block, and they all share
one `message.id`. Each of those lines carries a `usage` object for the response. Add up
`output_tokens` across every line and you count the same response several times.

Across my machine, 130,017 lines with usage described 63,025 actual responses, and the naive sum
came out at 91.0M output tokens against 47.0M real ones.

The split is the treacherous part. Main transcripts are over-counted by 195%, nearly 3x. Subagent
transcripts, which mostly write one line per response, are over-counted by 1.9%. So if you write a
token counter, spot-check it against a few subagent files and it looks right, and it's wrong by 3x
on exactly the transcripts you care about.

The fix is to deduplicate on `message.id` and keep the **last** line for each id, since that's the
one whose usage is complete:

```js
// node usage.mjs ~/.claude/projects/<project>/<session>.jsonl
import { readFileSync } from 'node:fs';

const lastUsage = new Map(); // message.id -> the usage on the last line written for it
let perLine = 0;

for (const line of readFileSync(process.argv[2], 'utf8').split('\n')) {
  if (!line) continue;
  let row;
  try { row = JSON.parse(line); } catch { continue; } // a live file can end mid-line
  if (row.type !== 'assistant' || !row.message?.usage) continue;
  perLine += row.message.usage.output_tokens ?? 0;
  lastUsage.set(row.message.id, row.message.usage);
}

let real = 0;
for (const u of lastUsage.values()) real += u.output_tokens ?? 0;
console.log(`per line: ${perLine}  deduplicated: ${real}  over-count: ${((perLine / real - 1) * 100).toFixed(1)}%`);
```

If you're streaming a live file rather than reading a finished one, there's one more wrinkle: a
response can be interrupted and resume later under the same id. In one of my transcripts, two
responses came back 270 and 389 responses after they started. A live counter has to remember how
much of each id it has already reported, for quite a long way back, or it bills the resumed
response twice.

## 3. A subagent isn't free to start

```
cold start: 46,669 cache-creation tokens per child, before it does any work
median child: 65 tool calls over 1,286 s
13 of 513 children (2.5%) made no tool call and wrote nothing
407 cache-read tokens per output token
```

The cold-start line is the cache-creation tokens on each child's **first** response, averaged:
about 46.7k tokens of context written into the cache before the child has done anything. That's a
fixed entry fee per child, whatever the task.

The median child then made 65 tool calls over about 21 minutes, so for real work the entry fee is
small next to the rest. But 13 of the 513 children made no tool call and wrote nothing at all.
They paid the entry fee and produced nothing.

And the last line is a reminder of where the tokens actually go: 407 tokens read from cache for
every token of output. Output is the small number. Context is the big one.

What this suggests: a subagent is worth it when the task is big enough to amortise ~47k tokens of
setup, and a child that ends up doing nothing still pays it.

## 4. Hooks: two records per firing, and silence isn't proof

```
hooks: 8,831 records = 6,898 firings (+28% if you count lines)
  UserPromptSubmit         3,506
  SessionStart:startup     1,469
  SessionStart             1,469
  PostToolUse:Edit         250
  PostToolUse:Write        191
  SessionStart:compact     9
  PostToolUse:Bash         4
```

When a hook fires, the transcript can get two records for it: `hook_success`, with the command, the
exit code and the duration, and `hook_additional_context`, with whatever it injected. They share a
`toolUseID`. Count lines and you over-report your own guardrails by about a third; deduplicate on
the pair and 8,831 records become 6,898 firings.

The subtler point is what's *missing*. A hook can fire and write no record at all. So a hook that
doesn't appear in this list is one of three things: never registered, never fired, or fired without
writing anything, and the transcript can't tell you which. If you're relying on a hook as a
guardrail, its absence from your transcripts is a hint, not proof it's broken.

## How to count these files

If you're writing anything that reads Claude Code transcripts:

1. **Deduplicate usage on `message.id`**, keeping the last line for each id.
2. **Walk both subagent directories**, `subagents/` and `subagents/workflows/wf_*/`, and skip
   `journal.jsonl`.
3. **Deduplicate hook records** on their shared `toolUseID`.
4. **Expect a partial last line** on a file that's still being written, and skip it rather than
   failing.
5. **Treat a missing hook as unknown**, not as "never ran".

## Seeing it instead of counting it

The numbers came out of building [Roundtable](https://github.com/Kostakurta8/roundtable), which
replays a session as an office. Every subagent is a person: they walk in when they're spawned, work
at a desk while a tool runs, walk over to report, and leave when they're done. When agents check
each other's work you see a green `CONFIRMED` or a red `REFUTED`. Each agent carries its own token
total, counted the way this post describes, and a cost estimate.

![a nine-minute Claude Code session with 24 subagents, played as a timelapse of the office](https://raw.githubusercontent.com/Kostakurta8/roundtable/main/media/roundtable-timelapse.gif)

*A staged session: the transcripts are synthetic so no private work appears, but every frame is the
real app replaying them.*

The simulation is deterministic, so you can click any second on the timeline and the room rebuilds
exactly as it stood. And any session can be turned into a GIF like the one above, from a Share
button in the app, from the command line, or from inside Claude Code.

It only reads your transcripts: it never writes to `~/.claude`, installs no hooks, calls no API and
makes no outbound connection.

- **Try it in your browser**, nothing to install: https://kostakurta8.github.io/roundtable/
- **Your own numbers** (Node 22.12+, read-only, prints and exits):

  ```
  npx https://github.com/Kostakurta8/roundtable/releases/latest/download/roundtable.tgz --stats
  ```

- **The office**, on your latest session: the same command without `--stats`.
- **From inside Claude Code**: `/plugin marketplace add Kostakurta8/roundtable`, then
  `/plugin install roundtable@roundtable`, and `/roundtable:stats`.

I'd like to know how other people's numbers compare, especially the child share and the cold
start. If you run it, post your ratios in the comments.
