import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createSpace,
  type Entity,
  linkEntities,
  NotFoundError,
  neighbors,
  registerOntology,
  type Space,
  setStatus,
  upsertEntity,
} from '../../src/core-graph/index.ts';
import { TEST_PRESET, testOntology } from '../fixtures/ontology.ts';
import { truncateAll } from '../setup/db.ts';

const agent = 'agent:test';

describe('neighbors', () => {
  let space: Space;
  let otherSpace: Space;

  const learning = async (key: string) =>
    (await upsertEntity(space.id, { type: 'learning', key, title: key, content: '' }, agent)).entity;
  const keysByDepth = (slice: { entities: (Entity & { depth: number })[] }) =>
    slice.entities.map((e) => `${e.key}@${e.depth}`).sort();

  beforeAll(() => registerOntology(TEST_PRESET, testOntology));
  beforeEach(async () => {
    await truncateAll();
    space = await createSpace({ slug: 'dev', name: 'Dev', preset: TEST_PRESET });
    otherSpace = await createSpace({ slug: 'other', name: 'Other', preset: TEST_PRESET });
  });

  describe('on a chain l1 -> p1 <- r1', () => {
    let l1: Entity;
    let r1: Entity;

    beforeEach(async () => {
      l1 = await learning('l1');
      const p1 = (await upsertEntity(space.id, { type: 'project', key: 'p1', title: 'P', content: '' }, agent)).entity;
      r1 = (
        await upsertEntity(
          space.id,
          { type: 'rule', key: 'r1', title: 'R', content: '', metadata: { severity: 'low' } },
          agent,
        )
      ).entity;
      await linkEntities(space.id, l1.id, p1.id, 'learned_from', agent);
      await linkEntities(space.id, r1.id, p1.id, 'applies_to', agent);
    });

    it('returns direct neighbors at depth 1', async () => {
      expect(keysByDepth(await neighbors(space.id, l1.id, 1))).toEqual(['p1@1']);
    });

    it('returns neighbors at depth 1 and 2 with the relations between them', async () => {
      const slice = await neighbors(space.id, l1.id, 2);
      expect(keysByDepth(slice)).toEqual(['p1@1', 'r1@2']);
      expect(slice.relations).toHaveLength(2);
    });

    it('only follows the given relation types', async () => {
      const slice = await neighbors(space.id, l1.id, 2, { relationTypes: ['learned_from'] });
      expect(keysByDepth(slice)).toEqual(['p1@1']);
    });

    it('only includes entities with the given statuses', async () => {
      await setStatus(space.id, r1.id, 'rejected', 'human:owner');
      const slice = await neighbors(space.id, l1.id, 2, { statuses: ['draft', 'approved'] });
      expect(keysByDepth(slice)).toEqual(['p1@1']);
    });
  });

  it('terminates on a cycle and returns each neighbor once', async () => {
    const [a, b, c] = [await learning('a'), await learning('b'), await learning('c')];
    if (!a || !b || !c) throw new Error('setup failed');
    await linkEntities(space.id, a.id, b.id, 'relates_to', agent);
    await linkEntities(space.id, b.id, c.id, 'relates_to', agent);
    await linkEntities(space.id, c.id, a.id, 'relates_to', agent);
    const slice = await neighbors(space.id, a.id, 2);
    expect(keysByDepth(slice)).toEqual(['b@1', 'c@1']);
    expect(slice.relations).toHaveLength(3);
  });

  it('treats an entity of another space as missing', async () => {
    const l1 = await learning('l1');
    await expect(neighbors(otherSpace.id, l1.id, 1)).rejects.toThrow(NotFoundError);
  });
});
