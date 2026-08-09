# Contributing

Roundtable is a read-only observer for Claude Code. Issues and pull requests are welcome. This file
is what you need to run it, change it, and be reasonably sure you have not broken it.

## Running it

Node **22.12 or newer** (`engines` in `package.json`). No other toolchain, no global installs.

```
npm install
npm start
```

That starts both halves — the hub (`tsx server/index.ts`) and Vite — and opens
`http://localhost:5173`. `npm run dev` is the same without opening a browser.

If you do not have Claude Code, or nothing is running:

```
npm run demo
```

This is the one to develop against. It stages a synthetic transcript root under your temp
directory, points the observer at it with `ROUNDTABLE_HOME`, and writes lines into it on a
schedule — so agents arrive, work, report, hand down verdicts and go home, through the same
watcher, parser, normalizer, socket and store a real session uses. It never reads your own
`~/.claude`, so nothing private of yours can end up in a screenshot on an issue. `Ctrl+C` deletes
the staged root.

Both halves are singletons on fixed ports: **7411** for the hub, **5173** for Vite. Two copies
cannot run at once, and Vite is deliberately `strictPort` — see `SECURITY.md` for why moving to
5174 would break the app in the least debuggable way available.

## The checks

```
npx tsc --noEmit     # types — strict, and must be clean
npm test             # the unit suite — ~15s, binds nothing
npm run e2e          # Playwright — needs 7411 and 5173 free, so stop the app first
```

`npm test` starts hubs, but each on an ephemeral port against a per-test `ROUNDTABLE_HOME`, so it
is safe to run with the app up. `npm run e2e` is not: it boots its own Vite on 5173 and an
in-process hub on 7411. Stop the app by **port**, not by killing the `npm` wrapper — the two
servers outlive it.

CI (`.github/workflows/ci.yml`) runs the typecheck, the unit tests and `npx vite build` on Ubuntu,
macOS and Windows, on Node 22 and 24. The e2e job is manual-only and has never been observed to
pass on a runner; the workflow says so in a comment.

All three must be green before a PR is reviewed. `main` should never be red — if you find it that
way, say so in an issue rather than building on top of it.

## The room, and the rule about blessing

The office is a 480×270 pixel buffer painted by hand. `tests/room.test.ts` hashes a rendered room
against a committed baseline in `tests/room.baseline.json`, which is what catches a change nobody
meant to make.

```
npm run room                    # renders .preview/room-{day,night,spawn}.png
npm run room:bless              # rewrites the baseline
npx tsx scripts/sheet.ts all    # per-module contact sheets, for one sprite at a time
```

When `room.test.ts` fails and the change was intended, the loop is:

1. `npm run room`
2. **Open the PNGs and look at them.**
3. `npm run room:bless`

Step 2 is not optional and it is not a formality. Three of the defects found in the pixel renderer
were found by rendering it and looking — eleven broken font glyphs, `drawArt` painting transparent
pixels under a tint, a light pool one pixel wider on one side. Every one was invisible in the
source and obvious in a PNG. A hash cannot tell you the room is *good*; it can only tell you it
changed. Blessing without looking turns a regression into the thing the next change is measured
against, and the check silently stops being worth anything from that commit onward.

`npm run room` renders three shots on purpose: day, night, and one at t = 0.8s, because the spawn
edge lives about two seconds and is invisible in the other two.

**`docs/pixel-contract.md` is binding for everything under `src/office/pixel/`.** It fixes the
canvas size and the palette, and it says which modules may import which — each pixel module imports
only `./art` and `./preview`, never another pixel module, never React, never the engine, never the
store. That constraint is what lets those files be worked on independently; a PR that breaks it
will be asked to change even if it renders correctly.

## Things that will get a PR sent back

**Writing anything under the observed root.** The observer never writes to `~/.claude`. That is not
a habit, it is a property people are asked to trust: `server/sessions.ts` imports read APIs only and
`server/tail.ts` opens files with mode `'r'`. If you have a reason to change that, say so in the PR
description in as many words, because it changes what `SECURITY.md` can claim.

**Anything outbound.** No `fetch`, no HTTP client, no telemetry, no update check, no `child_process`.
Same reason.

**Breaking replay.** Rewinding the timeline rebuilds the room by replaying the same events into the
same simulation, so it is exact rather than approximate. Anything in `src/office/` that reads the
wall clock, uses unseeded randomness, or keeps state the event stream does not carry breaks that,
and `tests/replay.test.ts` is where it will show up.

**A path comparison that assumes case sensitivity.** Use `samePath` in `server/hub.ts`. Windows
compares paths case-insensitively and chokidar echoes back whatever casing the filesystem reports.

## Style

There is no linter and no formatter config; match the file you are in. Two conventions are worth
naming because they are consistent throughout and easy to miss:

- **Comments explain _why_, not _what_.** The code says what it does. The comments in this repo
  say what went wrong the last time it was done differently — with the measurement, where there
  was one. That is deliberate, it is most of what makes the codebase readable, and new comments
  are expected to do the same. If a comment restates the line below it, delete it.
- **TypeScript is strict, and `any` is not used.** Data crossing a JSON boundary is narrowed at
  that boundary and typed everywhere after it.

`shared/` holds the wire types and is the only directory both halves import. It must stay pure —
no `process`, no `import.meta` — because the server side is loaded by `tsx` and the client side is
bundled for a browser, and each of those chokes on the other's globals.

Commit subjects follow the existing log: `feat:`, `fix:` or `docs:` and then a sentence, lowercase,
describing the change in terms of what a user would notice.

## Platforms

The app has only ever been used on Windows. CI runs the test suite on all three platforms, which is
a much weaker claim than "it works on macOS" — the unit tests force the watcher into polling mode,
so the `fs.watch` path that macOS and Linux use by default is exactly what the matrix does not
exercise. If you run it on macOS or Linux, an issue reporting what happened is useful whether it
worked or not.

`npm run desktop` is Windows-only: it generates an `.ico` and writes a `.lnk` through
`WScript.Shell`. There is no equivalent for the other two.
