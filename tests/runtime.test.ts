import { describe, expect, it } from 'vitest';

describe('runtime', () => {
  it('runs on Node.js 26 or newer', () => {
    const major = Number(process.versions.node.split('.')[0]);
    expect(major).toBeGreaterThanOrEqual(26);
  });
});
