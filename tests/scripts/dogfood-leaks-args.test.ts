import { existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { gitleaksScan } from '../../scripts/dogfood-leaks.ts';

// The real binary is not on the PATH of the CI test job, so the runner is checked against a stand-in that records how
// gitleaks was called and writes the report where it was told to.
const { calls } = vi.hoisted(() => ({ calls: [] as string[][] }));
vi.mock('node:child_process', async () => {
  const { writeFileSync } = await import('node:fs');
  return {
    execFileSync: (_file: string, args: string[]) => {
      calls.push(args);
      writeFileSync(args[args.indexOf('--report-path') + 1] ?? '', '[{"File":"docs/a.md"}]');
    },
  };
});

describe('gitleaksScan arguments', () => {
  beforeEach(() => {
    calls.length = 0;
  });

  it('scans the given path, never fails on findings, redacts them and reads the report back', () => {
    expect(gitleaksScan('some/dir')).toEqual([{ File: 'docs/a.md' }]);
    const args = calls[0] ?? [];
    expect(args.slice(0, 2)).toEqual(['dir', 'some/dir']);
    expect(args[args.indexOf('--exit-code') + 1]).toBe('0');
    expect(args).toContain('--redact');
    expect(args[args.indexOf('--report-format') + 1]).toBe('json');
  });

  it('removes its temporary report folder', () => {
    gitleaksScan('some/dir');
    const report = calls[0]?.[(calls[0]?.indexOf('--report-path') ?? 0) + 1] ?? '';
    expect(report).not.toBe('');
    expect(existsSync(dirname(report))).toBe(false);
  });
});
