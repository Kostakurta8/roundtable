# Product Hunt

Launches run from 12:01 AM Pacific for 24 hours. Schedule it in advance from the submission form
so it goes live at the start of the day, and plan to be around for the first few hours.

## Name

Roundtable

## Tagline (60 characters max)

Pick one; counts are exact.

1. `Watch your Claude Code subagents work in a pixel-art office` (59)
2. `Replay any Claude Code session as a pixel-art office` (52)
3. `See, rewind and GIF your Claude Code subagents` (46)

**Recommendation: 1.** Product Hunt's audience is broader than HN's, and "watch" plus "pixel-art
office" is the part that makes someone stop scrolling. The rewind and GIF go in the description.

## Description (260 characters max)

```text
Roundtable replays your Claude Code sessions as a pixel-art office. Every subagent is a person who walks in, works at a desk, reports back and leaves. Rewind any second, see each agent's tokens and cost, and turn a session into a GIF. Read-only, local, MIT.
```
(257)

## Links

- Website: `https://kostakurta8.github.io/roundtable/` (the no-install demo is the best first click)
- GitHub: `https://github.com/Kostakurta8/roundtable`
- Pricing: Free (open source, MIT)

## Topics

Developer Tools, Artificial Intelligence, Open Source, GitHub

## Gallery, in this order

Product Hunt's form states its current image size; at the time of writing the usual advice is
1270×760. The existing media is 16:9 or close to it, so expect letterboxing or re-export at that
size.

1. **`media/roundtable-timelapse.gif`**: the hook. A whole fan-out arriving, working and leaving in
   under half a minute. (Check that the form accepts an animated GIF in the first slot; if not,
   use the social card first and this second.)
2. **`media/screenshot-day.png`**: the whole app: roster, room, feed and the timeline.
3. **A screenshot of the Share dialog** with the live preview and the "Hide transcript text"
   switch. *To make once the Share button lands.*
4. **A screenshot of `--stats` output** in a terminal, cropped to the first block and the usage
   line. *To make: run it on your machine; use your numbers, not the README's.*
5. **`media/screenshot-night.png`**: the same room at night.
6. **`media/social-preview.png`**: the summary card, with the browser demo's address as its call
   to action.
7. **`media/screenshot-share.png`**: the Share dialog — a session rendered to a GIF in the tab,
   with the "hide transcript text" switch and the look-before-you-post note.

**Video:** Product Hunt takes a YouTube link, not a file. Upload `media/roundtable-trailer.mp4`
(52 s, captions burned in) to YouTube and paste the link.

**Thumbnail (240×240):** *to make.* A square crop of the office with two or three people at desks,
as a short looping GIF if the form allows it. It is the only image most people will see in the
list, so it has to read at that size: crop tight, don't shrink the whole room.

## Maker's first comment

```text
Hi Product Hunt, I'm the maker.

I use Claude Code with a lot of subagents, and the main conversation tells you very little about what they're actually doing. So I built an office for them.

Roundtable reads the transcript files Claude Code already writes on your machine and replays each session as a small pixel-art office. Every subagent is a person: they walk in when they're spawned, work at a desk while a tool runs, walk over to report, and leave when they're done. When agents check each other's work you see a green CONFIRMED or a red REFUTED.

What you can do with it:
• See who's working, who's waiting, and who's spending: every agent has its own token total and cost estimate.
• Rewind to any second: the simulation is deterministic, so clicking the timeline rebuilds the room exactly as it stood.
• Turn a session into a GIF from the Share button, the command line, or inside Claude Code. One switch removes your prompts and agent names first.
• Run --stats to see what your transcripts say. On my machine, subagents wrote more output than all my main sessions combined.

It's read-only and local: it never writes to your Claude Code files, never calls an API, and never sends anything off your machine.

Honest caveats: I've only used it on Windows (macOS and Linux pass CI), the cost is an estimate from list prices, and it isn't on npm yet.

The demo on the website runs in your browser with nothing to install. I'd love to hear what's confusing in the first minute, and if you make a GIF of one of your own runs, please share it.
```
