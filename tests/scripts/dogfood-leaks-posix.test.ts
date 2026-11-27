import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { leakyFiles } from '../../scripts/dogfood-leaks.ts';

const { BS } = vi.hoisted(() => ({ BS: String.fromCharCode(92) })); // a backslash

// Simulates Linux on any OS: path functions are POSIX (a backslash is an ordinary character), and a path with a
// backslash does not exist on disk, which is what the Linux CI saw for `${root}${BS}` + '/docs'.
vi.mock('node:path', async (importOriginal) => {
  const { posix } = await importOriginal<typeof import('node:path')>();
  return { ...posix, default: posix };
});
vi.mock('node:fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs')>();
  return { ...real, existsSync: (p: string) => !String(p).includes(BS) && real.existsSync(p) };
});

describe('leakyFiles with POSIX path semantics (the Linux CI)', () => {
  let root: string;
  const files = [{ path: 'docs/sub/b.md' }];

  beforeAll(() => {
    root = mkdtempSync(`${tmpdir().replaceAll(BS, '/')}/leaks-posix-`);
    mkdirSync(`${root}/docs/sub`, { recursive: true });
    writeFileSync(`${root}/docs/sub/b.md`, 'x');
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it('a source ending in a backslash still reaches the docs folder: the scan gets a slash-only path that exists', () => {
    const targets: string[] = [];
    const scan = (target: string) => {
      targets.push(target);
      return [{ File: `${root}/docs/sub/b.md` }];
    };
    expect([...leakyFiles(`${root}${BS}`, files, scan)]).toEqual(['docs/sub/b.md']);
    expect(targets).toHaveLength(1);
    expect(targets[0]).not.toContain(BS);
  });
});
