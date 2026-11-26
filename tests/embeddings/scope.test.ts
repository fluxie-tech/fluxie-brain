import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createSpace, linkEntities, NotFoundError, type Space, upsertEntity } from '../../src/core-graph/index.ts';
import type { ProviderConfig } from '../../src/embeddings/provider.ts';
import { searchSpace } from '../../src/embeddings/search.ts';
import { syncSpace } from '../../src/embeddings/sync.ts';
import { DEVELOPMENT_GRAPH, developmentGraph, registerPresets } from '../../src/presets/index.ts';
import { corpus, loadCorpus } from '../fixtures/development-graph/load.ts';
import { truncateAll } from '../setup/db.ts';
import { type Stub, startStub } from './stub-provider.ts';

const { scope } = developmentGraph;
const projectOf = new Map(corpus.entities.map((e) => [e.key, e.project]));
const keysOf = (project: string) => corpus.entities.filter((e) => e.project === project).map((e) => e.key);
// Words spread over the whole corpus, so the text leg also has something in every project.
const QUERY = 'sync notas postgres docker laravel react';

describe('search scoped by an anchor (Development Graph rule)', () => {
  let stub: Stub;
  let space: Space;
  let gemma: ProviderConfig;

  // limit 50 is above the corpus size and the vector leg ranks every embedded entity, so hits = the whole scope.
  const scoped = async (key: string, spaceId = space.id) => {
    const result = await searchSpace(gemma, spaceId, QUERY, { anchor: { key, scope }, limit: 50 });
    return result.hits.map((h) => h.entity.key).sort();
  };

  beforeAll(async () => {
    registerPresets();
    stub = await startStub();
  });
  afterAll(() => stub.close());
  beforeEach(async () => {
    await truncateAll();
    gemma = { baseUrl: stub.baseUrl, model: 'embeddinggemma-2:270m', apiKey: undefined };
    space = await createSpace({ slug: 'dev', name: 'Dev', preset: DEVELOPMENT_GRAPH });
    await loadCorpus(space.id);
    await syncSpace(gemma, space.id, 32);
  });

  it.each([
    ['repo:fictora/pebble-web', 'pebble'],
    ['repo:fictora/quarry-api', 'quarry'],
    ['component:fictora/quarry-api/faturamento', 'quarry'],
  ])('from %s returns its own project and the shared items, nothing of the other', async (anchor, own) => {
    expect(await scoped(anchor)).toEqual([...keysOf(own), ...keysOf('shared')].sort());
  });

  it('brings the lessons about the dependencies of a repo component', async () => {
    // editor depends_on npm/react; the learning is about react: 3 hops from the repo, still in scope.
    expect(await scoped('repo:fictora/pebble-web')).toContain('learning:react-strict-mode-double-effects');
  });

  it('without an anchor searches the whole space', async () => {
    const result = await searchSpace(gemma, space.id, QUERY, { limit: 50 });
    const projects = new Set(result.hits.map((h) => projectOf.get(h.entity.key)));
    expect(projects).toEqual(new Set(['pebble', 'quarry', 'shared']));
  });

  it('rejects an anchor that is missing or belongs to another space', async () => {
    await expect(scoped('repo:fictora/nowhere')).rejects.toThrow(NotFoundError);
    const other = await createSpace({ slug: 'other', name: 'Other', preset: DEVELOPMENT_GRAPH });
    await expect(scoped('repo:fictora/pebble-web', other.id)).rejects.toThrow(NotFoundError);
  });

  it('includes a component of another repo used through depends_on, but not its siblings or its repo', async () => {
    const other = await createSpace({ slug: 'small', name: 'Small', preset: DEVELOPMENT_GRAPH });
    const add = async (type: string, key: string, metadata: Record<string, unknown>) =>
      (await upsertEntity(other.id, { type, key, title: key, content: `${key} notas`, metadata }, 'agent:t')).entity.id;
    const link = (fromId: string, toId: string, type: string) =>
      linkEntities(other.id, { fromId, toId, type }, 'agent:t');
    const repo = (ref: string) => add('repo', `repo:${ref}`, { host: 'github', ref, defaultBranch: 'main' });
    const component = (key: string) => add('component', key, { path: 'src', criticality: 'high' });
    const [a, b, ac, bx, by] = [
      await repo('acme/a'),
      await repo('acme/b'),
      await component('component:acme/a/c'),
      await component('component:acme/b/x'),
      await component('component:acme/b/y'),
    ];
    const [aboutX, aboutY] = [
      await add('learning', 'learning:about-x', { kind: 'gotcha' }),
      await add('learning', 'learning:about-y', { kind: 'gotcha' }),
    ];
    await link(ac, a, 'part_of');
    await link(bx, b, 'part_of');
    await link(by, b, 'part_of');
    await link(ac, bx, 'depends_on');
    await link(aboutX, bx, 'about');
    await link(aboutY, by, 'about');
    await syncSpace(gemma, other.id, 32);
    expect(await scoped('repo:acme/a', other.id)).toEqual(
      ['component:acme/a/c', 'component:acme/b/x', 'learning:about-x', 'repo:acme/a'].sort(),
    );
  });
});
