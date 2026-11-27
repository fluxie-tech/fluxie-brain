import { describe, expect, it, vi } from 'vitest';
import { gitleaksScan } from '../../scripts/dogfood-leaks.ts';

// Same stand-in as dogfood-leaks-args.test.ts: only the flags matter here.
const { calls } = vi.hoisted(() => ({ calls: [] as string[][] }));
vi.mock('node:child_process', async () => {
  const { writeFileSync } = await import('node:fs');
  return {
    execFileSync: (_file: string, args: string[]) => {
      calls.push(args);
      writeFileSync(args[args.indexOf('--report-path') + 1] ?? '', '[]');
    },
  };
});

describe('gitleaksScan and inline allow comments', () => {
  it('ignores inline allow comments: the files come from a repo the scan does not control', () => {
    gitleaksScan('some/dir');
    expect(calls[0]).toContain('--ignore-gitleaks-allow');
  });
});
