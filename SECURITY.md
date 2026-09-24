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

Releases are tagged (`v0.1.0`, `v0.2.1`); `package.json` names the current one, and
`npx github:Kostakurta8/roundtable` installs whatever `main` is. The only supported version is the
current `main`.

## What it does

**It binds loopback only.** `DEFAULT_HOST` in `server/hub.ts` is `'127.0.0.1'`, and `listen()` is
always called with an explicit host — `server.listen(port, host)`, never a bare port, which would
bind every interface. `host` is overridable through `HubOptions` for tests; the entry point
`server/index.ts` never passes one, so the shipped app cannot reach the network. Port 7411.

**The WebSocket handshake is gated on `Origin`.** Browsers do not apply the same-origin policy to
WebSockets: without a check, any page you happened to have open could open a socket to
`127.0.0.1:7411`, take the session roster and stream your transcripts, silently. `verifyClient` in
`server/hub.ts` rejects the upgrade unless the `Origin` header is one of the loopback origins the
app is actually served from: the dev server's (`http://localhost:5173`, `http://127.0.0.1:5173`,
and the same two on `4173`) and the hub's own, when it is the hub serving the page
(`http://localhost:<port>` and `http://127.0.0.1:<port>`, 7411 by default). The list is built per
server from the port it bound — `allowedOrigins` in `shared/net.ts` — so moving the hub moves the
gate with it. A rejected handshake gets a 401 and the socket is destroyed — no connection, no
roster, no events.

This is why `vite.config.ts` sets `strictPort: true` on both the dev and preview servers. Vite's
default is to move quietly to 5174 when 5173 is busy; that origin is not on the list, so the app
would come up looking entirely normal and never connect. Failing to start is the honest outcome.

**Over HTTP the hub serves the app, and nothing else.** Run from a clone, the HTTP handler answers
every request that is not the WebSocket upgrade with a 404 and a fixed line of text — Vite serves
the page in that setup, and the hub serves nothing at all. Installed from npm there is no Vite, so
the hub serves the built client, and that is the only case in which it reads a file for a request:

- It is opt-in. `startServer` serves files only when it is passed a `clientDir`, which only
  `bin/roundtable.mjs` does, pointing at the package's own `dist/client`. Every other caller —
  `npm start`, `npm run demo`, the whole test suite — leaves it unset and keeps the 404.
- The path is resolved and then checked to be *inside* that directory, and the check is on the
  resolved result rather than the request text, which can spell an escape a dozen ways. Four of
  those spellings, `..` and percent-encoded, are asserted against in `tests/hub.test.ts`.
- `GET` and `HEAD` only; anything else is a 405. The content type comes from a fixed table of
  fourteen extensions, and anything else is `application/octet-stream` with `nosniff`.

**Nothing outbound exists.** There is no `fetch`, no HTTP client, no analytics, no crash reporter
and no update check anywhere in `server/`, `src/` or `shared/`. `node:http` is imported once, in
`server/hub.ts`, for `createServer` — the hub's own listener, not a client. The only socket the
client opens is `WS_URL` in `src/ws.ts`: `ws://127.0.0.1:<port>/ws`, where the port is this
build's default or, when the hub served the page, the port the hub told it in the HTML. That value
is accepted only if it matches `ws://localhost-or-127.0.0.1:<digits>/ws`, so the page cannot be
talked into dialling anywhere else.

The page itself loads nothing from the network either: `index.html` has no font link, no CDN
script and no external image, and its favicon is an inline `data:` URI. The two runtime
dependencies are `chokidar` and `ws`; `react` and `react-dom` are build-time only, compiled into
the bundle.

**The observer spawns one process, on Windows only, and nothing anywhere else.** To name a session
the way you named its Windows Terminal tab, `server/termtabs.ts` runs `powershell.exe` through
`execFile` — no shell, and nothing interpolated into the command — with a fixed script:
`-NoProfile -NonInteractive -ExecutionPolicy Bypass -Command <script>`. The execution-policy flag
applies to that one process, not to the machine. The script uses UI Automation to read two things
from the Windows Terminal window, and only from a window of that class: the **active tab's title**
and the **last 6,000 characters of text on its pane**. The hub matches that text against the
transcripts it already has in memory, keeps the title only when exactly one session matches, and
stores and sends the pane text nowhere. It runs on the roster tick, a few seconds apart, one at a
time, and is abandoned after 4 seconds. On macOS and Linux, `readActiveTab` returns before anything
is spawned. This was added after this section was first written and it said "no processes" for a
while after that; it was not true on Windows in that time.

Beyond that there is no `child_process` import, and no `exec`, `execSync`, `spawn` or `spawnSync`
call, in `server/`, `src/` or `shared/`. The launcher, `bin/roundtable.mjs`, spawns the operating
system's own opener (`cmd /c start`, `open`, `xdg-open`) on the local address it just printed, with
no shell and nothing interpolated; `--no-open` skips it. It is kept out of `server/` deliberately:
the hub reads private transcripts, and a program that reads transcripts should run as little as
possible. The terminal probe is the one thing that breaks that rule, because it has to run for as
long as the hub does.

**The observed root is opened read-only.** `server/sessions.ts` imports exactly three things from
`node:fs` — `readdirSync`, `readFileSync`, `statSync` — plus `homedir` and `join`. There is no
write API in the file to call. `server/tail.ts` opens transcripts with `openSync(filePath, 'r')`
and uses only `readSync`, `statSync` and `closeSync`. `server/hub.ts` imports `statSync` alone.
Nothing under the observed root is created, modified, renamed or deleted, because there is no code
present that could do it.

The root is `~/.claude`, or `$ROUNDTABLE_HOME` when that is set — `claudeRoot()` in
`server/sessions.ts` — or `--root`. The override is what lets `npm run demo` and the e2e suite drive
the whole app from a synthetic tree without ever touching your real sessions.

**`--demo` is the one mode in which the process writes files, and it never writes to a directory
you named.** It stages a synthetic session for the observer to watch. The path is fixed by
`demoRoot()` in `server/cli.ts` to `roundtable-demo-root` under the operating system's temp
directory; `--root` and `$ROUNDTABLE_HOME` are overridden when `--demo` is given, so the stage —
which wipes and recreates the directory it is handed — can never be pointed at a real one. The
writer is `scripts/promo/stage.ts`, bundled into `dist/server/cli.mjs` for the installed binary;
the three files that read your transcripts (`server/sessions.ts`, `server/tail.ts`,
`server/hub.ts`) still import no write API, and that is asserted by the paragraphs above rather
than changed by this one. The staged root is deleted when the process exits. Nothing under
`~/.claude` is read in this mode: the hub is handed the staged directory and only that.

**`--gif` writes exactly one file: the GIF, where `--out` says or as `roundtable-<session>.gif` in
the working directory.** The write is one `writeFileSync` in `makeClip` (`server/cli.ts`); the
reading is done by the same hub as always (`server/clip.ts` starts it with `startServer`), so the
transcripts are read by the code the paragraphs above describe and by nothing else. That hub binds
`127.0.0.1` on a port the operating system picks, is followed by one socket from the same process,
and is stopped before the command returns. `--gif --demo` stages its session in its own directory
under the temp directory (`showcaseRoot()`, the same rule as `--demo`) and deletes it afterwards.

The GIF is the one artefact this project produces that is *meant* to be shared, so what it contains
is stated rather than implied: by default it draws what the session drew — the opening prompt on the
whiteboard, each agent's description over its desk, the first sentence of what agents said or
thought, and the one-line brief drawn along a spawn line — all after the same
`redact()`/`redactProse()` pass the page gets, which has the residual gaps listed below. Tool
targets and status lines are not drawn: the room shows them only for a selected agent, and a clip
selects nobody. `--bare` draws none of that text: the task board is blank,
agents are numbered in order of arrival, and every speech and thought bubble is replaced by `...`.
The caption strip under the room carries only the elapsed time, the agent count, the token total and
the project's address. The command prints a reminder to look before posting whenever the clip is not
`--bare`.

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

**The model's own prose goes through a narrower rule.** `agentText` and `thinking` are redacted by
`redactProse()` in the same file, which shares those patterns and runs all of them except MySQL's
glued `-p<password>`. That one has to match "`-p` then a run of non-space", which is precise over a
one-line command and destructive over paragraphs: the `\bmysql\b` gate that makes it safe on a tool
target means almost nothing across a page of reasoning, and `find . -print` in an explanation would
come out as `find . -p***`. The command it exists for is already masked where it enters as a tool
`target`. For the same reason `redactProse()` leaves a value that is plainly a placeholder —
`<YOUR_TOKEN>`, `$SERVICE_KEY`, `${cfg.password}` — exactly as the model wrote it. Neither lane is
truncated: the feed renders them in full on purpose.

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

**Redaction is pattern-matching.** It runs on every field that carries text — tool targets,
tool-result error text, user messages, and the model's own `agentText` and `thinking` — but it can
only catch what it can recognise. A bare literal inside an `insert into … values (…)` looks like
every other string; a credential written the way JSON writes it, `"password": "hunter2"`, is not
matched by the `key=value` rule, because that rule needs the separator to follow the key directly;
a connection string like `DATABASE_URL=postgres://user:s3cret@host/db` carries its password past a
key that is not credential-named; and the MySQL `-p<password>` form is deliberately not applied to
the two prose lanes (see above), so a `mysql -phunter2` an agent quotes back inside a sentence
stays as written. Treat redaction as a courtesy that removes the common accidents, never as a
guarantee.

**No authentication on the socket.** The `Origin` header is the whole gate. There is no token, no
handshake secret and no pairing step.

**The port is unauthenticated.** 7411 by default; `--port` or `ROUNDTABLE_PORT` moves it. Anything
else that binds it first simply wins, and the app exits with `EADDRINUSE`; nothing verifies that
the hub a page connects to is *this* hub.

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
