import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { appClient } from '../setup/db.ts';

describe('database', () => {
  const client = appClient();
  beforeAll(() => client.connect());
  afterAll(() => client.end());

  it('has the pgvector extension installed', async () => {
    const { rows } = await client.query(`select extversion from pg_extension where extname = 'vector'`);
    expect(rows).toHaveLength(1);
  });

  it('lets the app role run queries', async () => {
    const { rows } = await client.query('select 1 as ok');
    expect(rows[0]).toEqual({ ok: 1 });
  });

  it('denies DDL to the app role', async () => {
    await expect(client.query('create table app_should_not_create (id int)')).rejects.toThrow(/permission denied/);
  });
});
