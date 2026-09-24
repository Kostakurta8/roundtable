# X / Twitter

Every post below fits in 280 characters as X counts them (a link counts as 23). Character counts
are in brackets after each post; delete them before posting.

Media paths are relative to the repo root. X plays GIFs up to 15 MB and MP4s up to 2:20, so all of
these upload as they are.

## Thread (6 posts)

**1/6** · attach `media/roundtable-timelapse.gif`

```text
I wanted to see what my Claude Code subagents were actually doing, so I gave them an office.

Every subagent is a person: walks in when it's spawned, works at a desk while a tool runs, walks over to report, leaves when it's done.

Open source, read-only, runs locally.
```
[268]

**2/6** · attach `media/roundtable-trailer.mp4` (52 s, captions burned in)

```text
It replays the JSONL transcripts Claude Code already writes. The simulation is deterministic, so clicking any second on the timeline rebuilds the room exactly as it stood.

That works for any session on your machine, not just the one running now.
```
[246]

**3/6** · attach `media/screenshot-day.png`

```text
When agents check each other's work, you see it: a green bubble is CONFIRMED, a red one is REFUTED.

Every agent carries its own token total, cache included, and a cost estimate. So you can see who is actually spending.
```
[219]

**4/6** · attach a GIF of one of *your* sessions, made with `--bare` or "Hide transcript text"
(if you don't have one yet, attach `media/roundtable-demo.gif`)

```text
Any session can become a GIF:

- the Share button in the app
- roundtable --gif on the command line
- /roundtable:gif from inside Claude Code

One switch takes your prompts, agent names and speech out of the picture before you post it.
```
[235]

**5/6** · attach a screenshot of your own `roundtable --stats` output (crop to the first block and
the "usage blocks" line)

```text
The surprise was --stats, which reads every transcript on the machine.

On mine: 51 of 1,469 sessions spawned subagents, and those children wrote more output than every main transcript combined.

And summing usage per line over-counts output by 94%. Dedupe on message.id.
```
[271]

**6/6** · no media (links in the last post keep the first one's reach)

```text
Try it in your browser, no install:
https://kostakurta8.github.io/roundtable/

Source, MIT:
https://github.com/Kostakurta8/roundtable

If you make a GIF of one of your runs, post it with #roundtable. I'd like to see what other people's fan-outs look like.
```
[219]

## Single post

Attach `media/roundtable-timelapse.gif`.

```text
My Claude Code subagents, as a pixel-art office. Each one walks in when it's spawned, works at a desk, reports back (CONFIRMED / REFUTED) and leaves.

Rewind any second, or turn a session into a GIF. Read-only, local, MIT.

Try it in your browser: https://kostakurta8.github.io/roundtable/
```
[271]

## Notes

- The 94% and 1,469 figures are from the author's machine on 2026-09-18 (the README's example
  run). If you rerun `--stats` before launch, use your fresh numbers in post 5 and the screenshot.
- If you tag `@AnthropicAI` or `@claudeai`, do it in a reply rather than post 1, where it reads as
  asking for a retweet.
- Reply to quote-posts and to people who post their own GIFs. Those are the posts that spread.
