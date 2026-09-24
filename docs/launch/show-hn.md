# Show HN

## Title

Pick one. HN cuts titles at 80 characters; the counts are exact.

1. `Show HN: Roundtable – watch your Claude Code subagents as a pixel-art office` (76)
2. `Show HN: Roundtable – replay any Claude Code session as a pixel-art office` (74)
3. `Show HN: Roundtable – rewind your Claude Code subagents to any second` (69)

(`...subagents work as a pixel-art office` reads slightly better but is 81, one over.)

**Recommendation: 2.** A pixel-art office for Claude Code is not a new idea (Pixel Agents is the
well-known one, and someone will say so within ten minutes). What is less common is *replay*:
any past session, any second, deterministically, plus a GIF of it. Title 2 leads with that and
still says "pixel-art office" for the click.

## URL

Submit the repository: `https://github.com/Kostakurta8/roundtable`. The README opens with the GIF
and a "Try it in your browser" link, so a reader is one click from the demo either way, and HN
readers who want the source (the audience that upvotes a Show HN) land on it directly.

If the browser demo turns out to be the better first impression on the day, submitting
`https://kostakurta8.github.io/roundtable/` is also fine for Show HN, as long as the page links
the source.

## First comment

Post this as the first comment right after submitting. HN renders plain text only: no markdown,
blank lines between paragraphs, `*text*` for italics. Read it once and change anything that no
longer sounds like you.

```text
Hi HN, author here.

I run Claude Code with a lot of subagents, and the main transcript tells you very little about what they are doing. Roundtable reads the JSONL transcripts Claude Code already writes under ~/.claude (the main session and each subagent's file) and replays them as a small pixel-art office. Every subagent is a person: they walk in when spawned, sit at a desk while a tool runs, walk over to report, and leave when they finish. When agents check each other's work you see a green CONFIRMED or red REFUTED bubble.

Try it in the browser, no install (the real app replaying a staged session): https://kostakurta8.github.io/roundtable/

On your own sessions (Node 22.12+): npx https://github.com/Kostakurta8/roundtable/releases/latest/download/roundtable.tgz

How it works:

- A small hub tails each JSONL file by byte offset, parses lines tolerantly, turns them into typed events and sends them to the page over a loopback WebSocket.

- The office is a deterministic simulation painted into a 480x270 buffer. Clicking a second on the timeline rebuilds the room by replaying the same events into the same simulation, not by approximating it. --gif is that same replay rendered into a file; the GIF encoder (palette, frame diffing, LZW) is written out rather than installed, and its tests decode every pixel back.

- It is read-only. The files that read transcripts import no write API, the server binds 127.0.0.1, the WebSocket is gated on Origin (browsers don't apply same-origin rules to WebSockets), it installs no hooks and makes no outbound connections. SECURITY.md also lists what it does not protect against, e.g. any process already running as you can connect to the socket.

- Every agent carries its own token total and a cost estimate from list prices kept in one editable table.

The part I didn't expect was --stats, which reads every transcript on the machine and prints what they say. On mine (1,469 transcripts, 2026-09-18):

- Only 51 sessions spawned subagents, but their 513 children wrote more output tokens than every main transcript on the machine combined (24.7M vs 22.3M).

- If you add up the usage block on every line, you over-report output tokens by 94%. A response with several content blocks is written as several lines, and each one carries usage for the whole response, so you have to deduplicate on message.id. The error is almost all in main transcripts (+195%); subagent files barely do it (+1.9%), which is how a counter that gets it wrong still looks right on the files you spot-check.

- On average a child spent about 46.7k cache-creation tokens before doing any work. 13 of the 513 made no tool call and wrote nothing.

- One hook firing writes two records that share a toolUseID, so counting lines overstates firings by 28%. A hook can also fire without writing anything, so "not in the transcript" doesn't mean "never ran".

Your numbers will differ. That's the reason to run it.

What's rough:

- I have only used it on Windows. macOS and Linux pass CI (unit tests, build, a package smoke test, and a headless-Chromium e2e on Linux that covers the native fs.watch path), but nobody has told me they opened it there. An issue either way helps.

- Cost is an estimate from list prices. It doesn't know your plan or any discounts, and an unknown model turns the figure into a floor (shown as ≥).

- It isn't on npm yet, hence the release URL in the install line.

- One maintainer, no audit.

- If you've seen Pixel Agents: it shows your agents live and can launch them for you. Roundtable only reads files. It is built around replaying any past session to any second, per-agent accounting, --stats, and a GIF of a run (in the app, on the CLI, or from inside Claude Code as /roundtable:gif).

Most of Roundtable was written by Claude Code subagents, which is why I wanted to see them in the first place.

Source (MIT): https://github.com/Kostakurta8/roundtable
```

## Before you post

- The comparison line above says only what Pixel Agents' own README says (live activity tracking,
  and a `+ Agent` button that launches Claude Code). It does not claim Pixel Agents lacks replay,
  because its README doesn't say either way. Try it yourself first so you can answer follow-ups
  from experience, and cut the line if it no longer matches.
- The last line repeats the trailer's closing caption ("built almost entirely by the agents it
  watches"). Keep it only if you are happy to discuss it; it will get replies.
- Don't ask anyone to upvote, and don't post the link in group chats asking for votes. HN detects
  voting rings and will bury the post.
- Stay in the thread for the first two to three hours. See `checklist.md` for prepared answers.
