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
import { queryRows, truncateAll } from '../setup/db.ts';

const agent = 'agent:test';

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
