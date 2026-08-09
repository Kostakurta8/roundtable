<!--
Thanks for the patch. Nothing here is bureaucracy for its own sake — each line is something that
has actually gone wrong in this repo at least once.
-->

## What this changes

<!-- One paragraph. If it fixes an issue, `Fixes #123`. -->

## Why

<!--
The reasoning, not the diff — the diff is right there. This project comments *why* rather than
*what*, and a PR description is where that starts.
-->

## Checks

- [ ] `npx tsc --noEmit` is clean
- [ ] `npm test` passes
- [ ] I ran it — `npm start` against a real session, or `npm run demo` — and looked at the result

## If this touches the room

- [ ] I ran `npm run room` and **opened the PNGs in `.preview/`** before blessing anything
- [ ] `npm run room:bless` was run only after looking, and the baseline change is intentional
- [ ] Anything under `src/office/pixel/` still obeys `docs/pixel-contract.md`

<!--
`tests/room.test.ts` hashes the rendered room against a committed baseline. Blessing a hash without
looking at the picture turns a regression into the thing the next change is measured against, which
is the one failure mode that check cannot catch on its own.
-->

## If this touches the hub, the watcher, or paths

- [ ] I have said which OS I ran it on
- [ ] Any new path comparison goes through `samePath` (Windows compares case-insensitively)
- [ ] Nothing new writes to, or under, the observed root

<!--
The observer is read-only over somebody's private transcripts. That is a property, not a habit:
`server/sessions.ts` imports read APIs only, and `server/tail.ts` opens files with mode `'r'`.
A PR that adds a write there needs to say so in the description in as many words.
-->

## Ran on

<!-- e.g. Windows 11 / Node v24.14.1. The app has only ever been used on Windows; if you are on
     macOS or Linux, say so — that is new information regardless of whether it worked. -->
