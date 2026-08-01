# Roundtable Observer MVP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Local read-only web app that renders live Claude Code sessions (main agent + subagents) as an animated office + synced group chat, tailing `~/.claude` transcript JSONL files.

**Architecture:** Node server (chokidar watcher → byte-offset tailer → line parser → normalizer → WebSocket hub) pushes a typed `Event` stream to a Vite/React client that renders two synced views: office simulation (DOM/CSS actors driven by a pure behavior engine) and a chat feed. Spec: `docs/superpowers/specs/2026-08-02-roundtable-observer-design.md`.

**Tech Stack:** Node 20+, TypeScript strict, chokidar, ws, Vite, React 18, Tailwind, vitest, Playwright.

## Global Constraints

- TypeScript `strict: true` everywhere; no `any` except at JSON parse boundaries (immediately narrowed).
- Server binds `127.0.0.1` only, port `7411`; zero external network calls.
- Filesystem access to `~/.claude` is READ-ONLY (open files with read flags; never write/rename there).
- `ROUNDTABLE_HOME` env var overrides `~/.claude` root (tests point it at temp dirs).
- Fixtures are SYNTHETIC lines replicating the schema verified 2026-08-02 (CC v2.1.220) — never commit real transcripts (they contain private data).
- Windows-first: build all paths with `node:path` `join/resolve`; chokidar `usePolling: true` fallback.
- Prettier + ESLint clean on save (user global prefs); code and comments in English.
- Unknown JSONL line types/fields must be IGNORED, never crash the parser (schema drift tolerance).

---

### Task 1: Scaffold + shared Event types + synthetic fixtures

**Files:**
- Create: `package.json`, `tsconfig.json`, `vite.config.ts`, `tailwind.config.js`, `postcss.config.js`, `index.html`, `.gitignore`
- Create: `shared/events.ts`
- Create: `fixtures/main-session.jsonl`, `fixtures/agent-abc123.jsonl`, `fixtures/agent-abc123.meta.json`, `fixtures/NOTES.md`
- Test: `tests/fixtures.test.ts`

**Interfaces:**
- Produces: `shared/events.ts` exporting the `Ev` union used by every later task:

```ts
export type AgentRef = { sessionId: string; agentId: string | 'main' };
export type Ev =
  | { kind: 'sessionSeen'; sessionId: string; cwd: string; live: boolean; ts: number; seq: number }
  | { kind: 'agentSeen'; ref: AgentRef; model?: string; label?: string; ts: number; seq: number }
  | { kind: 'userMessage'; ref: AgentRef; text: string; ts: number; seq: number }
  | { kind: 'agentText'; ref: AgentRef; text: string; ts: number; seq: number }
  | { kind: 'thinking'; ref: AgentRef; text: string; ts: number; seq: number }
  | { kind: 'toolStart'; ref: AgentRef; tool: string; target?: string; toolUseId: string; ts: number; seq: number }
  | { kind: 'toolResult'; ref: AgentRef; toolUseId: string; ok: boolean; ts: number; seq: number }
  | { kind: 'fileEdit'; ref: AgentRef; path: string; ts: number; seq: number }
  | { kind: 'agentSpawn'; ref: AgentRef; childAgentId: string; prompt: string; ts: number; seq: number }
  | { kind: 'usage'; ref: AgentRef; inTok: number; outTok: number; ts: number; seq: number };
```

- [ ] **Step 1: Scaffold project**

```bash
npm create vite@latest . -- --template react-ts
npm i ws chokidar
npm i -D vitest @types/ws tsx tailwindcss postcss autoprefixer @playwright/test
npx tailwindcss init -p
```

Set `"strict": true` in `tsconfig.json`; add scripts to `package.json`:

```json
"scripts": {
  "dev": "concurrently \"tsx server/index.ts\" \"vite\"",
  "test": "vitest run",
  "e2e": "playwright test"
}
```

(add `npm i -D concurrently`). `.gitignore`: `node_modules`, `dist`, `.playwright-mcp`.

- [ ] **Step 2: Write `shared/events.ts`** with the exact union from Interfaces above, plus:

```ts
export const isEv = (x: unknown): x is Ev =>
  !!x && typeof x === 'object' && 'kind' in (x as object) && 'seq' in (x as object);
```

- [ ] **Step 3: Write synthetic fixtures** replicating verified schema. `fixtures/main-session.jsonl` (one line per row, real field names from probe):

```jsonl
{"type":"user","uuid":"u1","parentUuid":null,"sessionId":"fix-sess","timestamp":"2026-08-02T10:00:00.000Z","cwd":"C:\\demo","version":"2.1.220","message":{"role":"user","content":"find the flaky test"}}
{"type":"assistant","uuid":"a1","parentUuid":"u1","sessionId":"fix-sess","timestamp":"2026-08-02T10:00:05.000Z","message":{"role":"assistant","model":"claude-fable-5","content":[{"type":"thinking","thinking":"scheduler.spec mixes timers","signature":"sig"},{"type":"text","text":"Plan: scout then verify."},{"type":"tool_use","id":"tu1","name":"Grep","input":{"pattern":"retryWithBackoff"}}],"usage":{"input_tokens":10,"output_tokens":120,"cache_creation_input_tokens":0,"cache_read_input_tokens":0}}}
{"type":"user","uuid":"u2","parentUuid":"a1","sessionId":"fix-sess","timestamp":"2026-08-02T10:00:09.000Z","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"tu1","content":"11 matches"}]}}
{"type":"assistant","uuid":"a2","parentUuid":"u2","sessionId":"fix-sess","timestamp":"2026-08-02T10:00:15.000Z","message":{"role":"assistant","model":"claude-fable-5","content":[{"type":"tool_use","id":"tu2","name":"Task","input":{"prompt":"scout suites","subagent_type":"Explore"}}],"usage":{"input_tokens":8,"output_tokens":60,"cache_creation_input_tokens":0,"cache_read_input_tokens":0}}}
{"type":"file-history-snapshot","uuid":"fh1","sessionId":"fix-sess","timestamp":"2026-08-02T10:00:16.000Z"}
```

`fixtures/agent-abc123.jsonl`:

```jsonl
{"parentUuid":null,"isSidechain":true,"agentId":"abc123","type":"user","sessionId":"fix-sess","timestamp":"2026-08-02T10:00:16.500Z","cwd":"C:\\demo","version":"2.1.220","message":{"role":"user","content":"scout suites"}}
{"parentUuid":"x","isSidechain":true,"agentId":"abc123","type":"assistant","timestamp":"2026-08-02T10:00:20.000Z","sessionId":"fix-sess","message":{"role":"assistant","model":"claude-sonnet-5","content":[{"type":"text","text":"3 suites touch retry paths."}],"usage":{"input_tokens":5,"output_tokens":40,"cache_creation_input_tokens":0,"cache_read_input_tokens":0}}}
```

`fixtures/agent-abc123.meta.json`: `{"agentId":"abc123"}` (P0 refines with real fields).
`fixtures/NOTES.md`: paste the verified-schema table from the spec §2.

- [ ] **Step 4: Write smoke test `tests/fixtures.test.ts`**

```ts
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
describe('fixtures', () => {
  it('every fixture line is valid JSON', () => {
    for (const f of ['fixtures/main-session.jsonl', 'fixtures/agent-abc123.jsonl'])
      for (const line of readFileSync(f, 'utf8').split('\n').filter(Boolean))
        expect(() => JSON.parse(line)).not.toThrow();
  });
});
```

- [ ] **Step 5: Run `npm test` → PASS, then commit**

```bash
git add -A && git commit -m "feat: scaffold, shared Event types, synthetic schema fixtures"
```

---

### Task 2: Byte-offset tailer

**Files:**
- Create: `server/tail.ts`
- Test: `tests/tail.test.ts`

**Interfaces:**
- Produces: `class Tailer { readNew(filePath: string): string[] }` — returns only complete NEW lines since the previous call for that path (tracks byte offsets per path; a trailing partial line is held back until its newline arrives).

- [ ] **Step 1: Write the failing test**

```ts
import { mkdtempSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Tailer } from '../server/tail';

describe('Tailer', () => {
  it('returns only new complete lines per call', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rt-'));
    const f = join(dir, 'a.jsonl');
    writeFileSync(f, '{"a":1}\n');
    const t = new Tailer();
    expect(t.readNew(f)).toEqual(['{"a":1}']);
    appendFileSync(f, '{"b":2}\n{"c":');          // partial third line
    expect(t.readNew(f)).toEqual(['{"b":2}']);
    appendFileSync(f, '3}\n');
    expect(t.readNew(f)).toEqual(['{"c":3}']);
    expect(t.readNew(f)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run `npx vitest run tests/tail.test.ts`** — Expected: FAIL (`Tailer` not found).

- [ ] **Step 3: Implement `server/tail.ts`**

```ts
import { openSync, readSync, closeSync, statSync } from 'node:fs';

export class Tailer {
  private offsets = new Map<string, number>();

  readNew(filePath: string): string[] {
    const size = statSync(filePath).size;
    let off = this.offsets.get(filePath) ?? 0;
    if (size <= off) return [];
    const fd = openSync(filePath, 'r');
    const buf = Buffer.alloc(size - off);
    readSync(fd, buf, 0, buf.length, off);
    closeSync(fd);
    const text = buf.toString('utf8');
    const lastNl = text.lastIndexOf('\n');
    if (lastNl === -1) return [];                 // no complete line yet
    this.offsets.set(filePath, off + Buffer.byteLength(text.slice(0, lastNl + 1), 'utf8'));
    return text.slice(0, lastNl).split('\n').filter(Boolean);
  }
}
```

- [ ] **Step 4: Run the test again** — Expected: PASS.
- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat: byte-offset jsonl tailer"`

---

### Task 3: Tolerant line parser

**Files:**
- Create: `server/parse.ts`
- Test: `tests/parse.test.ts`

**Interfaces:**
- Produces: `parseLine(raw: string): RawLine | null` and

```ts
export type RawLine = {
  type: string; uuid?: string; agentId?: string; sessionId?: string;
  timestamp?: string; cwd?: string; isSidechain?: boolean;
  message?: { role?: string; model?: string; content?: unknown;
              usage?: { input_tokens?: number; output_tokens?: number } };
};
```

- [ ] **Step 1: Failing test `tests/parse.test.ts`**

```ts
import { describe, expect, it } from 'vitest';
import { parseLine } from '../server/parse';
it('parses a known line and keeps fields', () => {
  const l = parseLine('{"type":"assistant","sessionId":"s","message":{"role":"assistant"}}');
  expect(l?.type).toBe('assistant');
  expect(l?.sessionId).toBe('s');
});
it('returns null on garbage and on non-objects', () => {
  expect(parseLine('not json')).toBeNull();
  expect(parseLine('42')).toBeNull();
});
```

- [ ] **Step 2: Run** `npx vitest run tests/parse.test.ts` → FAIL.
- [ ] **Step 3: Implement `server/parse.ts`**

```ts
import type { RawLine } from './parse.types';   // or inline the type in this file
export function parseLine(raw: string): RawLine | null {
  try {
    const v: unknown = JSON.parse(raw);
    if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
    const o = v as Record<string, unknown>;
    if (typeof o.type !== 'string') return null;
    return o as unknown as RawLine;             // fields accessed defensively downstream
  } catch { return null; }
}
```

(Keep `RawLine` in `server/parse.ts` itself — one file, one responsibility.)

- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** — `git commit -am "feat: tolerant transcript line parser"`

---

### Task 4: Normalizer (RawLine → Ev[])

**Files:**
- Create: `server/normalize.ts`
- Test: `tests/normalize.test.ts` (drives with Task 1 fixtures)

**Interfaces:**
- Consumes: `parseLine`, `RawLine` (Task 3); `Ev`, `AgentRef` (Task 1).
- Produces: `class Normalizer { constructor(sessionId: string, agentId: string | 'main'); feed(line: RawLine): Ev[] }` — stateful per file: assigns monotonically increasing `seq` (module-level counter), converts ISO `timestamp` → epoch ms `ts`, maps:
  - user line, string content → `userMessage`; array content w/ `tool_result` blocks → `toolResult` (ok = no `is_error`)
  - assistant content blocks: `thinking`(non-empty text) → `thinking`; `text` → `agentText`; `tool_use` → `toolStart` (+`fileEdit` when name is Edit/Write/NotebookEdit with `input.file_path`; +`agentSpawn` when name is Task/Agent with `input.prompt`)
  - `message.usage` present → `usage`
  - first line of a file also emits `agentSeen` (model from first assistant line when it arrives)

- [ ] **Step 1: Failing test (fixture-driven)**

```ts
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseLine } from '../server/parse';
import { Normalizer } from '../server/normalize';

const feedAll = (file: string, agentId: 'main' | string) => {
  const n = new Normalizer('fix-sess', agentId);
  return readFileSync(file, 'utf8').split('\n').filter(Boolean)
    .flatMap(l => { const r = parseLine(l); return r ? n.feed(r) : []; });
};

it('normalizes the main fixture', () => {
  const evs = feedAll('fixtures/main-session.jsonl', 'main');
  const kinds = evs.map(e => e.kind);
  expect(kinds).toContain('userMessage');
  expect(kinds).toContain('thinking');
  expect(kinds).toContain('agentText');
  expect(evs.find(e => e.kind === 'toolStart' && e.tool === 'Grep')).toBeTruthy();
  expect(evs.find(e => e.kind === 'agentSpawn')).toBeTruthy();      // Task tool_use
  expect(evs.find(e => e.kind === 'toolResult' && e.ok)).toBeTruthy();
  const seqs = evs.map(e => e.seq);
  expect([...seqs].sort((a, b) => a - b)).toEqual(seqs);            // monotonic
});
it('normalizes a subagent fixture with its agentId', () => {
  const evs = feedAll('fixtures/agent-abc123.jsonl', 'abc123');
  expect(evs.every(e => e.ref.agentId === 'abc123')).toBe(true);
});
```

- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement `server/normalize.ts`** (~90 lines): iterate `message.content`; string content on user role → `userMessage`; array blocks per mapping above; guard every field access (`typeof`), skip unknowns silently.

```ts
let SEQ = 0;
const ts = (iso?: string) => (iso ? Date.parse(iso) : Date.now());
export class Normalizer {
  private seen = false;
  constructor(private sessionId: string, private agentId: string | 'main') {}
  private ref() { return { sessionId: this.sessionId, agentId: this.agentId }; }
  feed(l: import('./parse').RawLine): import('../shared/events').Ev[] {
    const out: import('../shared/events').Ev[] = [];
    const T = ts(l.timestamp);
    const push = (e: Omit<import('../shared/events').Ev, 'seq'>) =>
      out.push({ ...(e as object), seq: ++SEQ } as import('../shared/events').Ev);
    if (!this.seen) { this.seen = true; push({ kind: 'agentSeen', ref: this.ref(), model: l.message?.model, ts: T }); }
    const c = l.message?.content;
    if (l.type === 'user' && typeof c === 'string') push({ kind: 'userMessage', ref: this.ref(), text: c, ts: T });
    if (Array.isArray(c)) for (const b of c as Array<Record<string, unknown>>) {
      if (b.type === 'thinking' && typeof b.thinking === 'string' && b.thinking.trim())
        push({ kind: 'thinking', ref: this.ref(), text: b.thinking, ts: T });
      if (b.type === 'text' && typeof b.text === 'string' && l.message?.role === 'assistant')
        push({ kind: 'agentText', ref: this.ref(), text: b.text, ts: T });
      if (b.type === 'tool_result' && typeof b.tool_use_id === 'string')
        push({ kind: 'toolResult', ref: this.ref(), toolUseId: b.tool_use_id, ok: !b.is_error, ts: T });
      if (b.type === 'tool_use' && typeof b.name === 'string' && typeof b.id === 'string') {
        const input = (b.input ?? {}) as Record<string, unknown>;
        push({ kind: 'toolStart', ref: this.ref(), tool: b.name, toolUseId: b.id,
               target: typeof input.file_path === 'string' ? input.file_path
                     : typeof input.pattern === 'string' ? input.pattern : undefined, ts: T });
        if (['Edit', 'Write', 'NotebookEdit'].includes(b.name) && typeof input.file_path === 'string')
          push({ kind: 'fileEdit', ref: this.ref(), path: input.file_path, ts: T });
        if (['Task', 'Agent'].includes(b.name) && typeof input.prompt === 'string')
          push({ kind: 'agentSpawn', ref: this.ref(), childAgentId: 'pending', prompt: input.prompt, ts: T });
      }
    }
    const u = l.message?.usage;
    if (u && typeof u.input_tokens === 'number' && typeof u.output_tokens === 'number')
      push({ kind: 'usage', ref: this.ref(), inTok: u.input_tokens, outTok: u.output_tokens, ts: T });
    return out;
  }
}
```

- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** — `git commit -am "feat: transcript normalizer to typed event stream"`

---

### Task 5: Session discovery + watcher wiring

**Files:**
- Create: `server/sessions.ts`
- Test: `tests/sessions.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces:
  - `claudeRoot(): string` — `process.env.ROUNDTABLE_HOME ?? join(homedir(), '.claude')`
  - `listSessions(root: string): { sessionId: string; slug: string; file: string; mtime: number }[]` — scans `projects/*/ *.jsonl` (top level only)
  - `subagentFiles(root: string, slug: string, sessionId: string): { agentId: string; file: string }[]` — scans `projects/<slug>/<sessionId>/subagents/agent-*.jsonl`, agentId from filename

- [ ] **Step 1: Failing test** — build a temp `ROUNDTABLE_HOME` with `projects/demo/fix-sess.jsonl` (copy of main fixture) and `projects/demo/fix-sess/subagents/agent-abc123.jsonl`; assert both functions find them with correct ids.

```ts
import { mkdtempSync, mkdirSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { listSessions, subagentFiles } from '../server/sessions';

it('discovers sessions and subagent files', () => {
  const root = mkdtempSync(join(tmpdir(), 'rt-root-'));
  const slugDir = join(root, 'projects', 'demo');
  mkdirSync(join(slugDir, 'fix-sess', 'subagents'), { recursive: true });
  copyFileSync('fixtures/main-session.jsonl', join(slugDir, 'fix-sess.jsonl'));
  copyFileSync('fixtures/agent-abc123.jsonl', join(slugDir, 'fix-sess', 'subagents', 'agent-abc123.jsonl'));
  const s = listSessions(root);
  expect(s).toHaveLength(1);
  expect(s[0].sessionId).toBe('fix-sess');
  const subs = subagentFiles(root, 'demo', 'fix-sess');
  expect(subs).toEqual([expect.objectContaining({ agentId: 'abc123' })]);
});
```

- [ ] **Step 2: Run** → FAIL. **Step 3: Implement** with `readdirSync` + `statSync` (no recursion beyond the two known levels). **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** — `git commit -am "feat: session and subagent discovery"`

---

### Task 6: Server main — watch, normalize, WebSocket broadcast

**Files:**
- Create: `server/index.ts`, `server/hub.ts`
- Test: `tests/hub.test.ts` (integration over temp root)

**Interfaces:**
- Consumes: Tailer (2), parseLine (3), Normalizer (4), sessions (5), `Ev` (1).
- Produces: WS server on `ws://127.0.0.1:7411/ws`; on connect sends `{kind:'hello', sessions: [...]}` then streams `Ev` JSON; client selects session via `{cmd:'follow', sessionId}` message. `startServer(root: string, port: number): Promise<() => void>` for tests.

- [ ] **Step 1: Failing integration test** — start server over the Task 5 temp root, connect a `ws` client, send `follow`, append a line to the main fixture copy, assert an `agentText`/`userMessage` event arrives within 3s (chokidar polling 200ms in test via option).
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement**: one `Tailer` + per-file `Normalizer` map; chokidar watches the followed session's main file + its `subagents/` dir (add/change); broadcast every produced `Ev` to sockets following that session. **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** — `git commit -am "feat: ws hub streaming normalized events from watched transcripts"`

---

### Task 7: Client store + WS hook + chat feed

**Files:**
- Create: `src/store.ts`, `src/ws.ts`, `src/chat/Chat.tsx`, `src/chat/MessageCard.tsx`; modify `src/App.tsx`
- Test: `tests/store.test.ts`

**Interfaces:**
- Consumes: `Ev` (1); WS protocol (6).
- Produces: `reduce(state: RtState, ev: Ev): RtState` where

```ts
export type RtAgent = { id: string; model?: string; label?: string; status: string; tokens: number };
export type RtMsg = { id: number; agentId: string | 'main' | 'user'; text: string;
                     thinking?: string; chips: string[]; verdict?: 'ok' | 'err'; ts: number };
export type RtState = { agents: Record<string, RtAgent>; msgs: RtMsg[]; totalTok: number };
```

Reducer rules: `agentText` opens a msg for that agent, attaching the latest unattached `thinking` of the same agent as its monologue; `toolStart` appends a chip to the agent's next/current msg and sets `status`; verdict = 'err' when text starts with/contains `REFUTED`, 'ok' for `CONFIRMED`; `usage` accumulates tokens.

- [ ] **Step 1: Failing reducer test** — feed the normalized fixture events (reuse Task 4 helper) through `reduce`, assert: 1 user msg, ≥1 agent msg with `thinking` attached, Grep chip present, `totalTok > 0`.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement** `store.ts` (pure), `ws.ts` (`useRtStream(sessionId)` hook: connect, follow, fold events with `useReducer`), `Chat.tsx` + `MessageCard.tsx` (port mockup chat styles: avatar mini-heads from agent id hash → tint palette, verdict borders, `<details>` monologue). **Step 4: Run reducer test** → PASS; `npm run dev` shows live chat against real `~/.claude` (manual check).
- [ ] **Step 5: Commit** — `git commit -am "feat: client store, ws stream hook, chat feed"`

---

### Task 8: Behavior mapping (Ev → sim commands)

**Files:**
- Create: `src/office/mapping.ts`
- Test: `tests/mapping.test.ts`

**Interfaces:**
- Consumes: `Ev` (1).
- Produces: `mapEvent(ev: Ev): Cmd[]` with

```ts
export type Cmd =
  | { op: 'ensureActor'; agentId: string }
  | { op: 'think'; agentId: string; text: string }
  | { op: 'workBurst'; agentId: string; label: string }         // typing + screen anim
  | { op: 'deliver'; agentId: string; to: 'main'; text: string } // walk to orchestrator, speak
  | { op: 'confront'; agentId: string; to: string; text: string; verdict: 'ok' | 'err' }
  | { op: 'status'; agentId: string; text: string };
```

Mapping: `agentSeen`→ensureActor; `thinking`→think (first 90 chars); `toolStart`→workBurst(`${tool} ${target ?? ''}`); `agentText` from subagent→deliver(first sentence); `agentText` containing REFUTED/CONFIRMED→confront (target = agent named in text if roster match, else 'main'); `usage`→status tokens.

- [ ] **Step 1: Failing test** — assert `thinking` maps to think with truncation; REFUTED text maps to confront with verdict 'err'.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement** (pure, ~60 lines). **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** — `git commit -am "feat: event-to-office behavior mapping"`

---

### Task 9: Office engine (actors, waypoints, poses)

**Files:**
- Create: `src/office/engine.ts`
- Test: `tests/engine.test.ts`

**Interfaces:**
- Consumes: `Cmd` (8).
- Produces:

```ts
export type Pose = 'sit' | 'walk' | 'stand';
export type ActorState = { id: string; x: number; y: number; pose: Pose; flip: boolean; away: boolean;
                          say?: string; think?: string; status: string; deskIndex: number };
export class Engine {
  constructor(now?: () => number);
  apply(cmd: Cmd): void;
  tick(dtMs: number): ActorState[];   // advances walks (speed 150 px/s at 1600×900 basis), expires bubbles (5s)
}
```

Desk assignment: `main` gets the manager desk slot; others take pod slots in spawn order; slots beyond 4 extend the grid by rows (x pattern repeats, y += 30). Walking uses fixed waypoint routes between named anchors (seat[i], tableN/W/S/E, coffee) copied from the mockup coordinate table.

- [ ] **Step 1: Failing test** — `ensureActor` twice assigns distinct desks; `deliver` sets pose 'walk' and after enough `tick` time actor reaches the manager-desk anchor (±1) with `say` set; bubbles expire after 5s of ticks.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement** (~150 lines, pure — no DOM). **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** — `git commit -am "feat: deterministic office behavior engine"`

---

### Task 10: Office scene rendering + wire-up + e2e

**Files:**
- Create: `src/office/Office.tsx`, `src/office/Actor.tsx`, `src/office/scene.css`
- Modify: `src/App.tsx` (layout: office left, chat right, HUD top/legend)
- Test: `e2e/live.spec.ts` (Playwright)

**Interfaces:**
- Consumes: `Engine`/`ActorState` (9), `mapEvent` (8), `useRtStream` (7).
- Produces: running app `npm run dev` at `http://127.0.0.1:5173` proxying WS to 7411.

- [ ] **Step 1: Port mockup scene** — furniture/props/HUD from the approved mockup (office-sim-v5) as React components with the same CSS (desks, roundtable, kitchen, whiteboard showing current task = first `userMessage`, plants, mats). `Actor.tsx` renders `ActorState` (pose classes `sitting/walking/away/flip`, say/think bubbles). `requestAnimationFrame` loop: fold incoming `Ev` → `mapEvent` → `engine.apply`, render `engine.tick(dt)`.
- [ ] **Step 2: Write failing e2e** `e2e/live.spec.ts`: boot server with `ROUNDTABLE_HOME=<temp root>` (Task 5 layout), open app, then append the "assistant text + thinking" fixture line to the main file; expect a thought bubble text and a chat card to appear within 5s (`page.getByText('scheduler.spec mixes timers')`).
- [ ] **Step 3: Run e2e** → FAIL, then fix wiring until PASS.
- [ ] **Step 4: Manual live check** — run against real `~/.claude`, open a second Claude Code session, watch it appear. Screenshot for the log.
- [ ] **Step 5: Commit** — `git commit -am "feat: office scene rendering wired to live event stream (MVP)"`

---

## After MVP (separate plans)

P3 workflows/journal + multi-session switcher + desk-grid overflow; P4 hooks fast-path + polish; P5 replay scrubber. Each gets its own plan doc once MVP is validated on real sessions.

## Self-review notes

- Spec coverage: §2 sources → Tasks 5/6 (sessions, subagents; workflows deferred to P3 per spec §6); §3.1 events → Tasks 1/4; §3.2 mapping → Task 8 (coffee-idle + huddle deferred: huddle needs multi-agent window logic — added to P3 note); §4 visuals → Task 10; §5 tests → Tasks 2-10; §6 phases P0-P2 ↔ Tasks 1-10. Gap check: `sessionSeen`/`hello` listing covered in Task 6 hello payload.
- Types: `Ev`, `Cmd`, `ActorState`, `RtState` defined once, referenced by name everywhere.
- No placeholders; every code step contains real code or an exact behavioral contract.
