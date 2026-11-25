import { describe, expect, it, vi } from 'vitest';
// Internal import on purpose: the pool is infrastructure; only the drizzle `db` handle is public (read-only use).
import { pool } from '../../src/core-graph/db.ts';

describe('database pool', () => {
  it('logs an idle client error instead of crashing the process', () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      // With no 'error' listener, EventEmitter would throw this; the pool must handle it.
      expect(() => pool.emit('error', new Error('connection terminated'))).not.toThrow();
      expect(log).toHaveBeenCalledWith('pg idle client error', expect.any(Error));
    } finally {
      log.mockRestore();
    }
  });
});
