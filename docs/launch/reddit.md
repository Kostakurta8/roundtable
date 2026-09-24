# Reddit

Reddit punishes the same text posted to several subreddits on the same day: the spam filter
notices, and so do the people who read more than one of them. Each draft below is written for its
subreddit. Space them out over a week (see `checklist.md`), and read each subreddit's sidebar and
pinned posts on the day. Rules and flairs change, and the notes below could not be checked against
the live rules pages while this was written.

Upload the GIF to Reddit directly (a GIF or video post with a text body) rather than linking to
GitHub. Native media gets far more views than an outbound link.

---

## r/ClaudeAI

**Flair:** "Built with Claude", or whatever the current showcase flair is. If the rules ask
showcase posts to say how Claude was used, this draft already does.
**Media:** `media/roundtable-timelapse.gif`

**Title**

```text
I built a read-only viewer that replays Claude Code sessions as a pixel-art office, one person per subagent
```

**Body**

```markdown
The main transcript tells you very little about what a fan-out of subagents is actually doing, so I
built something that shows it.

Roundtable reads the JSONL transcripts Claude Code already writes under `~/.claude` and replays them
as a small office. Every subagent is a person: they walk in when spawned, work at a desk while a
tool runs, walk over to report, and leave when they are done. When agents check each other's work
you get a green CONFIRMED or red REFUTED bubble.

What you can do with it:

- **See who is working, who is waiting, and who is spending.** Every agent carries its own token
  total (cache included) and a cost estimate from list prices.
- **Rewind to any second.** The simulation is deterministic, so clicking the timeline rebuilds the
  room exactly as it stood, for any session on your machine.
- **Make a GIF of a run.** The Share button in the app, `--gif` on the command line, or
  `/roundtable:gif` from inside Claude Code (it's also a plugin). One switch strips your prompts and
  agent names first.
- **`--stats`** reads every transcript you have and reports things like how much of your output
  subagents write. On my machine, summing usage line by line over-reported output by 94%.

**How Claude was used:** most of the code was written by Claude Code subagents, which is the reason
I wanted to watch them in the first place.

**Privacy:** it is read-only and local. It never writes to `~/.claude`, installs no hooks, calls no
API, and opens no outbound connection. `SECURITY.md` names the file and mechanism for each claim.

- Try it in the browser, no install: https://kostakurta8.github.io/roundtable/
- Run it on your sessions (Node 22.12+):
  `npx https://github.com/Kostakurta8/roundtable/releases/latest/download/roundtable.tgz`
- Source (MIT): https://github.com/Kostakurta8/roundtable

I have only used it on Windows. If you try it on macOS or Linux, I'd really like to hear whether it
works.
```

---

## r/ClaudeCode

The subreddit exists (third-party stats put it at roughly 395k members, with flairs including
"Built with Claude" and "Tips & Workflows"). Lead with the findings, which are useful to people who
will never install anything, and let the tool be where they came from.

**Flair:** "Tips & Workflows" if the post leads with the findings; "Built with Claude" otherwise.
**Media:** a screenshot of your own `--stats` output, or `media/roundtable-timelapse.gif`

**Title**

```text
I counted my Claude Code transcripts properly: subagents wrote more output than all my main sessions combined
```

**Body**

```markdown
I've been building a viewer for Claude Code sessions, and the token numbers kept not adding up. So I
wrote a `--stats` command that reads every transcript under `~/.claude` and counts them the way
these files need counting. On my machine (1,469 transcripts):

- **Only 51 sessions spawned subagents, but their 513 children wrote more output tokens than every
  main transcript on the machine combined** (24.7M vs 22.3M). Inside fan-out runs, children wrote
  58% of the output. The transcript you watch live is under half of what a fan-out produces.
- **Summing the usage block on every line over-reports output by 94%.** A response with several
  content blocks is written as several lines, each carrying usage for the whole response.
  Deduplicate on `message.id`. The error is almost all in main transcripts (+195%) and barely there
  in subagent files (+1.9%), so a tool that gets this wrong can look right on the files you
  spot-check.
- **On average, a child spends about 46.7k cache-creation tokens before it does anything.** The median child
  made 65 tool calls over about 21 minutes; 13 of 513 made no tool call and wrote nothing.
- **One hook firing writes two records** (`hook_success` and `hook_additional_context`, sharing a
  `toolUseID`), so counting lines overstates firings by 28%. A hook can also fire without writing
  anything, so a hook missing from your transcripts is not proof it never ran.

Your numbers will be different. To get them (read-only, nothing leaves your machine):

    npx https://github.com/Kostakurta8/roundtable/releases/latest/download/roundtable.tgz --stats

It's part of Roundtable, which replays sessions as a pixel-art office with one person per subagent,
a timeline you can rewind, and a GIF export. There's a no-install browser demo at
https://kostakurta8.github.io/roundtable/ and the source is at
https://github.com/Kostakurta8/roundtable. Also installable as a plugin:
`/plugin marketplace add Kostakurta8/roundtable`.

Curious what other people's ratios look like, especially if you run a lot of workflows.
```

---

## r/programming

**Recommendation: don't post the tool here.** r/programming is hostile to self-promotion and to
"I built X" posts, and a lot of its regulars are tired of LLM tooling in general. A project link is
likely to be removed or buried, and it can cost goodwill.

If the dev.to article does well elsewhere, it *might* fit as a link post, because its interesting
part is a data-format trap rather than a product. Only do it if the current rules allow articles by
their own author, and don't link the repo in the title or a comment unless asked.

**Title (for the article, if you post it at all)**

```text
Summing the usage field in Claude Code's transcripts over-counts output by 94%, and why
```

---

## r/SideProject

Friendly to self-promotion; people there want the story and what's next.

**Media:** `media/roundtable-timelapse.gif`

**Title**

```text
Roundtable: my Claude Code subagents as a pixel-art office you can rewind and turn into GIFs
```

**Body**

```markdown
I run Claude Code with lots of subagents and couldn't see what they were doing, so I built an
office for them.

**What it does:** it reads the transcripts Claude Code already writes and replays each session as a
480×270 pixel-art office. Every subagent is a person who walks in, works at a desk, reports back
and leaves. You can rewind to any second (the simulation is deterministic), see each agent's
tokens and cost estimate, and export a session as a GIF from the app, the command line or inside
Claude Code.

**What I learned building it:** the transcripts are easy to miscount. Summing usage per line
over-reported my output by 94%, and my subagents turned out to have written more output than all of
my main sessions combined. So there's a `--stats` command that counts it properly.

**Stack:** TypeScript, a small Node hub that tails the JSONL files and serves a React page over a
loopback WebSocket, and a hand-rolled GIF encoder. Two runtime dependencies (`chokidar`, `ws`).
Read-only, local, MIT.

**What's next:** publishing to npm, and hearing from anyone on macOS or Linux (I've only used it on
Windows; CI passes on all three).

- No-install demo: https://kostakurta8.github.io/roundtable/
- Source: https://github.com/Kostakurta8/roundtable

Feedback welcome, especially on the first minute: is it clear what you're looking at?
```

---

## r/pixelart

**Read this first.** Pixel-art communities are strongly against AI-generated art, and undisclosed
AI involvement gets posts removed and accounts banned. The trailer's closing caption says
Roundtable was "built almost entirely by the agents it watches". If Claude wrote the sprite
strings, either say so plainly in the post or don't post here. Only post if you can describe how
the art was made accurately, and fill in the bracketed line below truthfully.

The honest angle is the constraint, not the product: every sprite is rows of characters in
TypeScript, one character per pixel, drawn into a 480×270 buffer with a locked palette and no image
files at all.

**Flair:** whatever the subreddit uses for original work (check the sidebar).
**Media:** a clean crop of the room from `media/screenshot-night.png` or `media/screenshot-day.png`
at an integer scale, plus the timelapse GIF in a comment if allowed.

**Title**

```text
A tiny office for AI agents, 480×270, where every sprite is a grid of characters in source code
```

**Body**

```markdown
This is the room from a tool I made that visualizes coding agents at work: each agent is a person
who walks in, takes a desk, walks over to report, and leaves.

Some constraints I set myself:

- One 480×270 canvas, scaled up with `image-rendering: pixelated`. No image files anywhere; every
  sprite is written as rows of characters, one character per pixel, mapped onto a locked palette.
- Seven reserved characters in the character sprites stand for skin, hair, shirt and trousers (plus
  their shadows) and are filled in at draw time, so one body becomes twelve different people.
- Day and night are the same room; switching themes eases through a dusk rather than cutting.

[How the sprites were made: say who drew them, and whether any were written by an AI.]

Happy to take critique on the furniture and the walk cycle.
```

---

## Optional: r/webdev, "Showoff Saturday"

r/webdev has allowed project posts on Saturdays under a "Showoff Saturday" flair (check that it
still does). Angle: the engineering, not Claude: a deterministic simulation drawn into a 480×270
canvas, a GIF encoder written from scratch, and a WebSocket that is gated on `Origin` because
browsers don't apply the same-origin policy to WebSockets. Reuse the r/SideProject body with the
"Stack" paragraph moved to the top.
