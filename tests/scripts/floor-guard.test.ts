import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const guard = path.resolve('scripts/floor-guard.mjs');
const dirs: string[] = [];

/** Commits `before` as CONSTRAINTS.md in a fresh repo, writes `after`, and runs the guard on the change. */
function runGuard(before: string, after: string): { status: number | null; output: string } {
  const dir = mkdtempSync(path.join(tmpdir(), 'floor-guard-'));
  dirs.push(dir);
  const git = (...args: string[]) =>
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { cwd: dir });
  git('init', '-q');
  writeFileSync(path.join(dir, 'CONSTRAINTS.md'), `${before}\n`);
  git('add', '.');
  git('commit', '-q', '-m', 'base');
  writeFileSync(path.join(dir, 'CONSTRAINTS.md'), `${after}\n`);
  const run = spawnSync('node', [guard], { cwd: dir, encoding: 'utf8' });
  return { status: run.status, output: `${run.stdout}${run.stderr}` };
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('floor-guard thresholds in Portuguese tables', () => {
  const row = (today: string, floor: string) => `| Linhas | ${today}% | ${floor} | não pode cair |`;

  it('accepts raising a floor whose row says "não pode cair"', () => {
    expect(runGuard(row('97,1', '96,6'), row('97,3', '96,8'))).toMatchObject({ status: 0 });
  });

  it('reads the decimal comma as one number', () => {
    expect(runGuard(row('96,9', '96,9'), row('97,0', '97,0'))).toMatchObject({ status: 0 });
  });

  it('still flags lowering that floor', () => {
    const result = runGuard(row('97,1', '96,6'), row('97,1', '96,4'));
    expect(result.status).toBe(1);
    expect(result.output).toContain('threshold-loosened');
  });

  it('reads "não pode subir" as a maximum', () => {
    const max = (n: string) => `| Tempo | ${n} s | não pode subir |`;
    expect(runGuard(max('90'), max('60'))).toMatchObject({ status: 0 });
    expect(runGuard(max('60'), max('90')).output).toContain('threshold-loosened');
  });

  it('keeps flagging changed numbers whose direction it cannot read', () => {
    const plain = (n: string) => `| Orçamento | ${n} s |`;
    expect(runGuard(plain('90'), plain('60')).output).toContain('threshold-changed');
  });
});
