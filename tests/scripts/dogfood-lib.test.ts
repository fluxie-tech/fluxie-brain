import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { estimateTokens, isAllowed, listAllowed, makeBatches } from '../../scripts/dogfood-lib.ts';

describe('dogfooding allowlist', () => {
  it('allows only docs markdown and the root guides', () => {
    for (const p of ['README.md', 'CLAUDE.md', 'AGENTS.md', 'docs/a.md', 'docs/x/y/Z.MD'])
      expect(isAllowed(p), p).toBe(true);
    for (const p of ['src/a.md', 'notes.md', 'docs/a.txt', 'docs/a.php', 'GEMINI.md'])
      expect(isAllowed(p), p).toBe(false);
  });

  it('never allows .env files or excluded folders, at any depth', () => {
    for (const p of [
      '.env',
      '.env.local',
      'docs/.env.md',
      'vendor/x.md',
      'docs/vendor/x.md',
      '.claude/a.md',
      'docs/.agents/s.md',
      'node_modules/r/README.md',
    ]) {
      expect(isAllowed(p), p).toBe(false);
    }
  });

  describe('listAllowed on a fake project', () => {
    let root: string;
    const touch = (rel: string, body = 'x') => {
      mkdirSync(dirname(join(root, rel)), { recursive: true });
      writeFileSync(join(root, rel), body);
    };

    beforeAll(() => {
      root = mkdtempSync(join(tmpdir(), 'dogfood-'));
      for (const rel of ['README.md', '.env', '.env.coolify.local', 'docs/plan.md', 'docs/notes/n.md', 'docs/img.png'])
        touch(rel);
      for (const rel of ['vendor/pkg/README.md', '.claude/agents/a.md', 'docs/.superpowers/s.md', 'src/x.md'])
        touch(rel);
      touch('docs/big.md', 'y'.repeat(10));
    });
    afterAll(() => rmSync(root, { recursive: true, force: true }));

    it('returns the allowed files with sizes, sorted, and nothing else', () => {
      expect(listAllowed(root)).toEqual([
        { path: 'README.md', bytes: 1 },
        { path: 'docs/big.md', bytes: 10 },
        { path: 'docs/notes/n.md', bytes: 1 },
        { path: 'docs/plan.md', bytes: 1 },
      ]);
    });
  });
});

describe('makeBatches', () => {
  const files = [
    { path: 'a', bytes: 40 },
    { path: 'b', bytes: 50 },
    { path: 'c', bytes: 30 },
    { path: 'd', bytes: 500 },
    { path: 'e', bytes: 10 },
  ];

  it('covers every file once, in order, within the byte cap; an oversized file goes alone', () => {
    const batches = makeBatches(files, 100);
    expect(batches.map((b) => b.files)).toEqual([['a', 'b'], ['c'], ['d'], ['e']]);
    expect(batches.map((b) => b.id)).toEqual(['b001', 'b002', 'b003', 'b004']);
    expect(batches.flatMap((b) => b.files).sort()).toEqual(['a', 'b', 'c', 'd', 'e']);
    for (const b of batches) expect(b.bytes <= 100 || b.files.length === 1).toBe(true);
  });

  it('handles no files and rejects a bad cap', () => {
    expect(makeBatches([], 100)).toEqual([]);
    expect(() => makeBatches(files, 0)).toThrow(RangeError);
  });

  it('estimates tokens at about 4 bytes each', () => {
    expect(estimateTokens(10)).toBe(3);
  });
});

describe('dogfooding data stays out of git', () => {
  it('ignores the .dogfood folder', () => {
    expect(readFileSync('.gitignore', 'utf8').split(/\r?\n/)).toContain('.dogfood/');
  });
});
