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

  it('creates governance knowledge as drafts linked by governance relations', async () => {
    const link = (from: Entity, to: Entity, type: string) =>
      linkEntities(space.id, { fromId: from.id, toId: to.id, type }, agent);
    const repo = await add({ type: 'repo', key: 'repo:acme/app', title: 'App', content: '' });
    const component = await add({ type: 'component', key: 'component:app/api', title: 'API', content: '' });
    const oldDecision = await add({ type: 'decision', key: 'decision:rest', title: 'Use REST', content: '' });
    const decision = await add({ type: 'decision', key: 'decision:grpc', title: 'Use gRPC', content: '' });
    const principle = await add({
      type: 'principle',
      key: 'principle:no-raw-sql',
      title: 'Never write raw SQL in handlers',
      content: 'Use the query layer.',
      metadata: { polarity: 'forbids' },
    });
    const invariant = await add({
      type: 'invariant',
      key: 'invariant:idempotent-webhooks',
      title: 'Webhooks are idempotent',
      content: '',
      metadata: { state: 'holds', guardRef: 'tests/webhooks.test.ts' },
    });
    for (const entity of [oldDecision, decision, principle, invariant]) expect(entity.status).toBe('draft');

    await link(decision, component, 'applies_to');
    await link(principle, repo, 'applies_to');
    await link(decision, principle, 'establishes');
    await link(decision, invariant, 'establishes');
    await link(decision, principle, 'relaxes');
    await link(decision, oldDecision, 'supersedes');
    expect(await queryRows('select id from relations')).toHaveLength(6);

    await expect(link(principle, repo, 'establishes')).rejects.toThrow(OntologyError);
  });

  it('creates external knowledge and lessons as drafts linked to their anchors', async () => {
    const link = (from: Entity, to: Entity, type: string) =>
      linkEntities(space.id, { fromId: from.id, toId: to.id, type }, agent);
    const dep = await add({
      type: 'dependency',
      key: 'dependency:npm/orm',
      title: 'ORM',
      content: '',
      metadata: { ecosystem: 'npm' },
    });
    const decision = await add({ type: 'decision', key: 'decision:orm', title: 'Use the ORM', content: '' });
    const invariant = await add({
      type: 'invariant',
      key: 'invariant:no-n-plus-one',
      title: 'No N+1 queries',
      content: '',
      metadata: { state: 'holds' },
    });
    const assumption = await add({
      type: 'assumption',
      key: 'assumption:orm-batches-inserts',
      title: 'The ORM batches inserts',
      content: '',
      metadata: { kind: 'runtime', state: 'holds' },
    });
    const gap = await add({
      type: 'gap',
      key: 'gap:orm-lazy-loading',
      title: 'Lazy loading still causes N+1',
      content: '',
      metadata: { state: 'narrowing', pinnedVersion: '2.1.0' },
    });
    const learning = await add({
      type: 'learning',
      key: 'learning:orm-eager-load',
      title: 'Eager-load relations in list endpoints',
      content: '',
      metadata: { kind: 'hindsight' },
    });
    for (const entity of [assumption, gap, learning]) expect(entity.status).toBe('draft');

    await link(assumption, dep, 'about');
    await link(learning, dep, 'about');
    await link(learning, decision, 'references');
    await link(gap, invariant, 'undermines');
    await link(gap, dep, 'waits_for');
    await link(gap, learning, 'relates_to');
    expect(await queryRows('select id from relations')).toHaveLength(6);

    await expect(link(learning, invariant, 'about')).rejects.toThrow(OntologyError);
    expect(await queryRows('select id from relations')).toHaveLength(6);
  });
});
