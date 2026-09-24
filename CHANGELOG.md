# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

> Installable with `npx github:Kostakurta8/roundtable` since 0.2.0; the npm name `claude-roundtable`
> is reserved for the same thing and not yet published. Entries are written from `git log` rather
> than from memory.

## [Unreleased]

### Added

**A browser demo that needs no install.** `npm run build:pages` builds the real app against a
recording of the real hub — `scripts/recordDemo.ts` stages the `--demo` room, follows the shipped hub
over a socket, and writes down every frame it sends — and `.github/workflows/pages.yml` publishes it
to `https://kostakurta8.github.io/roundtable/`. It plays at 2.5× and loops; a banner says it is a
staged replay, carries the install command and a copy button, and the status pill reads `REPLAY`.
The demo lives behind its own entry file, so the bundle people install contains none of it. The
page has Open Graph and Twitter card tags, so a pasted link unfurls with the social card.

**Share as GIF, from the app.** A Share button in the top bar, `G`, or the palette renders the
session on screen as a GIF in a Web Worker, previews it, and lets the browser save it. It is the
`--gif` renderer, moved to `src/clip/` so both halves import it: the same events make the same
bytes. Length, busiest stretch or whole session, and "Hide transcript text" are options; nothing is
uploaded. The encoder is also twice as fast, with identical output.

**A first-visit guide.** A card over the room says what a person, a desk, a bubble, a walk and the
door mean, and that the timeline rewinds. It does not block the room, collapses to a one-row legend
on a short stage, is remembered once dismissed, and is back from the Help sheet or the palette.

**Pointing at a person** shows a card beside the cursor: who it is, what it is doing, its tokens,
cost and age.

### Changed

**The room fills its stage.** The camera rests on a frame computed from the desks the session has
drawn, wall to floor, as large as the stage allows, and eases as the room grows; `Home`, ⌂, Escape
and a double-click return to it. The roster becomes a strip under the room whenever that draws the
room larger than a column beside it. At 1440×900 people went from 26×39 to 39×59 pixels on screen.

**The feed reads as a conversation.** Runs of two or more system lines fold into one expandable
line — "spawned 6 subagents · 6 prompts ▸" — with nothing dropped; search opens the folds.

**Every agent's name is legible in both themes.** Names keep their hue and take their lightness
from the theme; the worst contrast went from 1.24:1 to 6.45:1 at night, 3.90:1 to 4.93:1 by day.

**A phone-width layout.** The room gets nearly half the height, session tabs scroll sideways, the
top bar keeps the session's name, and the timeline takes two rows.

**The activity strip fills its width** at any session length and names the second under the pointer.

**The README** leads with the demo and the one install line; the screenshots and the social card
show the app as it now is. `docs/launch/` holds launch drafts, and `.github/workflows/publish-npm.yml`
publishes to npm on a release once an `NPM_TOKEN` secret exists — until then it skips, green.

### Fixed

**Two demos no longer delete each other.** `--demo`, `--gif --demo` and `npm run demo` each stage
into a fresh directory under the temp directory, made for that run, instead of one fixed path. With
the fixed path a second demo wiped the first one's room, and whichever exited first deleted the
directory the other's hub was still serving. `--root` is still ignored with `--demo`, the hub still
watches the staged directory by polling, and exiting — `Ctrl+C` and `SIGTERM` included — deletes
that run's directory and nothing else.

## [0.3.1] — 2026-09-23

### Added

**A Claude Code plugin.** `/plugin marketplace add Kostakurta8/roundtable`, then `/plugin install
roundtable@roundtable`, gives three commands inside a session: `/roundtable:gif` renders the session
you are in (the skill passes `${CLAUDE_SESSION_ID}`, so it is never whichever session wrote last),
`/roundtable:watch` starts the live office in the background, and `/roundtable:stats` prints the
`--stats` report. They run the packed release tarball, so the plugin needs no build of its own. The
plugin lives in `plugin/`, the marketplace manifest in `.claude-plugin/`; both pass
`claude plugin validate`.

### Fixed

**`--demo` now wins over `--session`**, as it already did over `--root`. The staged directory holds
one session, so an id meant for a real one could only fail to match — which is exactly what
`/roundtable:gif --demo` did, because the plugin always sends the id of the session it runs in.

## [0.3.0] — 2026-09-23

### Added

**`--gif`: any session, as a looping timelapse of the office, in one file.** `npx
github:Kostakurta8/roundtable --gif` reads your latest session (or `--session <id>`), replays it
through the same engine and the same scene the page draws with, and writes `roundtable-<session>.gif`
where you ran it — usually in a few seconds. Every silence is cut to a beat before anything is sped
up, so the clip is the part where agents actually arrive, work, hand things back and leave; a session
too long for the clip becomes its busiest stretch unless `--full` asks for all of it, and the clock
on the wall keeps the real time so the cuts are visible. `--bare` draws the same run with no text
from the transcripts at all, and the command says so whenever a clip is not bare. `--demo --gif`
renders a staged fan-out — six scouts, eight builders, a verifier on every change, one refuted and
fixed — which is the timelapse now at the top of the README.

Nothing new reads the transcripts: `server/clip.ts` starts the hub itself on a loopback port the
operating system picks, follows the session with one socket exactly as the page does, and stops it
before returning. The frames come from `scripts/pixpreview.ts`'s software canvas, the one the
visual-regression tests hash; the encoder (`server/gif.ts`) is written out rather than installed —
one palette cut from every frame, each frame cropped to what changed, LZW — and its tests decode
every pixel back with a decoder written from the format's description. `SECURITY.md` says what a
clip does and does not show.

### Changed

**The README's install line is the packed build attached to the release.** `npx
github:Kostakurta8/roundtable` clones the repository, installs the dev dependencies and builds the
client on the user's machine — 38 to 99 seconds cold, measured from an empty npm cache. `npx
https://github.com/Kostakurta8/roundtable/releases/latest/download/roundtable.tgz` installs the
built package in about three, and `npm i -g` of the same link gives a `roundtable` command.
`.github/workflows/release-asset.yml` runs the package smoke test on every published release and
attaches the tarball under that stable name. The `github:` line still works and is still described.

### Fixed

**Replaying a finished session read whole put every agent's name at the end.** The hub stamps a
sidecar's `agentSeen` with the moment it read the file, not the moment the agent started, so a clip
ordered by timestamps showed nameless people arriving and their names turning up after they had left
— and stretched a nine-minute session to six days. The clip pins each `agentSeen` to its agent's
first transcript line. The live page is unaffected: it orders by arrival, which is right for a
stream.

## [0.2.3] — 2026-09-22

### Fixed

**A line the watcher never reports is read anyway.** The main transcript was the one file the hub
read on a single, best-effort signal. chokidar arms itself asynchronously, so a line appended
between the catch-up read and the poller taking its baseline is folded into that baseline: the
change event never fires, and the one sweep on `ready` has already run. Nothing re-read the file
after that — the rescan swept the subagent directories every 500ms and skipped the parent, and the
live sweep returns early for a session it is already streaming — so the line was not late, it was
lost, until the session happened to write again. For a session whose last line landed in that
window, for ever. The rescan now reads the main transcript on the same tick, which is the floor
every other file in the session already had; a read that finds nothing costs one `statSync`. This
is also what had been failing CI intermittently since August, on whichever matrix leg was busiest.

## [0.2.2] — 2026-09-18

### Added

**`--stats`.** One command that reads every transcript under `--root` and prints what they say about
this machine's own fan-out — how much output is written inside subagents, what a child costs in
cache-creation tokens before it does any work, how many children produced nothing at all, and which
hooks have ever fired — then exits without starting a server. It exists because three counting
mistakes in these files are easy to make and hard to notice: a multi-block response repeats its
complete usage object on every line it is written to (deduplicate on `message.id`, or over-report
output by about 3x, almost entirely in main transcripts); `subagents/` holds a workflow `journal.jsonl`
that is not an agent; and one hook firing writes two records sharing a `toolUseID`. The report names
all three rather than quietly correcting them, and says plainly that a hook absent from the list may
have fired without writing a record. `server/stats.ts`, twelve tests, and a package smoke step that
runs it against an empty root.

## [0.2.1] — 2026-09-01

### Added

**`--demo`.** The first run is the product's front door, and on a machine that has never run Claude
Code it opened on an empty office with no explanation. `claude-roundtable --demo` stages the same
synthetic session `npm run demo` did from a clone — under the temp directory, deleted on exit,
`--root` overridden so it can never be pointed at a real directory — and the installed binary
serves it. The package smoke test runs it.

**The first screen says where it is looking.** The empty state names the directory being watched,
says that the first session to start there appears on its own, and gives the demo command.

**OFFLINE says what to do.** With a session on screen and the socket down, the top bar said
`OFFLINE` and nothing else said anything. A note above the panel now names the socket being
retried and the terminal that has to be started again.

### Fixed

**The feed came up blank.** Every replayed card mounted with the entrance fade, sixty at once, and
Chromium ran them at a fraction of real time: at +1.5s the cards in view still had `opacity: 0`.
Only a card that arrives while the panel is on screen animates now; history lands already there.

**The session-tab strip covered the roster's header**, and the inspector, when two sessions were
running. Both now start below it.

**A finished session read `main · talking` for ever**, and a subagent whose transcript had not
changed since lunch pulsed `thinking…`. Panels now print a phase as a claim about the present,
expiring it on the same windows the tab strip already used.

**A truncated replay called itself "whole session"** on the strip and "waiting for a task…" on the
whiteboard. Both now say that earlier history was not replayed.

**Focus rings** on session tabs, agent cards, tool rows, monologue summaries and the picker's rows,
which had the browser's default or none; a narrow dock clipped the search placeholder mid-word; a
session with three busy seconds drew three columns as one block across the whole strip.

### Changed

**The shell.** The frame around the room was a default: frosted, shadowed cards on an untinted
ground, eight-point type. It is now flat paper in daylight and warm charcoal at night, every neutral
tinted toward the room, hairlines instead of shadows, the roster as a column down the stage's left
edge instead of a card floating over a corner of the office (which also removes the dead band of
letterbox the inset left beside it), the feed as a list under hairlines with verdicts and the
human's turns as washes rather than boxes, and the type one step larger throughout. Every colour is
a token; the room is untouched.

## [0.2.0] — 2026-08-28

### Added

**`npx claude-roundtable`.** Installing was a clone, an `npm install` and an `npm start`, which is
three more steps than anyone spends on a tool they have not tried yet. The package is now packable
and runnable with one command that serves the app and opens it. (This entry first said "published";
it was not, and still is not on the npm registry — the one-command install is the release tarball.) The hub serves the built client over its own port when
it is given one — `bin/roundtable.mjs` points it at the package's `dist/client` — so a packaged
install runs one process instead of two, and needs no Vite.

**A command line.** `--port` (or `ROUNDTABLE_PORT`), `--root`, `--no-open`, `--help`, `--version`.
An unrecognised option is reported rather than ignored: the two things worth getting wrong here are
the port and the root, and both fail the same silent way — an app that starts, looks perfectly
normal, and observes nothing.

**The hub tells the page which port to dial.** A published bundle is built on one machine and run on
another, possibly with `ROUNDTABLE_PORT` set, so it cannot carry the answer the way the dev build
does. The hub writes the socket URL into the HTML it serves, and the client prefers it over its
build-time default — but only if it is a loopback `ws://` address, so the global cannot be used to
point the page somewhere else.

### Changed

**The Origin gate names the hub's own port.** Served by the hub, the page's origin is
`http://localhost:<hub port>`, which is none of the dev server's origins — a gate that did not name
it would refuse the only page a packaged install has, and that failure is indistinguishable from a
crashed server. `allowedOrigins` is now built per server from the port it actually bound.

**`react` and `react-dom` are build-time dependencies.** They are compiled into the bundle, so an
install pulls two packages (`chokidar`, `ws`) instead of four.

### Security

The static handler is the first code in the project that reads a file because a request asked it to,
in a process that can read the user's entire home directory. It is opt-in, `GET`/`HEAD` only, serves
from a fixed table of content types with `nosniff`, and resolves every path before checking that it
is inside the client directory — the check is on the resolved result, never the request text.
`SECURITY.md` says so in full, and four spellings of `..` are asserted against in the test suite.

## [0.1.0] — 2026-08-09

The first release. The project went from an empty directory to a working observer between
2026-08-02 and 2026-08-05, and spent 2026-08-09 being audited and corrected.

### Added

**Continuous integration.** The type check, the unit suite and the production build run on Ubuntu,
macOS and Windows across Node 22 and 24. Until now nothing had ever been run off Windows, and two
paths in the hub branch on the platform. The Playwright job is manual-only and says so where it is
defined: it has never been observed to pass on a runner, and a green result there would be the
first data point rather than a confirmation.

**A session is named by what it was asked to do.** The CLI names a session after its working
directory plus a counter, so several started in the same place were indistinguishable — six tabs
differing by two hex characters. Each now carries its opening human turn, in the tab, the picker
and the command palette, and in the accessible name where CSS clips the text.

**File edits say how big they were.** `+12 −3` beside the path, in the tools stream, on the message
card and in the inspector. An unknown count renders as nothing rather than as zero: a `Write` over
an existing file removes an unknown number of lines, and saying `0` would be a claim nobody checked.

**The room has a ceiling.** The buffer is 16:9 and the stage usually is not, and the strip above the
room was painted in the two near-blacks the art draws outlines with — so it read as a broken
viewport rather than as a room. It is now drawn: real buffer rows where the room has them, and a
ceiling above that.

### Added — earlier

**The read pipeline.** A byte-offset JSONL tailer that survives a file being truncated or replaced
under it; a tolerant line parser that steps over a line it cannot read rather than stopping; and a
normalizer that turns Claude Code's transcript records into a typed event stream. Session and
subagent discovery walks `~/.claude`, including the agents a `Workflow` call spawns a directory
deeper than the rest.

**The hub.** A WebSocket server on loopback that watches the transcripts of the session a client
asked to follow, derives cross-file events like *that subagent finished*, and broadcasts them.
Backlog replay for a late follower, with a wire-level notice when the backlog had to drop events
rather than pretending it did not. Roster sweeps pick up sessions that start while the observer is
open.

**The client.** A store that folds the event stream into one state per session, a chat feed, an
agents panel and a tools panel — the same events, in words.

**The office.** A deterministic behaviour engine, an event-to-office mapping, and a pixel renderer
that paints the room into a 480×270 buffer. Agents walk in, take a desk, think, run tools, walk
over to each other to report, and leave through the door when they finish — giving up the chair so
somebody waiting outside can have it. Because the simulation is deterministic, the timeline rewinds
the room to any second by replay rather than by approximation.

**Accounting.** Per-agent token totals with cache included, and a cost estimate from published list
prices, with a `≥` marking a session containing a model that has no rate card.

**More than one session at a time.** Every running session gets a tab; switching between them keeps
each room running in the background.

**A help overlay**, so the app stops needing a document to be believed.

**A demo mode.** `npm run demo` stages a synthetic transcript root in the temp directory, points the
observer at it, and drives it through the same watcher, parser, socket and store a real session
uses — so a clean clone is not an empty office. It never reads your own `~/.claude`.

**A desktop shortcut** (Windows): `npm run desktop` generates the icon from geometry rather than
checking in a binary, and writes a *Claude Agents* `.lnk` that opens both halves and a session.

**Media and licence.** A recorded trailer with burned-in captions and a generated `.srt`, a demo
GIF, and day and night screenshots — every frame the real application driven by real events, with
only the transcript *content* synthetic. MIT licence, to make "open source" true rather than
implied.

### Fixed

- The CLI's own markup was rendered as the human's own words. A feed card read
  `<local-command-caveat>…`, `<command-name>/effort</command-name>` and so on, verbatim. The
  wrappers are taken off a closed list of nine tag names the CLI writes — a prompt containing
  `<div>`, or a pasted code block, is returned untouched, and classification still runs on the raw
  text so a card cannot lose its label and reappear as something a person typed.
- A skill's preamble was read as the human. It is the one piece of machinery on the `user` lane
  wearing no marker tag, so `Base directory for this skill: …` became a prompt, and on this machine
  it became the label of six sessions.
- The turn count stopped at a thousand. The feed caps its rows there and tracked the overflow
  separately; the count rendered the cap.
- Line counts for a file edit joined to the wrong call. The join was positional — the agent's newest
  still-open call — which is true only while the normalizer emits the edit immediately after the
  call it came from. The event carries the `tool_use` id now.
- Anything written to a tool call between its start and its result was discarded when it returned.
- The redactor corrupted ordinary prose. `mysql -p<password>` glues the secret to the flag, so the
  pattern has to be `-p` followed by non-space — which also matched `find . -print`. It now runs
  only on text that mentions MySQL.
- The whiteboard stopped mid-word at about twenty characters, wrapped against a width six pixels
  narrower than the board it was drawn on, and dropped everything after a word too long for a line.
- `src/chat/MessageCard.tsx` contained two raw NUL bytes, which made Git treat it as binary and
  made ripgrep skip it — every content search in the repository silently missed one source file.
- The parent link on the wire ignored the one field that states it. A depth-2 agent whose parent's
  spawn line had been trimmed re-rooted at `main`, drawing the wrong tree.
- Workflow-spawned agents could never be reported finished, so they never left the room.
- Agents that had finished hours ago stood around the office instead of going home.
- The session picker could not be clicked — with eleven other bugs found in the same pass.
- Seven office bugs, two of which froze the room outright.
- Subagents were not attached when a session was reached through the picker.
- A non-finite tick could reach the engine; the overflow pod grid mislaid actors; a confront's
  verdict was not carried on the actor's own state.
- A think bubble and a say bubble on the same actor overlapped instead of sitting side by side.
- Layout collapse at narrow widths, and a ceiling gradient that banded.
- The tool log collapsed non-adjacent chip runs, which reordered it; file edits produced one chip
  each rather than a tally.
- Roster agent names matched as substrings when targeting a confront, so one agent's name inside
  another's picked the wrong person.
- E2E fixture roots looked days old, so every agent left before the assertions ran.

### Security

- The WebSocket handshake is gated on `Origin`: browsers do not apply the same-origin policy to
  WebSockets, so without it any page the user had open could have read their transcripts. See
  `SECURITY.md`, which also documents the residual risks.
- A personal e-mail address and machine-specific paths were scrubbed out of the repository.
- User prose crossing the socket is now redacted and length-capped like every other lane. It was
  neither.

### Removed

- Tailwind, which was installed, configured and injected for three directives and zero utility
  classes. Its Preflight was doing real work, so the reset it was providing is now written out
  explicitly for the elements the shell actually uses.
- Three genuinely unreferenced symbols. Four others on the same list turned out to be published
  exports of the binding pixel contract with live preview entries — unbuilt API, not dead code —
  and were left alone.

[0.2.3]: https://github.com/Kostakurta8/roundtable/releases/tag/v0.2.3
[0.2.2]: https://github.com/Kostakurta8/roundtable/releases/tag/v0.2.2
[0.2.1]: https://github.com/Kostakurta8/roundtable/releases/tag/v0.2.1
[0.2.0]: https://github.com/Kostakurta8/roundtable/releases/tag/v0.2.0
[0.1.0]: https://github.com/Kostakurta8/roundtable/releases/tag/v0.1.0
