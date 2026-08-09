# Security

Roundtable reads your private Claude Code transcripts. Everything about its threat model follows
from that one sentence, so this file states what it does, what it does not do, and — at the end —
what it deliberately does *not* protect against.

Every claim below names the file and the mechanism, so you can check it rather than believe it.

## Reporting a vulnerability

Do not open a public issue.

- **E-mail** — <169452104+Kostakurta8@users.noreply.github.com>
- or GitHub's private vulnerability reporting, from the **Security** tab of the repository.

Please include what an attacker would have to already have (a page open in the browser, a process
on the machine, write access to a directory) — that is usually the difference between a finding and
a documented trade-off. This is a spare-time project with one maintainer: expect an acknowledgement
rather than a same-day fix, and assume nothing is embargoed forever.

## Supported versions

There has never been a release, and there are no tags. The only supported version is the current
`main`. `package.json` says `0.1.0`; see `CHANGELOG.md`.

## What it does

**It binds loopback only.** `DEFAULT_HOST` in `server/hub.ts` is `'127.0.0.1'`, and `listen()` is
always called with an explicit host — `server.listen(port, host)`, never a bare port, which would
bind every interface. `host` is overridable through `HubOptions` for tests; the entry point
`server/index.ts` never passes one, so the shipped app cannot reach the network. Port 7411.

**The WebSocket handshake is gated on `Origin`.** Browsers do not apply the same-origin policy to
WebSockets: without a check, any page you happened to have open could open a socket to
`127.0.0.1:7411`, take the session roster and stream your transcripts, silently. `verifyClient` in
`server/hub.ts` rejects the upgrade unless the `Origin` header is one of four loopback dev origins
(`http://localhost:5173`, `http://127.0.0.1:5173`, and the same two on `4173`). A rejected
handshake gets a 401 and the socket is destroyed — no connection, no roster, no events.

This is why `vite.config.ts` sets `strictPort: true` on both the dev and preview servers. Vite's
default is to move quietly to 5174 when 5173 is busy; that origin is not on the list, so the app
would come up looking entirely normal and never connect. Failing to start is the honest outcome.

**Nothing is served over HTTP.** The hub's HTTP handler answers every request that is not the
WebSocket upgrade with a 404 and a fixed line of text. There is no static file handler, no path
routing, and so no route that can be walked out of.

**Nothing outbound exists.** There is no `fetch`, no HTTP client, no analytics, no crash reporter
and no update check anywhere in `server/`, `src/` or `shared/`. `node:http` is imported once, in
`server/hub.ts`, for `createServer` — the hub's own listener, not a client. The only socket the
client opens is `WS_URL` in `src/ws.ts`, which is the literal `ws://127.0.0.1:7411/ws`.

The page itself loads nothing from the network either: `index.html` has no font link, no CDN
script and no external image, and its favicon is an inline `data:` URI. The four runtime
dependencies are `chokidar`, `ws`, `react` and `react-dom`.

**No processes are spawned.** There is no `child_process` import, and no `exec`, `execSync`,
`spawn` or `spawnSync` call, in `server/`, `src/` or `shared/`.

**The observed root is opened read-only.** `server/sessions.ts` imports exactly three things from
`node:fs` — `readdirSync`, `readFileSync`, `statSync` — plus `homedir` and `join`. There is no
write API in the file to call. `server/tail.ts` opens transcripts with `openSync(filePath, 'r')`
and uses only `readSync`, `statSync` and `closeSync`. `server/hub.ts` imports `statSync` alone.
Nothing under the observed root is created, modified, renamed or deleted, because there is no code
present that could do it.

The root is `~/.claude`, or `$ROUNDTABLE_HOME` when that is set — `claudeRoot()` in
`server/sessions.ts`. The override is what lets `npm run demo` and the e2e suite drive the whole
app from a synthetic tree without ever touching your real sessions.

**A client cannot name a path.** The only command that takes an argument is
`{"cmd":"follow","sessionId":"…"}`. Before anything happens, the id is looked up with
`findSession`, which is `listSessions(root).find((s) => s.sessionId === sessionId)` — a match
against the sessions actually discovered on disk. An id that does not match is ignored, and the
file path used afterwards is the one *discovery* produced, never the client's string. No part of a
client message is ever concatenated into a path. Malformed JSON, unknown commands and unknown ids
are all ignored rather than answered, which also keeps the socket alive.

**Some secrets are stripped before broadcast — read the next paragraph for which.** `redact()` in
`server/normalize.ts` replaces the value in `key=value` pairs whose key looks like a credential
(`password`, `api_key`, `access_token`, `client_secret`, …), `Authorization: Bearer …` and
`Basic …` headers, MySQL's glued `-p<password>`, and token shapes that are recognisable on sight
(`sk-ant-`, `sk-proj-`, `gh[pousr]_`, `AKIA`, `xox[abposr]-`, `npm_`). It is applied at three call
sites: the tool `target` — a `Bash` command line, a SQL statement, a page-evaluate body — the error
text of a failed `tool_result`, and the text of a `userMessage`. That is not decoration: in the
corpus this was built against, 5 of 2 291 error results carried a plaintext password, every one of
them a Python traceback re-printing the `connect(…, password='…')` line that raised.

## Known residual risks

These are deliberate. They are written down rather than hidden, because a security file that only
lists strengths is not a security file.

**Any local process can connect.** The `Origin` gate allows a *missing* `Origin` header:

```ts
const originAllowed = (origin: string | undefined): boolean =>
  origin === undefined || ALLOWED_ORIGINS.has(origin);
```

Only browsers send `Origin`, so its absence means no web page is behind the request — a CLI, a
test, the app's own tooling. The consequence is exact and worth stating plainly: **a web page you
visit cannot read your transcripts, but any program already running as you on this machine can**.
It connects to `127.0.0.1:7411`, receives the session roster in the `hello` frame, follows a
session and streams it.

The reasoning for accepting this is that such a program can already read `~/.claude` directly —
same user, same filesystem, no permission it does not have. The hub would not be handing it access
it lacked, only a more convenient shape of it. The cost of the alternative is real: a shared secret
would have to reach the page somehow, and every mechanism for that is either another file on the
same filesystem or a query parameter in a URL that ends up in browser history.

It is still an increase in convenience for an attacker, and if your threat model includes hostile
software running as your own user, do not leave the hub up.

**Redaction is pattern-matching, and it does not cover every field.** It runs on tool targets,
tool-result error text, and user message text. It does **not** run on the model's own prose:
`agentText` and `thinking` events carry their text through verbatim, so a secret a model repeats
back inside an explanation — quoting a config file it just read, reasoning out loud about a key —
crosses the socket and appears in the feed unchanged. Even in the fields it does cover it can only
catch what it can recognise: a bare literal inside an `insert into … values (…)` looks like every
other string. Treat redaction as a courtesy that removes the common accidents, never as a
guarantee.

**No authentication on the socket.** The `Origin` header is the whole gate. There is no token, no
handshake secret and no pairing step.

**The port is fixed and unauthenticated.** 7411 is hardcoded in `server/index.ts`. Anything else
that binds it first simply wins, and the app exits with `EADDRINUSE`; nothing verifies that the hub
a page connects to is *this* hub.

**Transcript content is rendered as it comes.** The events carry text written by models and by
tools. It is rendered as text by React — which escapes it — and never as HTML, but no other
assumption is made about it.

**Everything in the roster is offered.** `hello` lists every session discovered under the root, not
only the one you are watching, and any connected client may follow any of them. There is no
per-session permission.

**Not audited.** One maintainer, no third-party review, no dependency-scanning workflow in CI.

## Out of scope

The observer never writes to the observed root, never talks to the Anthropic API, and never sends
anything off the machine, so it cannot leak a session by acting on one. Reports about what *Claude
Code itself* writes into `~/.claude` belong with Claude Code, not here — Roundtable only reads what
is already on disk.
