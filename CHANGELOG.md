# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

> Nothing is published to a registry — `package.json` is `private` by design, and the project is
> distributed by clone. The entry below describes everything on `main`, written from `git log`
> rather than from memory.

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

[0.1.0]: https://github.com/Kostakurta8/roundtable/releases/tag/v0.1.0
