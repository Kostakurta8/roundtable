import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { claudeRoot, listSessions, subagentFiles } from '../server/sessions';

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

describe('listSessions edge cases', () => {
  it('returns an empty list when projects/ is missing', () => {
    const root = mkdtempSync(join(tmpdir(), 'rt-root-'));
    expect(listSessions(root)).toEqual([]);
  });

  it('ignores non-.jsonl entries at the top level of a slug dir', () => {
    const root = mkdtempSync(join(tmpdir(), 'rt-root-'));
    const slugDir = join(root, 'projects', 'demo');
    // fix-sess/ (a directory, from the subagents scaffold below) and notes.txt must both
    // be skipped — only *.jsonl files at this level count as sessions.
    mkdirSync(join(slugDir, 'fix-sess', 'subagents'), { recursive: true });
    copyFileSync('fixtures/main-session.jsonl', join(slugDir, 'fix-sess.jsonl'));
    writeFileSync(join(slugDir, 'notes.txt'), 'not a session');
    const s = listSessions(root);
    expect(s).toHaveLength(1);
    expect(s[0]).toEqual(
      expect.objectContaining({ sessionId: 'fix-sess', slug: 'demo', file: join(slugDir, 'fix-sess.jsonl') }),
    );
    expect(typeof s[0].mtime).toBe('number');
  });
});

describe('subagentFiles edge cases', () => {
  it('returns an empty list when subagents/ is missing', () => {
    const root = mkdtempSync(join(tmpdir(), 'rt-root-'));
    mkdirSync(join(root, 'projects', 'demo', 'fix-sess'), { recursive: true });
    expect(subagentFiles(root, 'demo', 'fix-sess')).toEqual([]);
  });

  it('returns an empty list when the session directory does not exist at all', () => {
    const root = mkdtempSync(join(tmpdir(), 'rt-root-'));
    expect(subagentFiles(root, 'demo', 'no-such-session')).toEqual([]);
  });

  it('ignores .meta.json sidecar files, matching only agent-*.jsonl', () => {
    const root = mkdtempSync(join(tmpdir(), 'rt-root-'));
    const subagentsDir = join(root, 'projects', 'demo', 'fix-sess', 'subagents');
    mkdirSync(subagentsDir, { recursive: true });
    copyFileSync('fixtures/agent-abc123.jsonl', join(subagentsDir, 'agent-abc123.jsonl'));
    copyFileSync('fixtures/agent-abc123.meta.json', join(subagentsDir, 'agent-abc123.meta.json'));
    const subs = subagentFiles(root, 'demo', 'fix-sess');
    expect(subs).toEqual([expect.objectContaining({ agentId: 'abc123' })]);
  });
});

describe('claudeRoot', () => {
  it('honors ROUNDTABLE_HOME when set', () => {
    const prev = process.env.ROUNDTABLE_HOME;
    const custom = join(tmpdir(), 'rt-custom-home');
    process.env.ROUNDTABLE_HOME = custom;
    try {
      expect(claudeRoot()).toBe(custom);
    } finally {
      if (prev === undefined) delete process.env.ROUNDTABLE_HOME;
      else process.env.ROUNDTABLE_HOME = prev;
    }
  });

  it('falls back to ~/.claude when ROUNDTABLE_HOME is unset', () => {
    const prev = process.env.ROUNDTABLE_HOME;
    delete process.env.ROUNDTABLE_HOME;
    try {
      expect(claudeRoot()).toBe(join(homedir(), '.claude'));
    } finally {
      if (prev !== undefined) process.env.ROUNDTABLE_HOME = prev;
    }
  });
});
