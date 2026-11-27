import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { gitleaksScan, leakyFiles } from '../../scripts/dogfood-leaks.ts';

describe('dogfooding leak scan', () => {
  let root: string;
  const files = [{ path: 'README.md' }, { path: 'docs/a.md' }, { path: 'docs/sub/b.md' }];

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'leaks-'));
    mkdirSync(join(root, 'docs', 'sub'), { recursive: true });
    for (const f of files) writeFileSync(join(root, f.path), 'x');
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it('maps absolute findings with backslashes to source-relative paths, even with a trailing separator', () => {
    const scan = (target: string) => (target.endsWith('docs') ? [{ File: join(root, 'docs', 'sub', 'b.md') }] : []);
    for (const source of [root, `${root}\\`, `${root}/`]) {
      expect([...leakyFiles(source, files, scan)]).toEqual(['docs/sub/b.md']);
    }
  });

  it('maps findings when the source is relative to the cwd', () => {
    const source = relative(process.cwd(), root);
    const scan = () => [{ File: join(root, 'README.md') }];
    expect([...leakyFiles(source, files, scan)]).toEqual(['README.md']);
  });

  it('aborts when a finding does not match a file of the list', () => {
    const scan = () => [{ File: join(root, 'docs', 'secret.txt') }];
    expect(() => leakyFiles(root, files, scan)).toThrow('outside the allowlist (docs/secret.txt)');
    expect(() => leakyFiles(root, files, () => [{ File: join(tmpdir(), 'elsewhere.md') }])).toThrow(/outside/);
  });

  it('skips a missing docs folder instead of failing', () => {
    const empty = mkdtempSync(join(tmpdir(), 'leaks-empty-'));
    expect(leakyFiles(empty, [], () => [])).toEqual(new Set());
    rmSync(empty, { recursive: true, force: true });
  });

  it('fails closed when gitleaks cannot run', () => {
    const missing = () => {
      throw Object.assign(new Error('spawn gitleaks ENOENT'), { code: 'ENOENT' });
    };
    expect(() => leakyFiles(root, files, missing)).toThrow(/gitleaks did not run \(ENOENT\)/);
  });

  it('the real runner fails closed with gitleaks off the PATH', () => {
    vi.stubEnv('PATH', '');
    vi.stubEnv('Path', '');
    try {
      expect(() => leakyFiles(root, files, gitleaksScan)).toThrow(/gitleaks did not run/);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
