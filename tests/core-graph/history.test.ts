import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  acceptProposal,
  createSpace,
  getEntity,
  history,
  linkEntities,
  NotFoundError,
  registerOntology,
  rejectProposal,
  revertEntity,
  type Space,
  setStatus,
  unlink,
  upsertEntity,
} from '../../src/core-graph/index.ts';
import { TEST_PRESET, testOntology } from '../fixtures/ontology.ts';
import { queryRows, truncateAll } from '../setup/db.ts';

const agent = 'agent:test';
const curator = 'human:owner';

describe('history and revert', () => {
  let space: Space;
  let otherSpace: Space;

  beforeAll(() => registerOntology(TEST_PRESET, testOntology));
  beforeEach(async () => {
    await truncateAll();
    space = await createSpace({ slug: 'dev', name: 'Dev', preset: TEST_PRESET });
    otherSpace = await createSpace({ slug: 'other', name: 'Other', preset: TEST_PRESET });
  });

  it('reverts content fields to a previous change and keeps key, type and status', async () => {
    const v1 = { type: 'learning', key: 'l1', title: 'v1', content: 'c1', metadata: { cause: 'a' }, confidence: 0.2 };
    const { entity } = await upsertEntity(space.id, v1, agent);
    await upsertEntity(
      space.id,
      { ...v1, title: 'v2', content: 'c2', metadata: { cause: 'b' }, confidence: 0.9 },
      agent,
    );
    await setStatus(space.id, entity.id, 'approved', curator);
    const [create] = await history(space.id, entity.id);

    const reverted = await revertEntity(space.id, entity.id, create?.id ?? 0, curator);

    expect(reverted).toMatchObject({
      key: 'l1',
      type: 'learning',
      status: 'approved',
      title: 'v1',
      content: 'c1',
      metadata: { cause: 'a' },
      version: 4,
    });
    expect(reverted.confidence).toBeCloseTo(0.2);
    const entries = await history(space.id, entity.id);
    expect(entries.map((e) => e.action)).toEqual(['create', 'update', 'status', 'revert']);
  });

  it('includes the entity proposals in its history, in order', async () => {
    const rule = { type: 'rule', key: 'r1', title: 'A', content: '', metadata: { severity: 'low' } };
    const { entity } = await upsertEntity(space.id, rule, agent);
    const { proposal } = await upsertEntity(space.id, { ...rule, title: 'B' }, agent);
    await rejectProposal(space.id, proposal?.id ?? '', curator);
    expect((await history(space.id, entity.id)).map((e) => e.action)).toEqual(['create', 'propose', 'reject']);
  });

  it('rejects a change id that belongs to another entity or a space id that is not the entity space', async () => {
    const { entity: a } = await upsertEntity(space.id, { type: 'learning', key: 'a', title: 'A', content: '' }, agent);
    const { entity: b } = await upsertEntity(space.id, { type: 'learning', key: 'b', title: 'B', content: '' }, agent);
    const [createOfB] = await history(space.id, b.id);
    await expect(revertEntity(space.id, a.id, createOfB?.id ?? 0, curator)).rejects.toThrow(NotFoundError);
    await expect(history(otherSpace.id, a.id)).rejects.toThrow(NotFoundError);
    const [createOfA] = await history(space.id, a.id);
    await expect(revertEntity(otherSpace.id, a.id, createOfA?.id ?? 0, curator)).rejects.toThrow(NotFoundError);
  });

  it('writes exactly one change-log row per write, with actor, before and after', async () => {
    const learning = { type: 'learning', key: 'l1', title: 'v1', content: '' };
    const { entity } = await upsertEntity(space.id, learning, agent); // create
    await upsertEntity(space.id, { ...learning, title: 'v2' }, agent); // update
    const { entity: project } = await upsertEntity(
      space.id,
      { type: 'project', key: 'p1', title: 'P', content: '' },
      agent,
    ); // create
    const relation = await linkEntities(space.id, entity.id, project.id, 'learned_from', agent); // create (relation)
    await unlink(space.id, relation.id, curator); // unlink
    await setStatus(space.id, entity.id, 'approved', curator); // status
    const accepted = (await upsertEntity(space.id, { ...learning, title: 'v3' }, agent)).proposal; // propose
    await acceptProposal(space.id, accepted?.id ?? '', curator); // accept
    const rejected = (await upsertEntity(space.id, { ...learning, title: 'v4' }, agent)).proposal; // propose
    await rejectProposal(space.id, rejected?.id ?? '', curator); // reject
    const [create] = await history(space.id, entity.id);
    await revertEntity(space.id, entity.id, create?.id ?? 0, curator); // revert

    const rows = await queryRows<{ action: string; actor: string; has_before: boolean; has_after: boolean }>(
      'select action, actor, before is not null as has_before, after is not null as has_after from change_log order by id',
    );
    expect(rows.map((r) => [r.action, r.actor, r.has_before, r.has_after])).toEqual([
      ['create', agent, false, true],
      ['update', agent, true, true],
      ['create', agent, false, true],
      ['create', agent, false, true],
      ['unlink', curator, true, false],
      ['status', curator, true, true],
      ['propose', agent, false, true],
      ['accept', curator, true, true],
      ['propose', agent, false, true],
      ['reject', curator, true, true],
      ['revert', curator, true, true],
    ]);
    expect(await getEntity(space.id, 'l1')).toMatchObject({ title: 'v1', status: 'approved' });
  });
});
