import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createSpace,
  type Entity,
  type EntityInput,
  linkEntities,
  OntologyError,
  type Space,
  upsertEntity,
} from '../../src/core-graph/index.ts';
import { DEVELOPMENT_GRAPH, registerPresets } from '../../src/presets/index.ts';
import { queryRows, truncateAll } from '../setup/db.ts';

const agent = 'agent:test';

async function expectNothingWritten(): Promise<void> {
  expect(await queryRows('select id from entities')).toHaveLength(0);
  expect(await queryRows('select id from change_log')).toHaveLength(0);
}

describe('development graph through core-graph', () => {
  let space: Space;
  const add = async (input: EntityInput): Promise<Entity> => (await upsertEntity(space.id, input, agent)).entity;

  beforeAll(() => {
    registerPresets();
    registerPresets();
  });
  beforeEach(async () => {
    await truncateAll();
    space = await createSpace({ slug: 'dev', name: 'Dev', preset: DEVELOPMENT_GRAPH });
  });

  it('creates a space with the preset and structural entities born approved', async () => {
    expect(space.preset).toBe('development-graph');
    const repo = await add({
      type: 'repo',
      key: 'repo:acme/app',
      title: 'App',
      content: '',
      metadata: { host: 'github' },
    });
    const component = await add({ type: 'component', key: 'component:app/api', title: 'API', content: '' });
    const dep = await add({
      type: 'dependency',
      key: 'dependency:npm/zod',
      title: 'Zod',
      content: '',
      metadata: { ecosystem: 'npm' },
    });
    const spec = await add({
      type: 'spec',
      key: 'spec:app/SPEC.md',
      title: 'Spec',
      content: '',
      metadata: { location: 'SPEC.md' },
    });
    for (const entity of [repo, component, dep, spec]) expect(entity.status).toBe('approved');

    await linkEntities(space.id, { fromId: component.id, toId: repo.id, type: 'part_of' }, agent);
    await linkEntities(space.id, { fromId: repo.id, toId: dep.id, type: 'depends_on' }, agent);
    await linkEntities(space.id, { fromId: spec.id, toId: component.id, type: 'describes' }, agent);
    expect(await queryRows('select id from relations')).toHaveLength(3);
  });

  it('rejects a type outside the preset and writes nothing', async () => {
    await expect(add({ type: 'issue', key: 'issue:1', title: 'Bug', content: '' })).rejects.toThrow(OntologyError);
    await expectNothingWritten();
  });

  it('rejects metadata with an unknown key and writes nothing', async () => {
    const input = { type: 'repo', key: 'repo:acme/app', title: 'App', content: '', metadata: { stars: 10 } };
    await expect(add(input)).rejects.toThrow(/Invalid metadata for "repo"/);
    await expectNothingWritten();
  });

  it('rejects a relation outside its endpoints', async () => {
    const repo = await add({ type: 'repo', key: 'repo:acme/app', title: 'App', content: '' });
    const component = await add({ type: 'component', key: 'component:app/api', title: 'API', content: '' });
    const link = { fromId: repo.id, toId: component.id, type: 'part_of' };
    await expect(linkEntities(space.id, link, agent)).rejects.toThrow(OntologyError);
    expect(await queryRows('select id from relations')).toHaveLength(0);
  });
});
