import { describe, expect, it } from 'vitest';
import { addedLines, changedCoverage, parseLcov } from '../../scripts/changed-coverage.ts';

const lcov = [
  'SF:C:\\repo\\src\\a.ts',
  'DA:1,1',
  'DA:2,0',
  'DA:3,5',
  'end_of_record',
  'SF:/repo/src/b.ts',
  'DA:1,0',
].join('\n');

const diff = [
  'diff --git a/src/a.ts b/src/a.ts',
  '--- a/src/a.ts',
  '+++ b/src/a.ts',
  '@@ -1,0 +2,2 @@',
  '+changed',
  '+changed',
  'diff --git a/src/c.ts b/src/c.ts',
  '--- a/src/c.ts',
  '+++ /dev/null',
  '@@ -1 +0,0 @@',
].join('\n');

describe('changed-coverage', () => {
  it('parses lcov hit counts per file, normalizing Windows paths', () => {
    const files = parseLcov(lcov);
    expect(files.get('C:/repo/src/a.ts')?.get(2)).toBe(0);
    expect(files.get('/repo/src/b.ts')?.get(1)).toBe(0);
  });

  it('collects added line numbers and skips deleted files', () => {
    const lines = addedLines(diff);
    expect([...(lines.get('src/a.ts') ?? [])]).toEqual([2, 3]);
    expect(lines.has('src/c.ts')).toBe(false);
  });

  it('counts only changed lines that coverage instruments', () => {
    expect(changedCoverage(parseLcov(lcov), addedLines(diff))).toEqual({ covered: 1, total: 2 });
  });

  it('reads a hunk without a count as a single line', () => {
    const one = addedLines('+++ b/src/a.ts\n@@ -5 +7 @@');
    expect([...(one.get('src/a.ts') ?? [])]).toEqual([7]);
  });
});
