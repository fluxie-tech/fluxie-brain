import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const guard = path.resolve('scripts/floor-guard.mjs');
const dirs: string[] = [];

/** Commits `before` as `file` in a fresh repo, writes `after`, and runs the guard on the change. */
function runGuard(before: string, after: string, file = 'CONSTRAINTS.md'): { status: number | null; output: string } {
  const dir = mkdtempSync(path.join(tmpdir(), 'floor-guard-'));
  dirs.push(dir);
  // Hermetic: the developer's global hooks or commit signing must not run in, or break, the temp repo.
  const config = ['user.name=t', 'user.email=t@example.com', 'core.hooksPath=', 'commit.gpgsign=false'];
  const git = (...args: string[]) => execFileSync('git', [...config.flatMap((c) => ['-c', c]), ...args], { cwd: dir });
  git('init', '-q');
  writeFileSync(path.join(dir, file), `${before}\n`);
  git('add', '.');
  git('commit', '-q', '-m', 'base');
  writeFileSync(path.join(dir, file), `${after}\n`);
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

  it('reads a capitalised direction cell', () => {
    const cap = (today: string) => `| Linhas | ${today}% | 96,6 | Não pode cair |`;
    expect(runGuard(cap('97,1'), cap('97,3'))).toMatchObject({ status: 0 });
  });

  it('compares decimal commas as decimals, not thousands', () => {
    const floor = (n: string) => `| Linhas | ${n} | não pode cair |`;
    expect(runGuard(floor('96,9'), floor('96,10')).output).toContain('threshold-loosened');
    expect(runGuard(floor('96,6'), floor('97'))).toMatchObject({ status: 0 });
  });
});

describe('floor-guard does not guess a direction it cannot see', () => {
  it.each([
    [
      'a tolerance inside a text cell',
      '| Linhas | 97,3% | 96,8 (tolerância 0,5) | não pode cair |',
      '| Linhas | 97,3% | 96,8 (tolerância 5,0) | não pode cair |',
    ],
    [
      'a timeout in the direction cell',
      '| Mutação | 70% | 65 | não pode cair, timeout 60 s |',
      '| Mutação | 70% | 65 | não pode cair, timeout 600 s |',
    ],
    [
      'a row with both directions',
      '| X | 50% | 40 | não pode cair, não pode subir |',
      '| X | 55% | 40 | não pode cair, não pode subir |',
    ],
    [
      'a bullet, which is not a table row',
      '- Cobertura: 80% de linhas, não pode cair',
      '- Cobertura: 85% de linhas, não pode cair',
    ],
    ['a comma thousands separator', '| Bundle | ≤ 500,000 bytes |', '| Bundle | ≤ 1,500,000 bytes |'],
    ['a dot thousands separator', '| Tamanho | ≤ 300 linhas |', '| Tamanho | ≤ 3.000 linhas |'],
  ])('flags a change to %s', (_case, before, after) => {
    expect(runGuard(before, after).status).toBe(1);
  });
});

describe('floor-guard watches the files that enforce the floor', () => {
  const vitest = (floors: string) => `export default { test: { coverage: { thresholds: { ${floors} } } } };`;

  it('flags a coverage floor lowered in vitest.config.ts', () => {
    const result = runGuard(
      vitest('lines: 96.8, branches: 87.3'),
      vitest('lines: 90, branches: 87.3'),
      'vitest.config.ts',
    );
    expect(result.status).toBe(1);
    expect(result.output).toContain('threshold-loosened');
  });

  it('flags a coverage floor dropped from vitest.config.ts', () => {
    const result = runGuard(vitest('lines: 96.8, branches: 87.3'), vitest('lines: 96.8'), 'vitest.config.ts');
    expect(result.output).toContain('threshold-removed');
  });

  it('accepts raising a coverage floor in vitest.config.ts', () => {
    const result = runGuard(
      vitest('lines: 96.8, branches: 87.3'),
      vitest('lines: 97, branches: 87.5'),
      'vitest.config.ts',
    );
    expect(result).toMatchObject({ status: 0 });
  });

  it('flags a new exemption in .constraintsignore, even one that would exempt itself', () => {
    const result = runGuard('# exemptions', '# exemptions\n.constraintsignore', '.constraintsignore');
    expect(result.status).toBe(1);
    expect(result.output).toContain('new-exemption');
  });

  it('accepts a comment added to .constraintsignore', () => {
    expect(runGuard('# exemptions', '# exemptions\n# why each entry exists', '.constraintsignore')).toMatchObject({
      status: 0,
    });
  });
});
