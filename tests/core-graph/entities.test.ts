import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createSpace,
  getEntity,
  NotFoundError,
  OntologyError,
  registerOntology,
  type Space,
  upsertEntity,
  VersionConflictError,
} from '../../src/core-graph/index.ts';
import { TEST_PRESET, testOntology } from '../fixtures/ontology.ts';
import { queryRows, truncateAll } from '../setup/db.ts';

const agent = 'agent:test';
const MISSING_ID = '00000000-0000-0000-0000-000000000000';

describe('upsertEntity', () => {
  let space: Space;
  let otherSpace: Space;

  beforeAll(() => registerOntology(TEST_PRESET, testOntology));
  beforeEach(async () => {
    await truncateAll();
    space = await createSpace({ slug: 'dev', name: 'Dev', preset: TEST_PRESET });
    otherSpace = await createSpace({ slug: 'other', name: 'Other', preset: TEST_PRESET });
  });

  it('creates a new entity with the type default status and version 1', async () => {
    const { entity } = await upsertEntity(
      space.id,
      { type: 'learning', key: 'l1', title: 'Use RRF', content: 'Fuse rankings' },
      agent,
    );
    expect(entity).toMatchObject({ spaceId: space.id, key: 'l1', status: 'draft', version: 1, createdBy: agent });
  });

  it('uses approved as status when the type default is approved', async () => {
    const { entity } = await upsertEntity(space.id, { type: 'project', key: 'p1', title: 'P', content: '' }, agent);
    expect(entity.status).toBe('approved');
  });

  it('rejects an unknown type and writes nothing', async () => {
    const input = { type: 'meeting', key: 'm1', title: 'M', content: '' };
    await expect(upsertEntity(space.id, input, agent)).rejects.toThrow(OntologyError);
    expect(await queryRows('select id from entities')).toHaveLength(0);
    expect(await queryRows('select id from change_log')).toHaveLength(0);
  });

  it('rejects invalid metadata and writes nothing', async () => {
    const input = { type: 'rule', key: 'r1', title: 'R', content: '', metadata: { severity: 'urgent' } };
    await expect(upsertEntity(space.id, input, agent)).rejects.toThrow(OntologyError);
    expect(await queryRows('select id from entities')).toHaveLength(0);
    expect(await queryRows('select id from change_log')).toHaveLength(0);
  });

  it('updates an existing draft with the same key instead of duplicating it', async () => {
    await upsertEntity(space.id, { type: 'learning', key: 'l1', title: 'v1', content: 'a' }, agent);
    const { entity } = await upsertEntity(space.id, { type: 'learning', key: 'l1', title: 'v2', content: 'b' }, agent);
    expect(entity).toMatchObject({ title: 'v2', content: 'b', version: 2 });
    expect(await queryRows('select id from entities')).toHaveLength(1);
  });

  it('creates a separate entity for the same key in another space', async () => {
    const a = await upsertEntity(space.id, { type: 'learning', key: 'l1', title: 'A', content: '' }, agent);
    const b = await upsertEntity(otherSpace.id, { type: 'learning', key: 'l1', title: 'B', content: '' }, agent);
    expect(a.entity.id).not.toBe(b.entity.id);
  });

  it('rejects reusing a key with a different type', async () => {
    await upsertEntity(space.id, { type: 'learning', key: 'k', title: 'L', content: '' }, agent);
    const input = { type: 'project', key: 'k', title: 'P', content: '' };
    await expect(upsertEntity(space.id, input, agent)).rejects.toThrow(OntologyError);
  });

  it('rejects a stale expectedVersion', async () => {
    await upsertEntity(space.id, { type: 'learning', key: 'l1', title: 'v1', content: '' }, agent);
    await upsertEntity(space.id, { type: 'learning', key: 'l1', title: 'v2', content: '' }, agent);
    const stale = { type: 'learning', key: 'l1', title: 'v3', content: '', expectedVersion: 1 };
    await expect(upsertEntity(space.id, stale, agent)).rejects.toThrow(VersionConflictError);
  });

  it('fails with NotFoundError for an unknown space', async () => {
    const input = { type: 'learning', key: 'l1', title: 'x', content: '' };
    await expect(upsertEntity(MISSING_ID, input, agent)).rejects.toThrow(NotFoundError);
  });

  it('changes content_hash when title or content change, but not when only metadata changes', async () => {
    const hashOf = async () =>
      (await queryRows<{ content_hash: string }>(`select content_hash from entities where key = 'l1'`))[0]
        ?.content_hash;
    await upsertEntity(space.id, { type: 'learning', key: 'l1', title: 'T', content: 'C' }, agent);
    const h1 = await hashOf();
    await upsertEntity(
      space.id,
      { type: 'learning', key: 'l1', title: 'T', content: 'C', metadata: { cause: 'x' } },
      agent,
    );
    expect(await hashOf()).toBe(h1);
    await upsertEntity(space.id, { type: 'learning', key: 'l1', title: 'T', content: 'C2' }, agent);
    expect(await hashOf()).not.toBe(h1);
  });

  it('logs one change per write with actor, before and after', async () => {
    const { entity } = await upsertEntity(space.id, { type: 'learning', key: 'l1', title: 'v1', content: '' }, agent);
    await upsertEntity(space.id, { type: 'learning', key: 'l1', title: 'v2', content: '' }, 'human:owner');
    const log = await queryRows(
      'select action, actor, before, after from change_log where target_id = $1 order by id',
      [entity.id],
    );
    expect(log).toHaveLength(2);
    expect(log[0]).toMatchObject({ action: 'create', actor: agent, before: null, after: { title: 'v1' } });
    expect(log[1]).toMatchObject({
      action: 'update',
      actor: 'human:owner',
      before: { title: 'v1' },
      after: { title: 'v2' },
    });
  });
});

describe('upsertEntity without effective changes', () => {
  let space: Space;

  beforeAll(() => registerOntology(TEST_PRESET, testOntology));
  beforeEach(async () => {
    await truncateAll();
    space = await createSpace({ slug: 'dev', name: 'Dev', preset: TEST_PRESET });
  });

  it('keeps the existing metadata when an update omits it', async () => {
    const base = { type: 'learning', key: 'l1', title: 'T', content: 'C' };
    await upsertEntity(space.id, { ...base, metadata: { cause: 'timeout' } }, agent);
    const { entity } = await upsertEntity(space.id, { ...base, content: 'C2' }, agent);
    expect(entity).toMatchObject({ content: 'C2', metadata: { cause: 'timeout' } });
  });

  it('writes nothing for an upsert identical to the current draft', async () => {
    const input = { type: 'learning', key: 'l1', title: 'T', content: 'C', metadata: { cause: 'x' }, confidence: 0.25 };
    await upsertEntity(space.id, input, agent);
    const { entity } = await upsertEntity(space.id, input, agent);
    expect(entity.version).toBe(1);
    expect(await queryRows('select id from change_log')).toHaveLength(1);
  });
});

describe('getEntity', () => {
  beforeAll(() => registerOntology(TEST_PRESET, testOntology));
  beforeEach(() => truncateAll());

  it('returns the entity by key within its space, or null', async () => {
    const space = await createSpace({ slug: 'dev', name: 'Dev', preset: TEST_PRESET });
    await upsertEntity(space.id, { type: 'learning', key: 'l1', title: 'T', content: 'C' }, agent);
    expect(await getEntity(space.id, 'l1')).toMatchObject({ key: 'l1', title: 'T' });
    expect(await getEntity(space.id, 'missing')).toBeNull();
  });
});
