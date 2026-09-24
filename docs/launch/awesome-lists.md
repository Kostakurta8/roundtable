# Awesome lists and directories

Checked 2026-09-24 by reading each list's README and contribution rules. **Confirmed** means the
list exists and its submission route was read from its own files. **Verify** means it exists but
the route or the fit is unclear. Submit one at a time, starting after launch day: several of these
lists weigh stars and activity, and an entry is easier to accept once the repo has some.

Every entry below is written as a description, not a pitch: most lists ask for exactly that, no
emoji, and no addressing the reader.

---

## 1. hesreallyhim/awesome-claude-code — Confirmed, the main one

<https://github.com/hesreallyhim/awesome-claude-code>

- **Route:** the web issue form only: <https://github.com/hesreallyhim/awesome-claude-code/issues/new?template=recommend-resource.yml>.
  No PRs, and the CONTRIBUTING file says the form cannot be submitted with `gh`. Recommendations
  must be made by a human.
- **Eligibility:** at least 14 days since the first commit plus signs of active development, *or*
  100 stars. Roundtable qualifies on the first (first commit 2026-08-02, active since). One
  resource per submission.
- **Category:** `Observability & Monitoring`. The closest existing entries (CC Harness, seedeep)
  sit at that top level; `Observability & Monitoring > Observability` (claude-esp, OrcaReplay) is
  the alternative.
- **Distinctness:** the form asks you to confirm the resource is distinct from what's listed. It
  already has transcript readers with subagent topology (CC Harness, seedeep), a desktop pet
  (Clawd on Desk) and a menu-bar app with an optional pixel-art view (so-agentbar). Roundtable's
  distinct parts are deterministic replay to any second, GIF export, and `--stats`; the
  description leads with those.

**Form fields**

| Field | Value |
|---|---|
| Display Name | `Roundtable` |
| Category | `Observability & Monitoring` |
| Link | `https://github.com/Kostakurta8/roundtable` |
| Author Name | `Kostakurta8` |
| Author Link | `https://github.com/Kostakurta8` |

**Description** (the form allows 10–500 characters, 1–3 sentences; this is 442):

```text
Reads the JSONL transcripts Claude Code already writes and replays each session as a pixel-art office in the browser, with every subagent as a person who arrives, works at a desk, reports back and leaves. A deterministic timeline rewinds the room to any second, each agent carries its own token and cost total, and sessions export as timelapse GIFs. Read-only and loopback-only, with a --stats report on fan-out across every local transcript.
```

---

## 2. anthropics/claude-plugins-official — Confirmed route, high bar

<https://github.com/anthropics/claude-plugins-official>

- **Route:** the README points third-party plugins to the plugin directory submission form:
  <https://clau.de/plugin-directory-submission>. External plugins "must meet quality and security
  standards for approval".
- **Before submitting:** the three skills run
  `npx -y https://github.com/Kostakurta8/roundtable/releases/latest/download/roundtable.tgz`, i.e.
  whatever the *latest* release is, fetched at run time. A security reviewer may prefer a pinned,
  versioned tarball URL. Decide that before you submit, not during review.
- **One-liner to use:**

```text
Roundtable: /roundtable:gif renders the session you are in as a timelapse GIF of a pixel-art office, /roundtable:watch opens a live, rewindable, read-only view of your subagents, and /roundtable:stats reports what your local transcripts say about your fan-out.
```

---

## 3. ccplugins/awesome-claude-code-plugins — Confirmed, PRs welcome

<https://github.com/ccplugins/awesome-claude-code-plugins>

- **Route:** pull request. The README says "Contributions are welcome! You can add your favorite
  plugins … or submit your own marketplace."
- **Where:** the `External Marketplaces` table (Marketplace | Description | Install).

```markdown
| [Kostakurta8/roundtable](https://github.com/Kostakurta8/roundtable) | Roundtable: your subagents as a pixel-art office. `/roundtable:gif` renders the current session as a timelapse GIF, `/roundtable:watch` opens the live, rewindable office, `/roundtable:stats` reports on your fan-out. Read-only and local. | `/plugin marketplace add Kostakurta8/roundtable` |
```

---

## 4. rohitg00/awesome-claude-code-toolkit — Confirmed, PRs welcome

<https://github.com/rohitg00/awesome-claude-code-toolkit>

- **Route:** pull request (CONTRIBUTING.md: fork, branch, PR; "Update the README table if adding a
  new item to any category"; "No generated attribution footers in files").
- **Where:** `Companion Apps & GUIs` table (Name | Stars | Description). It already lists another
  pixel-art office (ctrl), so the description leads with replay.

```markdown
| [Roundtable](https://github.com/Kostakurta8/roundtable) | - | Replays Claude Code sessions from their local transcripts as a pixel-art office, one person per subagent. Rewind to any second, per-agent tokens and cost, GIF export, and a `--stats` fan-out report. Read-only. Install: `/plugin marketplace add Kostakurta8/roundtable` |
```

---

## 5. hekmon8/awesome-claude-code-plugins — Confirmed, PRs welcome

<https://github.com/hekmon8/awesome-claude-code-plugins>

- **Route:** "Add your plugin to a marketplace", then "Submit a PR to add it to this list".
- **Where:** `Plugin Marketplaces > Official & Community Marketplaces`, which uses a bold link, the
  repo slug, and sub-bullets.

```markdown
- **[Roundtable](https://github.com/Kostakurta8/roundtable)** - `Kostakurta8/roundtable`
  - `/roundtable:gif`: the current session as a timelapse GIF of a pixel-art office
  - `/roundtable:watch`: the live, rewindable office in the browser
  - `/roundtable:stats`: what your local transcripts say about your fan-out
  - Read-only and local; MIT
```

---

## 6. jqueryscript/awesome-claude-code — Verify

<https://github.com/jqueryscript/awesome-claude-code>

- Exists; its contribution section says "Under Construction". Entries carry star counts and the
  `Usage & Observability` section is mostly projects with hundreds to thousands of stars, so it
  likely wants traction first. Open an issue asking before a PR.

```markdown
- [**Roundtable**](https://github.com/Kostakurta8/roundtable) - (N ⭐) - Replays Claude Code sessions as a pixel-art office with one person per subagent, a rewindable timeline, per-agent token and cost totals, and GIF export.
```

(The star emoji is that list's own format; replace `N` with the current count.)

---

## 7. subinium/awesome-claude-code — Later (1,000+ stars required)

<https://github.com/subinium/awesome-claude-code>

- "Only repositories with **1,000+ stars** are listed." Section: `Monitoring & Analytics`, a table.
  Keep for when the repo gets there.

```markdown
| [Kostakurta8/roundtable](https://github.com/Kostakurta8/roundtable) | ![](https://img.shields.io/github/stars/Kostakurta8/roundtable?style=flat-square&logo=github) | Replays Claude Code sessions as a pixel-art office: rewindable timeline, per-agent tokens and cost, GIF export |
```

---

## 8. Directories that index on their own — Verify after launch

- **claudemarketplaces.com**: its about page says plugin marketplaces "are discovered from
  GitHub repositories with valid marketplace schemas". `.claude-plugin/marketplace.json` passes
  `claude plugin validate`, so check a week after launch whether it appears; there's a feedback
  page if it doesn't.
- **claudepluginhub.com** and **aitmpl.com**: both list plugin marketplaces. How they discover
  them was not checked; look for a submit link.
- **awesomeclaude.ai**: a visual directory of awesome-claude-code. It probably follows list 1, so
  nothing to do separately.

## Not a fit

- **ComposioHQ/awesome-claude-plugins**: contributions add the plugin's *source folder* to their
  repository, not a link. Roundtable's plugin runs the release tarball, so there is nothing
  meaningful to copy in.
- **VoltAgent/awesome-claude-code-subagents**: a collection of subagent prompts, not tools.
