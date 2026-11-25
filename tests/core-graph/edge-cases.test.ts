import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  acceptProposal,
  ConflictError,
  createSpace,
  getEntity,
  NotFoundError,
  OntologyError,
  recordUsage,
  registerOntology,
  type Space,
  upsertEntity,
  VersionConflictError,
} from '../../src/core-graph/index.ts';
import { TEST_PRESET, testOntology } from '../fixtures/ontology.ts';
import { appClient, queryRows, truncateAll } from '../setup/db.ts';

const agent = 'agent:test';

/** Polls until some session of this database is waiting on a lock (the upsert's insert hit the rival's row). */
async function waitUntilBlockedOnLock(): Promise<void> {
  for (let i = 0; i < 100; i++) {
    const [row] = await queryRows<{ n: number }>(
      `select count(*)::int as n from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock'`,
    );
    if ((row?.n ?? 0) > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('upsert never blocked on the rival insert');
}

describe('edge cases', () => {
  let space: Space;

  beforeAll(() => registerOntology(TEST_PRESET, testOntology));
  beforeEach(async () => {
    await truncateAll();
    space = await createSpace({ slug: 'dev', name: 'Dev', preset: TEST_PRESET });
  });

  it('lets exactly one of two concurrent creates of the same key win; the other gets VersionConflictError', async () => {
    const input = (title: string) => ({ type: 'learning', key: 'race', title, content: '' });
    const results = await Promise.allSettled([
      upsertEntity(space.id, input('A'), agent),
      upsertEntity(space.id, input('B'), agent),
    ]);
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(await queryRows(`select id from entities where key = 'race'`)).toHaveLength(1);
    // Either the second call serialized behind the first (update) or it lost the insert race.
    for (const r of rejected) expect(r.reason).toBeInstanceOf(VersionConflictError);
  });

  it('maps a lost insert race to VersionConflictError, deterministically', async () => {
    // A competing transaction inserts the same key and holds it uncommitted until the upsert is blocked on it.
    const rival = appClient();
    await rival.connect();
    try {
      await rival.query('begin');
      await rival.query(
        `insert into entities (space_id, type, key, title, status, created_by) values ($1, 'learning', 'race', 'R', 'draft', 'agent:rival')`,
        [space.id],
      );
      const upsert = upsertEntity(space.id, { type: 'learning', key: 'race', title: 'U', content: '' }, agent);
      await waitUntilBlockedOnLock();
      await rival.query('commit');
      await expect(upsert).rejects.toThrow(VersionConflictError);
    } finally {
      await rival.end();
    }
  });

  it('applies a proposal once when two curators accept it concurrently', async () => {
    const rule = { type: 'rule', key: 'r1', title: 'A', content: '', metadata: { severity: 'low' } };
    await upsertEntity(space.id, rule, agent);
    const { proposal } = await upsertEntity(space.id, { ...rule, title: 'B' }, agent);
    const results = await Promise.allSettled([
      acceptProposal(space.id, proposal?.id ?? '', 'human:a'),
      acceptProposal(space.id, proposal?.id ?? '', 'human:b'),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const failure = results.find((r) => r.status === 'rejected');
    expect(failure?.status === 'rejected' && failure.reason).toBeInstanceOf(ConflictError);
    expect(await getEntity(space.id, 'r1')).toMatchObject({ title: 'B', version: 2 });
  });

  it.each([1.5, -0.1, Number.NaN])(
    'rejects confidence %s with OntologyError and writes nothing',
    async (confidence) => {
      const input = { type: 'learning', key: 'c', title: 'C', content: '', confidence };
      await expect(upsertEntity(space.id, input, agent)).rejects.toThrow(OntologyError);
      expect(await queryRows('select id from entities')).toHaveLength(0);
    },
  );

  it('treats a repeated high-precision confidence as no change (stored as float32)', async () => {
    const input = { type: 'learning', key: 'f', title: 'T', content: 'C', confidence: 0.123456789 };
    await upsertEntity(space.id, input, agent);
    const { entity } = await upsertEntity(space.id, input, agent);
    expect(entity.version).toBe(1);
    expect(await queryRows('select id from change_log')).toHaveLength(1);
  });

  it('counts a repeated id once in recordUsage', async () => {
    const { entity } = await upsertEntity(space.id, { type: 'learning', key: 'l', title: 'L', content: '' }, agent);
    await recordUsage(space.id, [entity.id, entity.id]);
    expect(await getEntity(space.id, 'l')).toMatchObject({ usageCount: 1 });
  });

  it('treats a malformed space id as missing', async () => {
    await expect(getEntity('not-a-uuid', 'x')).rejects.toThrow(NotFoundError);
  });
});
