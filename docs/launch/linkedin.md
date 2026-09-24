# LinkedIn

**Media:** upload `media/roundtable-trailer.mp4` as a native video (52 s, captions burned in, no
narration, so it works muted in the feed). If you use `media/roundtable-timelapse.gif` instead,
check in the preview that it animates before you post.

**Link:** put the links in the first comment rather than the post body. Posts with outbound links
tend to get less reach there, and the people who want the link will open the comments.

## Post

```text
Most of the code in my latest side project was written by AI subagents. I had no good way to see what they were doing, so the project became a way to watch them.

Roundtable replays Claude Code sessions as a small pixel-art office. Every subagent is a person: they walk in when they're spawned, work at a desk while a tool runs, walk over to report back, and leave when they're done. When one agent checks another's work, you see the verdict: green for confirmed, red for refuted.

It reads the files Claude Code already writes on your machine. It never writes to them, never calls an API, and never sends anything off the machine.

The part that changed how I work was counting. Across the 1,469 sessions on my machine:

→ Only 51 spawned subagents, yet those subagents wrote more output than all 1,469 main sessions put together.
→ Adding up the token usage line by line over-counted output by 94%, because a single response is written across several lines and each one repeats its usage.
→ On average, each subagent wrote about 46,700 tokens of context into the cache before doing any work.

If you're budgeting for agent-heavy workflows, the transcript you watch live is under half the story.

It's open source (MIT), and there's a demo that runs in the browser with nothing to install. Links in the first comment.
```

## First comment

```text
Try it in your browser: https://kostakurta8.github.io/roundtable/
Source: https://github.com/Kostakurta8/roundtable

To run the same count on your own machine (read-only, local):
npx https://github.com/Kostakurta8/roundtable/releases/latest/download/roundtable.tgz --stats
```

## Notes

- "those subagents wrote more output than all 1,469 main sessions put together" is the README line
  "children are 52.6% of all output (24,694,800 vs 22,269,746 written in main transcripts)": all
  subagent output against the output of every main transcript, the 51 fan-out runs' own main
  transcripts included. If you shorten it, keep it true.
- The 46,700 figure is the average cache-creation tokens on a child's first response
  (`cold start` in `--stats`), not a dollar amount. Don't convert it to money in the post: the
  price depends on the model and on your plan.
- Numbers are from the author's machine on 2026-09-18.
