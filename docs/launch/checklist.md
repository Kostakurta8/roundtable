# Launch checklist

The files next to this one are drafts: `show-hn.md`, `x-thread.md`, `reddit.md`, `linkedin.md`,
`dev-to-article.md`, `product-hunt.md` and `awesome-lists.md`. Read each once and put it in your
own words where it doesn't sound like you. HN and Reddit readers are quick to spot copy that reads
as generated, and a launch post is the one place that costs the most.

Every number in them is from the README's `--stats` run (the author's machine, 2026-09-18). If you
rerun `--stats` for fresh numbers, change all the drafts at once.

## A week before

1. **Land the two features the drafts mention**, the browser demo and the Share button, and cut a
   release afterwards. The install line serves `releases/latest/download/roundtable.tgz`, so until
   a release carries the Share button, "the Share button in the app" is not true for anyone who
   installs.
2. **Check the release from a clean machine** (or an empty npm cache):
   `npx https://github.com/Kostakurta8/roundtable/releases/latest/download/roundtable.tgz --demo`
   should open the office within a few seconds. Check that `release-asset.yml` went green on the
   release.
3. **Check the demo at `https://kostakurta8.github.io/roundtable/`** on a laptop and on a phone. A
   lot of launch traffic arrives on phones from X and Reddit, and the demo is the first thing they
   see.
4. **Decide about npm.** `claude-roundtable` is free on the registry today (a request for it returns
   404), which also means anyone could take it. Publishing is one secret away: add `NPM_TOKEN`
   under Settings → Secrets and variables → Actions, then run *Publish to npm* from the Actions tab
   with the release tag. If it publishes, check `npx claude-roundtable --demo` yourself, and only
   then change the README and the drafts to the short line.
5. **Make the missing assets:** a terminal screenshot of your own `--stats` output; a 240×240
   thumbnail for Product Hunt; the trailer uploaded to YouTube (Product Hunt takes a link, not a
   file). The Share dialog is `media/screenshot-share.png`, and `media/social-preview.png` now points
   at the browser demo — upload it under Settings → Social preview too, because GitHub does not
   read it from the repo.
6. **Try Pixel Agents** (`npx pixel-agents`, or the VS Code extension). It is the pixel-office tool
   people will compare Roundtable to, and you will answer that question better having used it.
7. **Install the plugin fresh** in a Claude Code session: `/plugin marketplace add
   Kostakurta8/roundtable`, `/plugin install roundtable@roundtable`, then `/roundtable:gif --demo`.
8. **If you can get twenty minutes on a Mac or a Linux desktop**, run `--demo` there. "I've now
   seen it run on macOS" is a better answer than any caveat.

## Repository settings

- **Description** (Settings → General, or the gear next to *About*):

  ```text
  Watch your Claude Code subagents work as a pixel-art office. Rewind any second, see per-agent tokens and cost, and turn any session into a GIF. Read-only, local, never calls an API.
  ```

- **Website:** `https://kostakurta8.github.io/roundtable/`
- **Topics:** `claude-code`, `claude`, `anthropic`, `claude-code-plugin`, `subagents`,
  `ai-agents`, `multi-agent`, `observability`, `developer-tools`, `session-replay`,
  `visualization`, `pixel-art`, `token-usage`, `gif`, `jsonl`, `typescript`
- **Social preview:** Settings → General → Social preview → upload `media/social-preview.png`
  (1280×640, the size GitHub asks for). This is the card X, Slack, Discord and LinkedIn show for
  every repo link.
- **Pages:** Settings → Pages → Build and deployment → Source: **GitHub Actions**, so the demo's
  workflow can deploy it.
- **Release:** after the release in step 1, make sure it is marked *Latest*, which is the one the
  sidebar shows and the install URL resolves to. Put the one-line install and the demo link at the
  top of its notes.
- **Pin the repo** on your GitHub profile.
- **Open and pin an issue: "Does it work on macOS or Linux? Tell me either way."** It turns the
  biggest caveat into something people can help with, and gives the reports somewhere to go.
- **Optional:** enable Discussions with a "Show your GIF" thread, so people who make one have
  somewhere to post it besides X.
- **Check the CI badge is green on `main`** before you post anything.

## Launch day and the week after

Times are common advice, not guarantees. The point is not to launch everything at once: each
channel gets your full attention for its first hours.

| When | What |
|---|---|
| Day 1, Tue–Thu, 8–10 AM US Eastern | **Show HN** (`show-hn.md`). Post the first comment immediately. Stay in the thread for 2–3 hours and answer everything, including the unfriendly ones. |
| Day 1, afternoon | **X thread** (`x-thread.md`). Don't mention HN or ask for votes anywhere. |
| Day 1 or 2 | **r/ClaudeCode** (findings first). **LinkedIn**, on a weekday morning in your own time zone. |
| Day 2–3 | **dev.to article**. **r/ClaudeAI**. |
| Day 3–4 | **r/SideProject**. |
| Saturday | **r/webdev Showoff Saturday**, if the rule still exists. |
| Only if you're comfortable with the disclosure | **r/pixelart** (read the warning in `reddit.md` first). |
| Week 2, on its own day | **Product Hunt** (`product-hunt.md`), 12:01 AM Pacific. Don't overlap it with HN. |
| Week 2 onward, one at a time | **Awesome lists** (`awesome-lists.md`), starting with hesreallyhim/awesome-claude-code. |

If the HN post doesn't take off, don't delete and repost the same day. HN allows a repost after a
while if a submission got no attention; wait a week or more and change the title.

## Prepared answers

Short, true answers to what will come up. Link `SECURITY.md` or the README rather than pasting
walls of text.

**"Does it send my transcripts anywhere?"**
No. The server binds `127.0.0.1`, there is no HTTP client, analytics or update check in the code,
and the WebSocket only accepts pages served from localhost, because browsers don't apply the
same-origin policy to WebSockets. `SECURITY.md` names the file behind each claim. Its honest
residual risk: any program already running as you can connect to the socket, which that program
could also do by reading `~/.claude` directly.

**"Will a GIF leak my prompts?"**
By default a clip shows what the session showed: the task, agent names, the first sentence of what
they said. `--bare`, or *Hide transcript text* in the app, draws the same run with none of that
text. Look before you post; the CLI reminds you whenever a clip is not bare.

**"Why pixel art?"**
A fan-out is spatial: who is here, who is waiting for a chair, who is walking over to report,
who has left. A room shows concurrency and waiting at a glance in a way a log doesn't, and a GIF of
it is something people actually share. When you want words, the side panel shows the same events
as a feed, a roster and a tool list.

**"Only tested on Windows?"**
Yes, used by hand only on Windows. CI runs the type check, unit tests, the build and a package
smoke test on macOS, Linux and Windows on Node 22 and 24, plus a headless-Chromium e2e on Linux
with the native file watcher, which is the path macOS and Linux use by default. That's
"compiles and passes", not "someone watched it". Reports either way are welcome (point to the
pinned issue).

**"How accurate is the cost?"**
It's an estimate. Tokens are counted per response, deduplicated on `message.id`, which is where
most tools go wrong. Prices come from one table in `shared/models.ts` (list prices recorded
2026-08), priced per model. It doesn't know your plan: on a subscription it's what the tokens
would cost at list price, not what you paid. Cache writes are priced at a single rate. A model with
no rate card shows `≥`, meaning the figure is a floor.

**"How is this different from Pixel Agents / ccusage / other viewers?"**
Different focus, and say something good about theirs. ccusage reports usage and cost over days,
months and sessions; Roundtable goes inside one session, per agent, and `--stats` looks at the
shape of your fan-out (child share, cold start, hooks). Pixel Agents is a live pixel office that
can launch agents and install hooks; Roundtable only reads files, and is built around replaying
any past session to any second, accounting, and GIFs. Don't claim what another tool can't do unless
you've checked.

**"Did Claude write this?"**
Answer plainly. The trailer already says it was "built almost entirely by the agents it watches",
and the prompts are in `docs/SESSION_PROMPT_*.md`. Say what you reviewed and decided yourself.

**"Why isn't it on npm?"**
It's coming: the publish workflow is ready and waiting on a token. The release tarball is the same
package `npm pack` produces, smoke-tested on every release.

**"Does it work with Codex / Cursor / Gemini?"**
No. It reads Claude Code's transcripts under `~/.claude` only.

**"Does it slow Claude Code down, or need hooks?"**
No. It reads files Claude Code has already written. Nothing is installed into Claude Code unless
you choose the plugin, and the plugin only adds three commands.

**"Can I use it on a remote machine?"**
It binds loopback on purpose and the WebSocket only accepts localhost origins. Untested, but an SSH
tunnel that keeps the page at `http://localhost:7411` should satisfy the gate; a hosted forwarder
with its own domain (Codespaces, ngrok) will not connect.

## Metrics to watch

- **GitHub Insights → Traffic:** views, unique visitors, referring sites and popular content.
  GitHub keeps only the last 14 days, so screenshot it daily during launch week.
- **Installs:** the release asset's download count is the best proxy until npm, since every
  first-time `npx` of the tarball URL fetches it (npx caches, so repeat runs don't count):

  ```
  gh api repos/Kostakurta8/roundtable/releases --jq '.[] | .tag_name as $t | .assets[] | "\($t) \(.name) \(.download_count)"'
  ```

- **npm weekly downloads**, once published.
- **Stars over time** (star-history.com), and which day each jump happened, to learn which channel
  worked.
- **Issues**, especially macOS/Linux reports and first-minute confusion. Answer within a day
  during launch week.
- **GIFs people post** with `#roundtable` or a link to the repo. Reply to every one; these are the
  posts that bring the next visitors. (`#roundtable` is a common word, so also search for the repo
  link and "roundtable claude".)
- **The demo page** has no analytics, and shouldn't get any: a tool whose pitch is "opens no
  outbound connection" loses more trust than it gains from a tracking script. Its visits show up
  as `kostakurta8.github.io` in the repo's referring sites.
