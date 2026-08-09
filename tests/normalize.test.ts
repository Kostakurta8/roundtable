import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Ev } from '../shared/events';
import { parseLine } from '../server/parse';
import { classifyUserSource, Normalizer, oneLine } from '../server/normalize';

const feedAll = (file: string, agentId: 'main' | string) => {
  const n = new Normalizer('fix-sess', agentId);
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .flatMap((l) => {
      const r = parseLine(l);
      return r ? n.feed(r) : [];
    });
};

describe('Normalizer', () => {
  it('normalizes the main fixture', () => {
    const evs = feedAll(join('fixtures', 'main-session.jsonl'), 'main');
    const kinds = evs.map((e) => e.kind);
    expect(kinds).toContain('userMessage');
    expect(kinds).toContain('thinking');
    expect(kinds).toContain('agentText');
    expect(evs.find((e) => e.kind === 'toolStart' && e.tool === 'Grep')).toBeTruthy();
    expect(evs.find((e) => e.kind === 'agentSpawn')).toBeTruthy(); // Task tool_use
    expect(evs.find((e) => e.kind === 'toolResult' && e.ok)).toBeTruthy();
    // Controller resolution: first line (user) has no model; the first assistant line
    // introduces 'claude-fable-5' later, which must land as a second agentSeen for the
    // same ref (client upserts on agentId, so a later, more-complete agentSeen is fine).
    expect(evs.find((e) => e.kind === 'agentSeen' && e.model === 'claude-fable-5')).toBeTruthy();
    const seqs = evs.map((e) => e.seq);
    expect([...seqs].sort((a, b) => a - b)).toEqual(seqs); // monotonic
  });

  it('normalizes a subagent fixture with its agentId', () => {
    const evs = feedAll(join('fixtures', 'agent-abc123.jsonl'), 'abc123');
    expect(evs.every((e) => 'ref' in e && e.ref.agentId === 'abc123')).toBe(true);
  });
});

/**
 * Streamed usage — the fix for a headline figure that was roughly half the truth.
 *
 * The lines below are a real response copied out of
 * `~/.claude/projects/…/subagents/agent-aa089106cac072c71.jsonl` (`msg_011CdfiRFPTF8KTYzJoHsWd4`),
 * with only the text shortened: three lines, one `message.id`, `output_tokens` 1 → 1 → 317 while
 * every other field repeats unchanged. Keeping the first line's copy reported 1 output token for a
 * response that billed 317; summing all three reported 319 and counted 107 700 cache-write tokens
 * for 35 900 that were actually written. Both readings are wrong, in opposite directions, and the
 * shape that produces them is the ordinary shape of a turn that called a tool.
 */
const STREAMED = (id: string, out: number, blocks: unknown[], model = 'claude-opus-5'): Parameters<Normalizer['feed']>[0] => ({
  type: 'assistant',
  timestamp: '2026-08-03T09:00:00.000Z',
  message: {
    id,
    role: 'assistant',
    model,
    content: blocks,
    usage: {
      input_tokens: 2,
      output_tokens: out,
      cache_creation_input_tokens: 35_900,
      cache_read_input_tokens: 17_993,
    },
  },
});

const RESPONSE = [
  STREAMED('msg_A', 1, [{ type: 'text', text: 'Reading the config.' }]),
  STREAMED('msg_A', 1, [{ type: 'tool_use', id: 'tu_1', name: 'Read', input: { file_path: '/a.ts' } }]),
  STREAMED('msg_A', 317, [{ type: 'tool_use', id: 'tu_2', name: 'Read', input: { file_path: '/b.ts' } }]),
];

/** Every usage event in `evs`, added up — what the client's store would arrive at. */
const totals = (evs: readonly Ev[]) => {
  let inTok = 0, outTok = 0, cacheRead = 0, cacheWrite = 0, n = 0;
  for (const e of evs) {
    if (e.kind !== 'usage') continue;
    inTok += e.inTok;
    outTok += e.outTok;
    cacheRead += e.cacheRead ?? 0;
    cacheWrite += e.cacheWrite ?? 0;
    n += 1;
  }
  return { inTok, outTok, cacheRead, cacheWrite, n };
};

describe('Normalizer streamed usage', () => {
  it('reports what a response really billed, not what its first line claimed', () => {
    const n = new Normalizer('s', 'main');
    const evs = [...RESPONSE.flatMap((l) => n.feed(l)), ...n.flush()];
    expect(totals(evs)).toMatchObject({ inTok: 2, outTok: 317, cacheWrite: 35_900, cacheRead: 17_993 });
  });

  it('reports the rest of a response that arrives in a later batch, and never the same tokens twice', () => {
    const n = new Normalizer('s', 'main');
    // Batch one ends mid-response: the hub flushes, so what has been billed so far is published.
    const first = [...n.feed(RESPONSE[0]), ...n.flush()];
    expect(totals(first).outTok).toBe(1);
    // Batch two carries the rest. The totals across both batches must still be the response's own.
    const second = [...RESPONSE.slice(1).flatMap((l) => n.feed(l)), ...n.flush()];
    expect(totals([...first, ...second])).toMatchObject({
      inTok: 2,
      outTok: 317,
      cacheWrite: 35_900,
      cacheRead: 17_993,
    });
  });

  it('publishes nothing when the current response has nothing new to report', () => {
    const n = new Normalizer('s', 'main');
    n.feed(RESPONSE[0]);
    expect(n.flush().length).toBe(1);
    expect(n.flush()).toEqual([]); // a quiet tick must not publish a second copy
  });

  it('closes one response when the next begins, without waiting for a flush', () => {
    const n = new Normalizer('s', 'main');
    const evs = [
      ...RESPONSE.flatMap((l) => n.feed(l)),
      ...n.feed(STREAMED('msg_B', 40, [{ type: 'text', text: 'Done.' }])),
      ...n.flush(),
    ];
    // Two responses, counted once each: 317 + 40, and the identical cache figures added twice
    // because they really were two separate billings.
    expect(totals(evs)).toMatchObject({ inTok: 4, outTok: 357, cacheWrite: 71_800 });
  });

  it('counts a line that carries no message id on its own', () => {
    const n = new Normalizer('s', 'main');
    const line = STREAMED('x', 12, [{ type: 'text', text: 'hi' }]);
    delete line.message?.id;
    const evs = [...n.feed(line), ...n.flush()];
    expect(totals(evs)).toMatchObject({ outTok: 12, n: 1 });
  });

  it('names the model that billed the tokens', () => {
    const n = new Normalizer('s', 'main');
    const evs = [...RESPONSE.flatMap((l) => n.feed(l)), ...n.flush()];
    const usage = evs.find((e) => e.kind === 'usage');
    expect(usage).toMatchObject({ model: 'claude-opus-5' });
  });
});

describe('Normalizer model changes', () => {
  it('announces the agent again when the model changes mid-session', () => {
    const n = new Normalizer('s', 'main');
    const first = n.feed(STREAMED('m1', 5, [{ type: 'text', text: 'a' }], 'claude-opus-5'));
    const second = n.feed(STREAMED('m2', 5, [{ type: 'text', text: 'b' }], 'claude-haiku-4-5'));
    expect(first.find((e) => e.kind === 'agentSeen' && e.model === 'claude-opus-5')).toBeTruthy();
    // 9% of real transcripts carry more than one model; latching the first priced the rest of the
    // session at the wrong card and printed the wrong name.
    expect(second.find((e) => e.kind === 'agentSeen' && e.model === 'claude-haiku-4-5')).toBeTruthy();
  });

  it('does not re-announce an agent whose model has not changed', () => {
    const n = new Normalizer('s', 'main');
    n.feed(STREAMED('m1', 5, [{ type: 'text', text: 'a' }]));
    const again = n.feed(STREAMED('m2', 5, [{ type: 'text', text: 'b' }]));
    expect(again.some((e) => e.kind === 'agentSeen')).toBe(false);
  });
});

describe('Normalizer compaction summaries', () => {
  const SUMMARY =
    'This session is being continued from a previous conversation that ran out of context. ' +
    'The summary below covers the earlier portion of the conversation.\n\nSummary:\n1. …';

  it('labels a compaction summary as its own source rather than as the human', () => {
    const n = new Normalizer('s', 'main');
    const evs = n.feed({
      type: 'user',
      timestamp: '2026-08-03T09:00:00.000Z',
      isCompactSummary: true,
      message: { role: 'user', content: SUMMARY },
    });
    expect(evs.find((e) => e.kind === 'userMessage')).toMatchObject({ source: 'compaction' });
  });

  it('recognizes the summary by its opening sentence when the flag is absent', () => {
    const n = new Normalizer('s', 'main');
    const evs = n.feed({
      type: 'user',
      timestamp: '2026-08-03T09:00:00.000Z',
      message: { role: 'user', content: SUMMARY },
    });
    expect(evs.find((e) => e.kind === 'userMessage')).toMatchObject({ source: 'compaction' });
  });

  it('still calls an ordinary prompt the human', () => {
    const n = new Normalizer('s', 'main');
    const evs = n.feed({
      type: 'user',
      timestamp: '2026-08-03T09:00:00.000Z',
      message: { role: 'user', content: 'find the flaky test' },
    });
    expect(evs.find((e) => e.kind === 'userMessage')).toMatchObject({ source: 'human' });
  });

  it('labels a task-notification block as the harness, not the human', () => {
    const n = new Normalizer('s', 'main');
    const evs = n.feed({
      type: 'user',
      timestamp: '2026-08-03T09:00:00.000Z',
      message: { role: 'user', content: '<task-notification> <task-id>abc</task-id> Background task finished.' },
    });
    expect(evs.find((e) => e.kind === 'userMessage')).toMatchObject({ source: 'reminder' });
  });
});

/**
 * The CLI's own markup, taken off the `user` lane.
 *
 * Every string below is copied verbatim out of the transcripts on this machine. The feed was
 * rendering them as typed, so a person watching a session read
 * `<command-name>/effort</command-name>` where a sentence belonged — machine markup shown to a
 * human as if it were prose, in an app whose whole job is to explain what a session is doing.
 */
const CAVEAT =
  '<local-command-caveat>Caveat: The messages below were generated by the user while running ' +
  'local commands. DO NOT respond to these messages or otherwise consider them in your response ' +
  'unless the user explicitly asks you to.</local-command-caveat>';

/** The three-tag slash-command echo, indentation and empty `command-args` exactly as written. */
const EFFORT =
  '<command-name>/effort</command-name>\n            <command-message>effort</command-message>\n' +
  '            <command-args></command-args>';

const userText = (text: string, extra: Record<string, unknown> = {}) => {
  const evs = new Normalizer('s', 'main').feed({
    type: 'user',
    timestamp: '2026-08-03T09:00:00.000Z',
    ...extra,
    message: { role: 'user', content: text },
  });
  return evs.find((e) => e.kind === 'userMessage');
};

describe('Normalizer user-lane markup', () => {
  it('unwraps the three-tag slash-command echo into one readable line', () => {
    // The commonest wrapper on this machine, and the one the feed showed raw.
    expect(userText(EFFORT)).toMatchObject({ text: '/effort effort', source: 'command' });
  });

  it('drops an empty wrapper without leaving a blank line or a stray separator', () => {
    // `<command-args></command-args>` carries nothing. Keeping its whitespace left the card
    // trailing an empty line, which reads as the message having been cut off.
    const ev = userText(EFFORT);
    expect(ev?.kind === 'userMessage' && ev.text).toBe('/effort effort');
    expect(ev?.kind === 'userMessage' && ev.text.endsWith('effort')).toBe(true);
  });

  it('keeps the caveat’s sentence and throws away its tags', () => {
    const ev = userText(CAVEAT);
    expect(ev).toMatchObject({ source: 'caveat' });
    expect(ev?.kind === 'userMessage' && ev.text).toBe(
      'Caveat: The messages below were generated by the user while running local commands. ' +
        'DO NOT respond to these messages or otherwise consider them in your response unless the ' +
        'user explicitly asks you to.',
    );
  });

  it('unwraps command stdout, which is the half of a slash command worth reading', () => {
    expect(
      userText('<local-command-stdout>Set effort level to xhigh (this session only)</local-command-stdout>'),
    ).toMatchObject({ text: 'Set effort level to xhigh (this session only)', source: 'command' });
  });

  it('unwraps a task-notification without touching the tags inside it', () => {
    // Only the names the CLI wraps *whole messages* in are stripped. `<status>` and `<summary>`
    // are structure inside the payload, and inventing a rendering for them here would be this
    // file guessing at a shape it has not measured.
    const ev = userText(
      '<task-notification>\n<status>completed</status>\n<summary>Agent "Build the scene" finished</summary>\n</task-notification>',
    );
    expect(ev).toMatchObject({ source: 'reminder' });
    expect(ev?.kind === 'userMessage' && ev.text).toContain('<summary>Agent "Build the scene" finished</summary>');
    expect(ev?.kind === 'userMessage' && ev.text).not.toContain('task-notification');
  });

  it('classifies from the raw text, before anything is unwrapped', () => {
    // The ordering that matters most in this file. `<command-name>/effort</command-name>` unwraps
    // to `/effort`, which classifies as `human` — so unwrapping first would relabel every slash
    // command as the human speaking and put machine text back in their mouth, which is the exact
    // bug the whole `source` field exists to prevent.
    expect(userText('<command-name>/effort</command-name>')).toMatchObject({
      text: '/effort',
      source: 'command',
    });
    expect(userText(CAVEAT)).toMatchObject({ source: 'caveat' });
    expect(userText('<user-prompt-submit-hook>ready</user-prompt-submit-hook>')).toMatchObject({
      text: 'ready',
      source: 'hook',
    });
  });

  it('leaves a tag the CLI does not write exactly as the human typed it', () => {
    // A person pasting markup into a prompt must get their prompt back. Only the CLI's own
    // wrapper names are ever stripped; everything else is content.
    const html = 'Wrap it in <div class="row">…</div> and see if <Foo /> still renders.';
    expect(userText(html)).toMatchObject({ text: html, source: 'human' });
  });

  it('leaves an ordinary prompt byte-for-byte alone, newlines and all', () => {
    const prose = 'find the flaky test\n\n- check the timers\n- then the retries\n';
    expect(userText(prose)).toMatchObject({ text: prose, source: 'human' });
  });

  it('redacts a credential a command echoed back', () => {
    expect(userText('<local-command-stdout>DB_PASSWORD=hunter2</local-command-stdout>')).toMatchObject({
      text: 'DB_PASSWORD=***',
    });
  });

  it('caps what crosses the socket, however long the wrapper was', () => {
    const ev = userText(`<local-command-stdout>${'x'.repeat(40_000)}</local-command-stdout>`);
    expect(ev?.kind === 'userMessage' && ev.text.length).toBeLessThanOrEqual(16_384);
    expect(ev?.kind === 'userMessage' && ev.text.endsWith('…')).toBe(true);
  });

  it('says nothing at all for a line that was only empty markup', () => {
    // A wrapper with nothing in it is not a message. An empty card is worse than no card.
    expect(userText('<command-args></command-args>')).toBeUndefined();
  });

  it('unwraps the block form of a user turn too, not just the string form', () => {
    const evs = new Normalizer('s', 'main').feed({
      type: 'user',
      timestamp: '2026-08-03T09:00:00.000Z',
      message: { role: 'user', content: [{ type: 'text', text: EFFORT }] },
    });
    expect(evs.find((e) => e.kind === 'userMessage')).toMatchObject({ text: '/effort effort', source: 'command' });
  });

  it('still lets a compaction summary be a compaction summary', () => {
    const ev = userText('This session is being continued from a previous conversation. Summary: …', {
      isCompactSummary: true,
    });
    expect(ev).toMatchObject({ source: 'compaction' });
  });
});

/**
 * Naming the thing a tool call acts on.
 *
 * Four keys used to be read — `file_path`, `pattern`, `command`, `url` — which named 88.03% of the
 * 84 488 `tool_use` blocks in the 2 552 transcripts on this machine and left 11.97% anonymous: the
 * room showed those agents doing something unnameable and the feed showed a bare tool name. Every
 * input below is the real shape, copied out of that corpus, of a call that used to have no target.
 */
const toolUse = (name: string, input: Record<string, unknown>): Parameters<Normalizer['feed']>[0] => ({
  type: 'assistant',
  timestamp: '2026-08-03T09:00:00.000Z',
  message: { role: 'assistant', model: 'claude-opus-5', content: [{ type: 'tool_use', id: 'tu_t', name, input }] },
});

/** The target the normalizer gives one `tool_use`, or `undefined` if it declines to name one. */
function targetFor(name: string, input: Record<string, unknown>): string | undefined {
  const evs = new Normalizer('s', 'main').feed(toolUse(name, input));
  const start = evs.find((e) => e.kind === 'toolStart');
  return start?.kind === 'toolStart' ? start.target : undefined;
}

describe('Normalizer tool targets', () => {
  it('still prefers the four keys it always read, in the order it always read them', () => {
    // A Bash call carries a `description` too; the command is what it did.
    expect(targetFor('Bash', { command: 'npm test', description: 'Run the suite' })).toBe('npm test');
    expect(targetFor('Edit', { file_path: '/a/b.ts', old_string: 'x', new_string: 'y' })).toBe('/a/b.ts');
    expect(targetFor('Grep', { pattern: 'retryWithBackoff', path: 'src' })).toBe('retryWithBackoff');
    expect(targetFor('WebFetch', { url: 'https://example.com/x', prompt: 'summarize' })).toBe('https://example.com/x');
  });

  // One case per shape that used to come through anonymous, keyed by how many of them there are.
  const CASES: readonly [label: string, tool: string, input: Record<string, unknown>, want: string][] = [
    [
      'WebSearch — 3 375 calls', // the single largest anonymous population in the corpus
      'WebSearch',
      { query: 'meta ads MCP server Claude facebook marketing API campaign management 2026' },
      'meta ads MCP server Claude facebook marketing API campaign management 2026',
    ],
    ['ToolSearch — 463', 'ToolSearch', { query: 'select:TaskCreate,TaskUpdate', max_results: 5 }, 'select:TaskCreate,TaskUpdate'],
    [
      // The caller's own three-word summary, which beats both the paragraph-long prompt and the
      // registered agent type. `Agent` calls are also what the office draws as a spawn.
      'Agent — 355, description over prompt',
      'Agent',
      { description: 'Author props.ts sprites', subagent_type: 'general-purpose', prompt: 'Author ONE file of a pixel-art canvas renderer…' },
      'Author props.ts sprites',
    ],
    ['Agent with no description falls back to its type', 'Agent', { subagent_type: 'Explore', prompt: 'go and look' }, 'Explore'],
    [
      // Both fields are real; `subject` is the title and `description` is the paragraph under it.
      'TaskCreate — 568, subject over description',
      'TaskCreate',
      {
        subject: 'Verify live kit prices 53705-53718 (authoritative)',
        description: 'Read-only pull of _regular_price/_sale_price/title/slug for the 14 live kits.',
        activeForm: 'Pulling live kit prices',
      },
      'Verify live kit prices 53705-53718 (authoritative)',
    ],
    ['TaskUpdate — 857', 'TaskUpdate', { taskId: '3', status: 'in_progress' }, '3'],
    ['TaskStop — 59, the snake_case spelling', 'TaskStop', { task_id: 'a9740499dffffc025' }, 'a9740499dffffc025'],
    ['Skill — 135', 'Skill', { skill: 'superpowers:executing-plans' }, 'superpowers:executing-plans'],
    [
      'browser_click — 185, the tool\u2019s own words for what it clicked',
      'mcp__playwright__browser_click',
      { element: 'Зареди новите продукти button', ref: 'e38' },
      'Зареди новите продукти button',
    ],
    [
      'browser_take_screenshot — 246',
      'mcp__playwright__browser_take_screenshot',
      { type: 'png', scale: 'css', filename: 'novo-page-final-0717.png' },
      'novo-page-final-0717.png',
    ],
    [
      'browser_run_code_unsafe — 361',
      'mcp__playwright__browser_run_code_unsafe',
      { code: 'await page.goto("https://example.com");' },
      'await page.goto("https://example.com");',
    ],
    ['browser_press_key — 10', 'mcp__playwright__browser_press_key', { key: 'Escape' }, 'Escape'],
    [
      'Workflow started from a file — 18',
      'Workflow',
      { scriptPath: 'C:\\Users\\dev\\scratchpad\\audit.mjs' },
      'C:\\Users\\dev\\scratchpad\\audit.mjs',
    ],
    [
      'ScheduleWakeup — 45',
      'ScheduleWakeup',
      { delaySeconds: 1500, prompt: 'Fallback wakeup: check crop agents batch2/batch3 status', reason: 'hang safety' },
      'Fallback wakeup: check crop agents batch2/batch3 status',
    ],
    [
      // An MCP tool carrying both: the query is what a person would recognize the call by.
      'MCP search tools — query over the library id',
      'mcp__context7__query-docs',
      { libraryId: '/vercel/next.js', query: 'app router streaming' },
      'app router streaming',
    ],
    ['browser_type — element over the text typed into it', 'mcp__playwright__browser_type', { element: 'search box', text: 'flaky', submit: true }, 'search box'],
  ];

  for (const [label, tool, input, want] of CASES) {
    it(`names a call that used to be anonymous: ${label}`, () => {
      expect(targetFor(tool, input)).toBe(want);
    });
  }

  it('flattens a multi-line target, because every reader of one draws it as a single label', () => {
    // 9 661 Bash commands, 479 browser_evaluate functions and 359 run_code bodies span lines; the
    // office puts this on a nameplate 60 characters wide.
    const fn = '() => {\n  const out = {};\n  out.n = document.querySelectorAll("img").length;\n  return out;\n}';
    expect(targetFor('mcp__playwright__browser_evaluate', { function: fn })).toBe(
      '() => { const out = {}; out.n = document.querySelectorAll("img").length; return out; }',
    );
    expect(targetFor('Bash', { command: 'cd /tmp \\\n  && ls -la' })).toBe('cd /tmp \\ && ls -la');
  });

  it('caps a target, because the longest one in the corpus is 35 125 characters', () => {
    const target = targetFor('Bash', { command: `echo ${'x'.repeat(5000)}` });
    expect(target).toBeDefined();
    expect(target!.length).toBeLessThanOrEqual(400);
    expect(target!.endsWith('…')).toBe(true);
  });

  it('declines to invent a target for a call that genuinely has none', () => {
    // The 2.63% left over after the list above, and it should stay left over: inventing a name for
    // these would be worse than the room admitting it does not know.
    expect(targetFor('StructuredOutput', { findings: [1, 2], verdict: 'ok' })).toBeUndefined();
    expect(targetFor('AskUserQuestion', { questions: [{ question: 'which?' }] })).toBeUndefined();
    expect(targetFor('mcp__playwright__browser_close', {})).toBeUndefined();
    expect(targetFor('mcp__playwright__browser_resize', { width: 1280, height: 800 })).toBeUndefined();
  });

  it('treats a present-but-empty field as absent rather than as a target', () => {
    expect(targetFor('Bash', { command: '   ', description: 'Run the suite' })).toBe('Run the suite');
  });

  it('redacts a credential sitting in the target', () => {
    // The list above widened what tool input reaches a socket: a target is now sometimes an SQL
    // statement or a page-evaluate body, not only a path. A command line with a password on it is
    // not hypothetical — one has been typed against a live site on this machine.
    expect(targetFor('Bash', { command: 'mysql -u root --password=CV3EmqxC9 local' })).toBe(
      'mysql -u root --password=*** local',
    );
    expect(targetFor('WebFetch', { url: 'https://api.test/v1?access_token=abcd1234efgh' })).toBe(
      'https://api.test/v1?access_token=***',
    );
  });

  /**
   * The shapes a credential actually appears in.
   *
   * The first version of the redactor opened with `\b`, which fails after an underscore — so
   * `DB_PASSWORD=`, `MYSQL_PWD=` and `ANTHROPIC_API_KEY=` were all missed, which is to say the
   * env-var form, which is the form these keys almost always take. Scanning 400 real transcripts
   * on this machine through the real Normalizer found 45 occurrences across 23 files that the
   * regex written specifically to catch them let straight through.
   */
  it.each([
    ['export DB_PASSWORD=hunter2ABC && ./deploy.sh', 'hunter2ABC'],
    ['MYSQL_PWD=s3cretPass mysql -u root', 's3cretPass'],
    ['export ANTHROPIC_API_KEY=zzzTOPSECRETzzz', 'zzzTOPSECRETzzz'],
    ['export MY_CLIENT_SECRET="a-b-c-d"', 'a-b-c-d'],
    ['curl -H "Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.abcdefgh" https://x', 'eyJhbGciOiJIUzI1NiJ9'],
    ['mysql -uroot -pR00tPassword localdb', 'R00tPassword'],
    ['npm config set _authToken=npm_aaaaaaaaaaaaaaaaaaaaaaaa', 'npm_aaaaaaaaaaaaaaaaaaaaaaaa'],
    ['export KEY=sk-proj-aaaaaaaaaaaaaaaaaaaaaaaa', 'sk-proj-aaaaaaaaaaaaaaaaaaaaaaaa'],
  ])('never puts %j on the wire', (command, secret) => {
    const target = targetFor('Bash', { command });
    expect(target).toBeDefined();
    expect(target).not.toContain(secret);
    expect(target).toContain('***');
  });

  it('redacts without eating the character in front of the key', () => {
    // The pattern has to consume the character before the key to prove it is not part of a longer
    // word, so it has to put it back — otherwise the line it is protecting comes out corrupted.
    expect(targetFor('Bash', { command: 'export DB_PASSWORD=hunter2 && ls' })).toBe(
      'export DB_PASSWORD=*** && ls',
    );
  });

  it('leaves an ordinary command alone', () => {
    // The redactor runs on every target, so a false positive costs every reader of the tools panel.
    expect(targetFor('Bash', { command: 'git commit -m "fix the password reset flow"' })).toBe(
      'git commit -m "fix the password reset flow"',
    );
    expect(targetFor('Bash', { command: 'npm test -- --reporter=verbose' })).toBe(
      'npm test -- --reporter=verbose',
    );
  });

  it('still reports an Agent spawn while naming it', () => {
    const evs = new Normalizer('s', 'main').feed(
      toolUse('Agent', { description: 'Map the office layout', subagent_type: 'Explore', prompt: 'go and look' }),
    );
    expect(evs.find((e) => e.kind === 'agentSpawn')).toMatchObject({ prompt: 'go and look', toolUseId: 'tu_t' });
    expect(evs.find((e) => e.kind === 'toolStart')).toMatchObject({ target: 'Map the office layout' });
  });
});

/**
 * How big an edit was, from the tool's own input.
 *
 * `added`/`removed` are optional on purpose and the distinction is the whole point: absent means
 * "the call did not carry the strings to count", zero means "genuinely zero lines". Emitting 0 for
 * an unknown would let the panel print `+0 −0` for a `Write` that replaced a thousand lines.
 */
const editOf = (name: string, input: Record<string, unknown>) => {
  const ev = new Normalizer('s', 'main').feed(toolUse(name, input)).find((e) => e.kind === 'fileEdit');
  if (ev?.kind !== 'fileEdit') throw new Error('no fileEdit emitted');
  return ev;
};

describe('Normalizer fileEdit sizes', () => {
  it('counts both sides of an Edit', () => {
    expect(editOf('Edit', { file_path: '/a.ts', old_string: 'one\ntwo', new_string: 'a\nb\nc' })).toMatchObject({
      path: '/a.ts',
      removed: 2,
      added: 3,
    });
  });

  it('counts a Write as added lines only — what it removed is not in the call', () => {
    // A `Write` over an existing file removes an unknown number of lines. Saying 0 would be a lie,
    // and the one the panel would print most often, since `Write` is how a file gets replaced.
    const ev = editOf('Write', { file_path: '/a.ts', content: 'x\ny\n' });
    expect(ev).toMatchObject({ path: '/a.ts', added: 2 });
    expect(ev.removed).toBeUndefined();
  });

  it('leaves both absent when the call carries no strings to count', () => {
    const ev = editOf('NotebookEdit', { file_path: '/nb.ipynb', new_source: 'print(1)', edit_mode: 'replace' });
    expect(ev.added).toBeUndefined();
    expect(ev.removed).toBeUndefined();
  });

  it('does not count a trailing newline as another line', () => {
    // `a\nb\n` is two lines in every editor and every diff. Splitting on \n naively says three.
    expect(editOf('Edit', { file_path: '/a.ts', old_string: 'a\nb\n', new_string: 'a\nb' })).toMatchObject({
      removed: 2,
      added: 2,
    });
  });

  it('counts CRLF text the same as LF text', () => {
    // Transcripts written on Windows carry \r\n verbatim; a count that only knows \n is fine here
    // (the \r rides along inside the line) and this pins that it stays fine.
    expect(editOf('Edit', { file_path: '/a.ts', old_string: 'a\r\nb\r\nc', new_string: 'a\r\n' })).toMatchObject({
      removed: 3,
      added: 1,
    });
  });

  it('calls an empty string zero lines, and a lone newline one', () => {
    expect(editOf('Write', { file_path: '/a.ts', content: '' })).toMatchObject({ added: 0 });
    expect(editOf('Write', { file_path: '/a.ts', content: '\n' })).toMatchObject({ added: 1 });
  });

  it('reports the side it can count when the other is missing', () => {
    const ev = editOf('Edit', { file_path: '/a.ts', new_string: 'only this half' });
    expect(ev.added).toBe(1);
    expect(ev.removed).toBeUndefined();
  });

  it('still emits the fileEdit itself when nothing is countable', () => {
    // The path is the event's reason to exist; the sizes are a bonus that must never gate it.
    expect(editOf('Edit', { file_path: '/a.ts' })).toMatchObject({ kind: 'fileEdit', path: '/a.ts' });
  });
});

/**
 * Carrying a failure far enough to be useful.
 *
 * Measured over the same corpus: 2 291 of 84 493 `tool_result` blocks are errors (2.71%), and
 * every one of them carries `content` as a plain string — the array-of-blocks form appears only on
 * successful results, 10 798 of them, mostly returning images. 59% are multi-line, 350 arrive
 * wrapped in `<tool_use_error>`, they average 479 characters and the longest is 10 040.
 */
const toolResult = (block: Record<string, unknown>): Parameters<Normalizer['feed']>[0] => ({
  type: 'user',
  timestamp: '2026-08-03T09:00:00.000Z',
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_1', ...block }] },
});

const resultOf = (block: Record<string, unknown>) => {
  const ev = new Normalizer('s', 'main').feed(toolResult(block)).find((e) => e.kind === 'toolResult');
  if (ev?.kind !== 'toolResult') throw new Error('no toolResult emitted');
  return ev;
};

describe('Normalizer tool errors', () => {
  it('carries the text of a failed Bash call — the commonest shape in the corpus', () => {
    // `Exit code N` then the stderr that explains it: 610 results open "Exit code 1" alone.
    expect(resultOf({ is_error: true, content: 'Exit code 127\n/usr/bin/bash: line 1: php: command not found' })).toMatchObject({
      ok: false,
      error: 'Exit code 127\n/usr/bin/bash: line 1: php: command not found',
    });
  });

  it('keeps the newlines, because the shape is the message', () => {
    expect(resultOf({ is_error: true, content: '### Error\nError: browserBackend.callTool: Target page has been closed' }).error).toContain('\n');
  });

  it('unwraps the CLI\u2019s own <tool_use_error> markup', () => {
    // 350 of 2 291. The tag is not part of what went wrong.
    expect(resultOf({ is_error: true, content: '<tool_use_error>File has not been read yet. Read it first before writing to it.</tool_use_error>' })).toMatchObject({
      error: 'File has not been read yet. Read it first before writing to it.',
    });
  });

  it('reads the array-of-blocks form too, though no failure in the corpus uses it', () => {
    // 10 798 *successful* results do, so the shape is real and a later vintage could use it here.
    expect(
      resultOf({
        is_error: true,
        content: [
          { type: 'text', text: 'Exit code 1' },
          { type: 'image', source: { type: 'base64', data: 'iVBOR…' } },
          { type: 'text', text: 'ENOENT: no such file or directory' },
        ],
      }).error,
    ).toBe('Exit code 1\nENOENT: no such file or directory');
  });

  it('says nothing about a call that succeeded', () => {
    const ev = resultOf({ content: 'ok, 40 files' });
    expect(ev.ok).toBe(true);
    expect(ev.error).toBeUndefined();
  });

  it('leaves the field off a failure that carried no text at all', () => {
    // Not the same as an empty message: the panel tells the reader the transcript recorded none.
    expect(resultOf({ is_error: true, content: '   ' }).error).toBeUndefined();
    expect(resultOf({ is_error: true }).error).toBeUndefined();
  });

  it('truncates a long failure and marks that it did', () => {
    const err = resultOf({ is_error: true, content: `Exit code 1\n${'stack frame\n'.repeat(400)}` }).error;
    expect(err).toBeDefined();
    expect(err!.length).toBeLessThanOrEqual(600);
    expect(err!.startsWith('Exit code 1')).toBe(true); // the head is where the sentence is
    expect(err!.endsWith('…')).toBe(true);
  });

  it('redacts a credential the failure echoed back', () => {
    // Real and not rare enough to ignore: 5 of the corpus's 2 291 errors are a Python traceback
    // re-printing the connect() call that raised, password and all.
    const err = resultOf({
      is_error: true,
      content:
        'Traceback (most recent call last):\r\n  File "<string>", line 4, in <module>\r\n' +
        '    c = pymysql.connect(host=\'127.0.0.1\', port=10012, user=\'root\', password=\'CV3EmqxC9\', database=\'local\')\r\n' +
        'pymysql.err.OperationalError: (1045, "Access denied")',
    }).error;
    expect(err).toBeDefined();
    expect(err).not.toContain('CV3EmqxC9');
    expect(err).toContain("password='***'"); // the key survives, so the message still reads
    expect(err).toContain('Access denied'); // and so does everything that is not the secret
    expect(err).not.toContain('\r'); // CRLF normalized on the way through
  });

  it('redacts a token that needs no key beside it to be recognizable', () => {
    // Two rules can both claim this line — the `Authorization:` header shape and the `sk-ant-`
    // prefix — and the header one runs first, so the whole credential goes rather than its tail.
    // The assertion is therefore on what must be true (the secret is not on the wire, and the
    // reader can see something was removed) rather than on which rule got there first.
    const err = resultOf({ is_error: true, content: 'HTTP 401 for Authorization: Bearer sk-ant-api03-AAAABBBBCCCCDDDD' }).error;
    expect(err).not.toContain('AAAABBBBCCCCDDDD');
    expect(err).not.toContain('sk-ant-api03');
    expect(err).toContain('***');
    expect(err).toContain('HTTP 401'); // everything that is not the secret still reads
  });

  it('redacts a bare token with no header in front of it', () => {
    const err = resultOf({ is_error: true, content: 'bad key sk-ant-api03-AAAABBBBCCCCDDDD rejected' }).error;
    expect(err).not.toContain('AAAABBBBCCCCDDDD');
    expect(err).toContain('sk-ant-***');
  });
});

describe('Normalizer edge cases', () => {
  it('falls back to a sensible ts when timestamp is missing', () => {
    const n = new Normalizer('s', 'main');
    const before = Date.now();
    const [seen] = n.feed({ type: 'user', message: { role: 'user', content: 'hi' } });
    const after = Date.now();
    expect(seen.ts).toBeGreaterThanOrEqual(before);
    expect(seen.ts).toBeLessThanOrEqual(after);
  });

  it('skips whitespace-only thinking blocks', () => {
    const n = new Normalizer('s', 'main');
    const evs = n.feed({
      type: 'assistant',
      timestamp: '2026-08-02T10:00:00.000Z',
      message: { role: 'assistant', content: [{ type: 'thinking', thinking: '   ' }] },
    });
    expect(evs.some((e) => e.kind === 'thinking')).toBe(false);
  });

  it('does not emit agentText for a text block on a non-assistant message', () => {
    const n = new Normalizer('s', 'main');
    const evs = n.feed({
      type: 'user',
      timestamp: '2026-08-02T10:00:00.000Z',
      message: { role: 'user', content: [{ type: 'text', text: 'not really agent text' }] },
    });
    expect(evs.some((e) => e.kind === 'agentText')).toBe(false);
  });

  it('keeps seq monotonic across two separate Normalizer instances', () => {
    const a = new Normalizer('s1', 'main');
    const b = new Normalizer('s2', 'main');
    const evsA = a.feed({
      type: 'user',
      timestamp: '2026-08-02T10:00:00.000Z',
      message: { role: 'user', content: 'hi' },
    });
    const evsB = b.feed({
      type: 'user',
      timestamp: '2026-08-02T10:00:01.000Z',
      message: { role: 'user', content: 'hello' },
    });
    expect(evsB[0].seq).toBeGreaterThan(evsA[evsA.length - 1].seq);
  });

  /**
   * The redactor became a prose problem the moment the human's own lane started going through it.
   *
   * `SECRET_MYSQL_P` exists for `mysql -phunter2`, where the password is glued to the flag with no
   * separator at all — so the pattern has to be `-p` followed by a run of non-space. That is a fine
   * trade against a shell command line and a terrible one against English: `find . -print`,
   * `git log -p`, `curl -params` are all ordinary things to type, and the person who typed them
   * would watch their own sentence come back with a `***` in it and have no way to tell whether the
   * app had mangled the text or their prompt really said that.
   */
  /**
   * A skill's own preamble arrives on the `user` lane wearing no marker tag at all.
   *
   * Every other kind of machinery on that lane announces itself — `<local-command-caveat>`,
   * `<system-reminder>`, a hook's `additional context:` line. A skill body does not: it is
   * injected as a plain user turn that opens `Base directory for this skill: …`. So it classified
   * as `human`, which put a filesystem path in the human's mouth in the feed, made it a candidate
   * for the whiteboard task, and — measured across the sessions on this machine — became the
   * session *label* for six of them, where the label's whole job is to say what the human asked
   * for.
   */
  describe('a skill preamble is machinery, not the human', () => {
    it('classifies the skill body as a command rather than as something the human typed', () => {
      expect(
        classifyUserSource('Base directory for this skill: /home/x/.claude/skills/debug\n\n# Debug\n…'),
      ).toBe('command');
    });

    it('leaves a human who happens to write about skills alone', () => {
      expect(classifyUserSource('the base directory for this skill is wrong, please fix it')).toBe('human');
    });
  });

  describe('redaction of prose', () => {
    it('leaves a bare -p flag alone when nothing in the text is a mysql command', () => {
      expect(oneLine('find . -print -type f and then git log -p', 200)).toBe(
        'find . -print -type f and then git log -p',
      );
    });

    it('still masks a password glued to mysql -p', () => {
      expect(oneLine('mysql -uroot -phunter2 mydb', 200)).toBe('mysql -uroot -p*** mydb');
    });

    it('still masks the named-credential and bearer forms in prose, which are unambiguous', () => {
      expect(oneLine('it failed with DB_PASSWORD=hunter2 in the env', 200)).toBe(
        'it failed with DB_PASSWORD=*** in the env',
      );
      expect(oneLine('sent Authorization: Bearer abc.def.ghi', 200)).toBe('sent Authorization: Bearer ***');
    });
  });

  it('never throws on unknown line types or malformed content blocks', () => {
    const n = new Normalizer('s', 'main');
    expect(() =>
      n.feed({ type: 'file-history-snapshot', timestamp: '2026-08-02T10:00:00.000Z' }),
    ).not.toThrow();
    expect(() =>
      n.feed({
        type: 'assistant',
        timestamp: '2026-08-02T10:00:00.000Z',
        message: { role: 'assistant', content: [null, 42, { type: 'bogus' }] },
      }),
    ).not.toThrow();
  });
});

/**
 * A response that resumes after another one interrupted it.
 *
 * `normalize.ts` carried a measured claim — "in 250 sampled transcripts, across 35 101
 * usage-bearing lines, an id never resumed after another id appeared; responses are written
 * contiguously". That claim is false. A real transcript on this machine has 405 distinct message
 * ids across 407 runs: two of them resume after an interruption, and the corpus test caught the
 * consequence — the whole of a resumed response is published a second time, so the session's
 * tokens and its cost read high.
 *
 * The accumulator publishes differences, so the only thing needed to make a resumption harmless is
 * to remember what a response has already reported.
 */
describe('a response interrupted and resumed', () => {
  const usageLine = (id: string, out: number) => ({
    type: 'assistant',
    timestamp: '2026-08-09T20:00:00.000Z',
    message: {
      id,
      role: 'assistant',
      model: 'claude-opus-5',
      content: [{ type: 'text', text: 'x' }],
      usage: { input_tokens: 0, output_tokens: out, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    },
  });

  const totalOut = (evs: ReturnType<Normalizer['feed']>[]): number =>
    evs.flat().reduce((n, e) => (e.kind === 'usage' ? n + e.outTok : n), 0);

  it('bills a resumed response once, not twice', () => {
    const n = new Normalizer('s', 'main');
    const out = [
      n.feed(usageLine('a', 10)),
      n.feed(usageLine('b', 5)), // interrupts a, and flushes it
      n.feed(usageLine('a', 14)), // a resumes, having now billed 14 in total
      n.flush(),
    ];
    // Ground truth is last-wins per id: a billed 14, b billed 5.
    expect(totalOut(out)).toBe(19);
  });

  it('still publishes nothing for a resumption that added nothing', () => {
    const n = new Normalizer('s', 'main');
    const out = [n.feed(usageLine('a', 10)), n.feed(usageLine('b', 5)), n.feed(usageLine('a', 10)), n.flush()];
    expect(totalOut(out)).toBe(15);
  });

  it('still bills once when the resumption comes hundreds of responses later', () => {
    // The distance is the whole point, and the reason this test exists as well as the one above.
    // A first fix remembered only the last 64 responses, which is plenty for the adjacent case and
    // useless for the real one: in the transcript that exposed this, the two resumed responses came
    // back 270 and 389 distinct responses later, so both had been evicted and the over-count was
    // unchanged. An adjacent-only test passes with a memory of one.
    const n = new Normalizer('s', 'main');
    const out = [n.feed(usageLine('a', 722))];
    for (let i = 0; i < 300; i++) out.push(n.feed(usageLine(`filler${i}`, 1)));
    out.push(n.feed(usageLine('a', 722)));
    out.push(n.flush());
    // `a` billed 722 once, plus 300 fillers of 1.
    expect(totalOut(out)).toBe(722 + 300);
  });

  it('leaves the ordinary contiguous case exactly as it was', () => {
    const n = new Normalizer('s', 'main');
    const out = [n.feed(usageLine('a', 1)), n.feed(usageLine('a', 317)), n.flush()];
    expect(totalOut(out)).toBe(317);
  });
});
