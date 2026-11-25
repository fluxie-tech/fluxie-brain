import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createSpace,
  getEntity,
  NotFoundError,
  recordUsage,
  registerOntology,
  type Space,
  setStatus,
  upsertEntity,
} from '../../src/core-graph/index.ts';
import { TEST_PRESET, testOntology } from '../fixtures/ontology.ts';
import { queryRows, truncateAll } from '../setup/db.ts';

const agent = 'agent:test';
const curator = 'human:owner';

describe('status, usage and space isolation', () => {
  let space: Space;
  let otherSpace: Space;

  beforeAll(() => registerOntology(TEST_PRESET, testOntology));
  beforeEach(async () => {
    await truncateAll();
    space = await createSpace({ slug: 'dev', name: 'Dev', preset: TEST_PRESET });
    otherSpace = await createSpace({ slug: 'other', name: 'Other', preset: TEST_PRESET });
  });

  const newLearning = async (key = 'l1') =>
    (await upsertEntity(space.id, { type: 'learning', key, title: 'T', content: 'C' }, agent)).entity;

  describe('setStatus', () => {
    it('changes the status, bumps the version and logs one status change', async () => {
      const draft = await newLearning();
      const approved = await setStatus(space.id, draft.id, 'approved', curator);
      expect(approved).toMatchObject({ status: 'approved', version: 2 });
      const log = await queryRows(`select actor, before, after from change_log where action = 'status'`);
      expect(log).toHaveLength(1);
      expect(log[0]).toMatchObject({ actor: curator, before: { status: 'draft' }, after: { status: 'approved' } });
    });

    it('fails with NotFoundError for an entity of another space', async () => {
      const draft = await newLearning();
      await expect(setStatus(otherSpace.id, draft.id, 'approved', curator)).rejects.toThrow(NotFoundError);
    });

    it('fails with NotFoundError for a malformed id', async () => {
      await expect(setStatus(space.id, 'not-a-uuid', 'approved', curator)).rejects.toThrow(NotFoundError);
    });
  });

  describe('recordUsage', () => {
    it('increments usage without bumping the version or writing to the change log', async () => {
      const draft = await newLearning();
      await recordUsage(space.id, [draft.id]);
      await recordUsage(space.id, [draft.id]);
      const after = await getEntity(space.id, 'l1');
      expect(after).toMatchObject({ usageCount: 2, version: 1 });
      expect(after?.lastUsedAt).toBeInstanceOf(Date);
      expect(await queryRows('select id from change_log')).toHaveLength(1); // only the create
    });

    it('fails with NotFoundError and updates nothing when an id belongs to another space', async () => {
      const mine = await newLearning('mine');
      const theirs = (await upsertEntity(otherSpace.id, { type: 'learning', key: 'x', title: 'X', content: '' }, agent))
        .entity;
      await expect(recordUsage(space.id, [mine.id, theirs.id])).rejects.toThrow(NotFoundError);
      expect(await getEntity(space.id, 'mine')).toMatchObject({ usageCount: 0 });
    });
  });

  describe('upsert on a rejected or deprecated entity', () => {
    it.each(['rejected', 'deprecated'] as const)(
      'applies the change and returns a %s entity to draft',
      async (status) => {
        const draft = await newLearning();
        await setStatus(space.id, draft.id, status, curator);
        const { entity } = await upsertEntity(
          space.id,
          { type: 'learning', key: 'l1', title: 'T2', content: 'C' },
          agent,
        );
        expect(entity).toMatchObject({ title: 'T2', status: 'draft' });
      },
    );
  });

  it('leaves a rejected entity rejected when an identical upsert re-proposes it', async () => {
    const draft = await newLearning();
    await setStatus(space.id, draft.id, 'rejected', curator);
    const { entity } = await upsertEntity(space.id, { type: 'learning', key: 'l1', title: 'T', content: 'C' }, agent);
    expect(entity.status).toBe('rejected');
  });

  it('does not find an entity by key from another space', async () => {
    await newLearning();
    expect(await getEntity(otherSpace.id, 'l1')).toBeNull();
  });
});
