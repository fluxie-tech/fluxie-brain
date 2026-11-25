import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createSpace,
  type Entity,
  getEntity,
  linkEntities,
  NotFoundError,
  OntologyError,
  registerOntology,
  type Space,
  unlink,
  upsertEntity,
} from '../../src/core-graph/index.ts';
import { TEST_PRESET, testOntology } from '../fixtures/ontology.ts';
import { queryRows, truncateAll } from '../setup/db.ts';

const agent = 'agent:test';

describe('relations', () => {
  let space: Space;
  let otherSpace: Space;
  let learning: Entity;
  let project: Entity;
  let rule: Entity;

  beforeAll(() => registerOntology(TEST_PRESET, testOntology));
  beforeEach(async () => {
    await truncateAll();
    space = await createSpace({ slug: 'dev', name: 'Dev', preset: TEST_PRESET });
    otherSpace = await createSpace({ slug: 'other', name: 'Other', preset: TEST_PRESET });
    learning = (await upsertEntity(space.id, { type: 'learning', key: 'l1', title: 'L', content: '' }, agent)).entity;
    project = (await upsertEntity(space.id, { type: 'project', key: 'p1', title: 'P', content: '' }, agent)).entity;
    rule = (
      await upsertEntity(
        space.id,
        { type: 'rule', key: 'r1', title: 'R', content: '', metadata: { severity: 'low' } },
        agent,
      )
    ).entity;
  });

  it('links two entities with a relation the ontology allows and logs it', async () => {
    const relation = await linkEntities(
      space.id,
      { fromId: learning.id, toId: project.id, type: 'learned_from' },
      agent,
    );
    expect(relation).toMatchObject({ fromId: learning.id, toId: project.id, type: 'learned_from', createdBy: agent });
    const log = await queryRows(`select action, actor from change_log where target_kind = 'relation'`);
    expect(log).toEqual([{ action: 'create', actor: agent }]);
  });

  it('rejects a relation type the ontology does not define', async () => {
    await expect(
      linkEntities(space.id, { fromId: learning.id, toId: project.id, type: 'blocks' }, agent),
    ).rejects.toThrow(OntologyError);
  });

  it('rejects a relation whose endpoint types the ontology does not allow', async () => {
    await expect(
      linkEntities(space.id, { fromId: rule.id, toId: project.id, type: 'learned_from' }, agent),
    ).rejects.toThrow(OntologyError);
  });

  it('treats a relation target from another space as missing', async () => {
    const foreign = (await upsertEntity(otherSpace.id, { type: 'project', key: 'p9', title: 'F', content: '' }, agent))
      .entity;
    await expect(
      linkEntities(space.id, { fromId: learning.id, toId: foreign.id, type: 'learned_from' }, agent),
    ).rejects.toThrow(NotFoundError);
  });

  it('is idempotent: linking twice returns the same relation and writes once', async () => {
    const first = await linkEntities(space.id, { fromId: learning.id, toId: project.id, type: 'learned_from' }, agent);
    const second = await linkEntities(space.id, { fromId: learning.id, toId: project.id, type: 'learned_from' }, agent);
    expect(second.id).toBe(first.id);
    expect(await queryRows('select id from relations')).toHaveLength(1);
    expect(await queryRows(`select id from change_log where target_kind = 'relation'`)).toHaveLength(1);
  });

  it('unlinks a relation and logs its previous state', async () => {
    const relation = await linkEntities(
      space.id,
      { fromId: learning.id, toId: project.id, type: 'learned_from' },
      agent,
    );
    await unlink(space.id, relation.id, 'human:owner');
    expect(await queryRows('select id from relations')).toHaveLength(0);
    const log = await queryRows(`select actor, before, after from change_log where action = 'unlink'`);
    expect(log).toEqual([{ actor: 'human:owner', before: expect.objectContaining({ id: relation.id }), after: null }]);
  });

  it('treats ids from another space as missing', async () => {
    const relation = await linkEntities(
      space.id,
      { fromId: learning.id, toId: project.id, type: 'learned_from' },
      agent,
    );
    await expect(unlink(otherSpace.id, relation.id, agent)).rejects.toThrow(NotFoundError);
    await expect(
      linkEntities(otherSpace.id, { fromId: learning.id, toId: project.id, type: 'learned_from' }, agent),
    ).rejects.toThrow(NotFoundError);
  });

  it('includes relations in getEntity', async () => {
    const relation = await linkEntities(
      space.id,
      { fromId: learning.id, toId: project.id, type: 'learned_from' },
      agent,
    );
    expect(await getEntity(space.id, 'p1')).toMatchObject({ relations: [{ id: relation.id }] });
  });
});
