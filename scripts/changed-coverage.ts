// Coverage of changed lines (CONSTRAINTS.md): intersects coverage/lcov.info with the git diff.
// Usage: node scripts/changed-coverage.ts [--base <ref>] [--min <percent>]   (defaults: HEAD, 80)
// Exit codes: 0 ok (or no instrumented changed lines), 1 below threshold, 2 could not run.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

/** Maps each source file in an lcov report to its instrumented lines and hit counts. */
export function parseLcov(lcov: string): Map<string, Map<number, number>> {
  const files = new Map<string, Map<number, number>>();
  let current: Map<number, number> | undefined;
  for (const raw of lcov.split('\n')) {
    const line = raw.trim();
    if (line.startsWith('SF:')) {
      current = new Map();
      files.set(normalize(line.slice(3)), current);
    } else if (line.startsWith('DA:') && current) {
      const [lineNo, hits] = line.slice(3).split(',').map(Number);
      if (lineNo !== undefined && hits !== undefined) current.set(lineNo, hits);
    }
  }
  return files;
}

/** Maps each file in a `git diff --unified=0` to the line numbers it added or changed (new side). */
export function addedLines(diff: string): Map<string, Set<number>> {
  const files = new Map<string, Set<number>>();
  let current: Set<number> | undefined;
  for (const line of diff.split('\n')) {
    if (line.startsWith('+++ ')) {
      const name = line.slice(4).replace(/^b\//, '');
      current = name === '/dev/null' ? undefined : new Set();
      if (current) files.set(normalize(name), current);
    } else if (current) {
      for (const n of hunkLines(line)) current.add(n);
    }
  }
  return files;
}

/** New-side line numbers of a `@@ -a,b +c,d @@` hunk header; empty for any other line. */
function hunkLines(line: string): number[] {
  const hunk = /^@@ -\S+ \+(\d+)(?:,(\d+))? @@/.exec(line);
  if (!hunk) return [];
  const start = Number(hunk[1]);
  const count = hunk[2] === undefined ? 1 : Number(hunk[2]);
  return Array.from({ length: count }, (_, i) => start + i);
}

/** Covered / instrumented counts over the changed lines that the coverage report instruments. */
export function changedCoverage(
  lcov: Map<string, Map<number, number>>,
  changed: Map<string, Set<number>>,
): { covered: number; total: number } {
  let covered = 0;
  let total = 0;
  for (const [file, lines] of changed) {
    const hits = [...lcov.entries()].find(([f]) => f === file || f.endsWith(`/${file}`))?.[1];
    if (!hits) continue;
    for (const n of lines) {
      const h = hits.get(n);
      if (h === undefined) continue;
      total++;
      if (h > 0) covered++;
    }
  }
  return { covered, total };
}

function normalize(p: string): string {
  return p.replaceAll('\\', '/');
}

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(name);
  return i > -1 ? (process.argv[i + 1] ?? fallback) : fallback;
}

function gitDiff(base: string): string {
  const tracked = execFileSync('git', ['diff', '--unified=0', base, '--', 'src'], { encoding: 'utf8' });
  const untracked = execFileSync('git', ['ls-files', '--others', '--exclude-standard', '--', 'src'], {
    encoding: 'utf8',
  })
    .split('\n')
    .filter(Boolean)
    .map((f) => `+++ b/${f}\n@@ -0,0 +1,${readFileSync(f, 'utf8').split('\n').length} @@`);
  return [tracked, ...untracked].join('\n');
}

function main(): number {
  const min = Number(arg('--min', '80'));
  let lcov: string;
  let diff: string;
  try {
    lcov = readFileSync('coverage/lcov.info', 'utf8');
    diff = gitDiff(arg('--base', 'HEAD'));
  } catch (err) {
    console.error(`changed-coverage: could not run (${(err as Error).message}). Run tests with --coverage first.`);
    return 2;
  }
  const { covered, total } = changedCoverage(parseLcov(lcov), addedLines(diff));
  if (total === 0) {
    console.log('changed-coverage: no instrumented changed lines');
    return 0;
  }
  const pct = (covered / total) * 100;
  const verdict = pct >= min ? 'ok' : 'BELOW';
  console.log(`changed-coverage: ${pct.toFixed(1)}% (${covered}/${total} changed lines), min ${min}% -> ${verdict}`);
  return pct >= min ? 0 : 1;
}

if (import.meta.main) process.exit(main());
