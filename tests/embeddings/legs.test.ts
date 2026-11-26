import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createSpace, linkEntities, registerOntology, type Space, upsertEntity } from '../../src/core-graph/index.ts';
import { runLegs, textLeg } from '../../src/embeddings/legs.ts';
import type { ProviderConfig } from '../../src/embeddings/provider.ts';
import { searchSpace } from '../../src/embeddings/search.ts';
import { syncSpace } from '../../src/embeddings/sync.ts';
import { TEST_PRESET, testOntology } from '../fixtures/ontology.ts';
import { migratorClient, queryRows, truncateAll } from '../setup/db.ts';
import { type Stub, startStub } from './stub-provider.ts';

const GEMMA = 'embeddinggemma-2:270m';
const QWEN = 'qwen3-embedding:0.6b';
const agent = 'agent:test';

describe('search legs', () => {
  let stub: Stub;
  let space: Space;
  let gemma: ProviderConfig;
  const add = (spaceId: string, key: string, content: string, type = 'learning') =>
    upsertEntity(spaceId, { type, key, title: key, content }, agent);
  const filter = () => ({ spaceId: space.id, statuses: ['approved' as const, 'draft' as const], types: undefined });

  beforeAll(async () => {
    registerOntology(TEST_PRESET, testOntology);
    stub = await startStub();
  });
  afterAll(() => stub.close());
  beforeEach(async () => {
    await truncateAll();
    stub.respond = undefined;
    gemma = { baseUrl: stub.baseUrl, model: GEMMA, apiKey: undefined };
    space = await createSpace({ slug: 'dev', name: 'Dev', preset: TEST_PRESET });
  });

  describe('runLegs graph walk', () => {
    beforeEach(async () => {
      const learning = (await add(space.id, 'a', 'alpha')).entity;
      const project = (await add(space.id, 'p', 'unrelated words', 'project')).entity;
      await linkEntities(space.id, { fromId: learning.id, toId: project.id, type: 'learned_from' }, agent);
      await syncSpace(gemma, space.id, 32);
    });

    it('walks from the best vector hits to their neighbors when asked to', async () => {
      const legs = await runLegs(gemma, 'alpha', filter(), { size: 10, graph: true });
      expect(legs.graph).toHaveLength(2);
      expect(legs.graph[0]?.id).toBe(legs.vector?.[0]?.id);
    });

    it('does not walk when the configuration leaves the graph out', async () => {
      expect((await runLegs(gemma, 'alpha', filter(), { size: 10, graph: false })).graph).toEqual([]);
    });

    it('has nothing to walk from when the provider is down', async () => {
      stub.respond = () => ({ status: 500, body: '{}' });
      const legs = await runLegs(gemma, 'alpha', filter(), { size: 10, graph: true });
      expect(legs.vector).toBeUndefined();
      expect(legs.graph).toEqual([]);
    });
  });

  it('keeps vectors of two models with different dimensions apart, so each model searches on its own', async () => {
    await add(space.id, 'k1', 'alpha beta');
    await add(space.id, 'k2', 'gamma delta');
    await syncSpace(gemma, space.id, 32);
    await syncSpace({ ...gemma, model: QWEN }, space.id, 32);
    expect(await queryRows('select 1 from entity_embeddings')).toHaveLength(4);
    for (const model of [GEMMA, QWEN]) {
      const result = await searchSpace({ ...gemma, model }, space.id, 'alpha', {});
      expect(result.vector, model).toBe('ok');
      expect(result.hits.map((h) => h.ranks.vector)).toEqual([1, 2]);
    }
  });

  describe('BM25 text leg: the filters apply before the LIMIT, not to the top results', () => {
    // The leg asks for SIZE candidates. If the space/status filter ran after taking the top SIZE, SIZE stronger
    // matches outside the filter would crowd out the one entity that counts. SIZE of them is the smallest crowd that does.
    const SIZE = 10;
    const crowd = (spaceId: string) =>
      Promise.all(Array.from({ length: SIZE }, (_, i) => add(spaceId, `crowd-${i}`, 'zeppelin zeppelin zeppelin')));

    it('finds the entity of a small space although another space matches the term much more strongly', async () => {
      const big = await createSpace({ slug: 'big', name: 'Big', preset: TEST_PRESET });
      await crowd(big.id);
      await add(space.id, 'mine', 'a single zeppelin in a longer text about nothing else of note');
      expect((await textLeg('zeppelin', filter(), SIZE)).map((h) => h.id)).toHaveLength(1);
    });

    it('finds an approved entity although stronger deprecated ones fill the top results', async () => {
      await crowd(space.id);
      const owner = migratorClient();
      await owner.connect();
      try {
        await owner.query(`update entities set status = 'deprecated' where key like 'crowd-%'`);
      } finally {
        await owner.end();
      }
      await add(space.id, 'mine', 'one zeppelin here and some other words to dilute the score');
      expect((await textLeg('zeppelin', filter(), SIZE)).map((h) => h.id)).toHaveLength(1);
    });
  });
});
