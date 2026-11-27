import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createSpace,
  linkEntities,
  NotFoundError,
  registerOntology,
  type Space,
  setStatus,
  upsertEntity,
} from '../../src/core-graph/index.ts';
import { queryShape } from '../../src/embeddings/fusion.ts';
import { EmbeddingConfigError, search } from '../../src/embeddings/index.ts';
import { textLeg } from '../../src/embeddings/legs.ts';
import { modelSpec } from '../../src/embeddings/models.ts';
import { type ProviderConfig, QUERY_TIMEOUT_MS } from '../../src/embeddings/provider.ts';
import { FUSION, searchSpace } from '../../src/embeddings/search.ts';
import { syncSpace } from '../../src/embeddings/sync.ts';
import { TEST_PRESET, testOntology } from '../fixtures/ontology.ts';
import { truncateAll } from '../setup/db.ts';
import { axis, type Stub, startStub } from './stub-provider.ts';

const GEMMA = 'embeddinggemma-2:270m';
const agent = 'agent:test';
// No word in common with the billing project: only the vector leg can find it (fixed vectors in the stub).
const PAYMENTS = 'pagamentos mensais';

describe('search', () => {
  let stub: Stub;
  let space: Space;
  let gemma: ProviderConfig;
  const keyOf = new Map<string, string>();
  const idOf = new Map<string, string>();

  const add = async (spaceId: string, type: string, key: string, content: string) => {
    const metadata = type === 'rule' ? { severity: 'low' } : undefined;
    const result = await upsertEntity(spaceId, { type, key, title: key, content, metadata }, agent);
    keyOf.set(result.entity.id, key);
    idOf.set(key, result.entity.id);
    return result;
  };
  const keys = (r: { hits: { entity: { key: string } }[] }) => r.hits.map((h) => h.entity.key);
  const run = (query: string, opts = {}) => searchSpace(gemma, space.id, query, opts);

  beforeAll(async () => {
    registerOntology(TEST_PRESET, testOntology);
    stub = await startStub();
    const { document, query, dimensions } = modelSpec(GEMMA);
    stub.fixed.set(document('billing', 'invoice generation service'), axis(0, dimensions));
    stub.fixed.set(query(PAYMENTS), axis(0, dimensions));
  });
  afterAll(() => stub.close());
  beforeEach(async () => {
    await truncateAll();
    stub.respond = undefined;
    stub.delayMs = 0;
    gemma = { baseUrl: stub.baseUrl, model: GEMMA, apiKey: undefined };
    space = await createSpace({ slug: 'dev', name: 'Dev', preset: TEST_PRESET });
    await add(space.id, 'learning', 'cache', 'redis cache eviction policy');
    await add(space.id, 'project', 'billing', 'invoice generation service');
    await add(space.id, 'rule', 'naming', 'snake case columns');
    const { entity: old } = await add(space.id, 'learning', 'old', 'redis legacy notes');
    await setStatus(space.id, old.id, 'deprecated', 'human:owner');
    await syncSpace(gemma, space.id, 32);
  });

  it('finds an exact term through the text leg', async () => {
    const result = await run('eviction');
    expect(result.vector).toBe('ok');
    expect(result.hits[0]?.entity.key).toBe('cache');
    expect(result.hits[0]?.ranks.text).toBe(1);
    expect(Object.keys(result.hits[0]?.entity ?? {})).not.toContain('tsv');
  });

  it('finds by meaning through the vector leg when no word is shared', async () => {
    const filter = { spaceId: space.id, statuses: ['approved' as const, 'draft' as const], types: undefined };
    expect(await textLeg(PAYMENTS, filter, 20)).toEqual([]);
    const [top] = (await run(PAYMENTS)).hits;
    expect(top?.entity.key).toBe('billing');
    expect(top?.ranks.vector).toBe(1);
    expect(top?.ranks.text).toBeUndefined();
  });

  it('fuses with the production configuration of the query shape and reports each leg rank', async () => {
    const [top] = (await run('redis cache')).hits;
    expect(top?.entity.key).toBe('cache');
    expect(top?.ranks.vector).toBeGreaterThan(0);
    expect(top?.ranks.text).toBe(1);
    // The graph leg only runs, and only reports a rank, when the shape's configuration gives it a weight.
    expect(top?.ranks.graph !== undefined).toBe(FUSION[queryShape('redis cache')].graph > 0);
    expect(top?.score).toBeGreaterThan(0);
  });

  it('returns hits by non-increasing score, and accepts the largest limit', async () => {
    const { hits } = await run('redis cache invoice snake', { limit: 50 });
    expect(hits.length).toBeGreaterThan(1);
    const scores = hits.map((h) => h.score);
    expect(scores).toEqual([...scores].sort((a, b) => b - a));
  });

  describe('fusion by query shape', () => {
    const { document, query, dimensions } = modelSpec(GEMMA);
    // A unit vector whose cosine with the query vector (axis 5, away from the axis 0 of the billing fixture) is `cos`.
    const unit = (cos: number) => {
      const v = new Array<number>(dimensions).fill(0);
      v[5] = cos;
      v[6] = Math.sqrt(1 - cos * cos);
      return v;
    };

    it('orders a natural question by the vector alone, even if another entity matches every word', async () => {
      const q = 'redis cache eviction policy';
      stub.fixed.set(query(q), unit(1));
      stub.fixed.set(document('near', 'unrelated prose'), unit(0.9));
      stub.fixed.set(document('words', q), unit(0.8));
      await add(space.id, 'learning', 'near', 'unrelated prose');
      await add(space.id, 'learning', 'words', q);
      await syncSpace(gemma, space.id, 32);
      const { hits } = await run(q);
      expect(hits.slice(0, 2).map((h) => h.entity.key)).toEqual(['near', 'words']);
      expect(hits[1]?.ranks.text).toBeGreaterThan(0);
    });

    it('lets the exact term of a code-like query outrank a slightly closer vector', async () => {
      const q = 'config:cache';
      stub.fixed.set(query(q), unit(1));
      stub.fixed.set(document('closer', 'unrelated prose'), unit(0.6));
      stub.fixed.set(document('exact', 'how config:cache behaves'), unit(0.59));
      await add(space.id, 'learning', 'closer', 'unrelated prose');
      await add(space.id, 'learning', 'exact', 'how config:cache behaves');
      await syncSpace(gemma, space.id, 32);
      const { hits } = await run(q);
      expect(hits[0]?.entity.key).toBe('exact');
    });
  });

  it('filters by status (approved and draft by default) and by type', async () => {
    expect(keys(await run('redis'))).not.toContain('old');
    expect(keys(await run('redis', { statuses: ['deprecated'] }))).toEqual(['old']);
    expect(keys(await run('redis', { types: ['project'] }))).toEqual(['billing']);
  });

  it('respects limit and rejects an out-of-range limit, query or depth', async () => {
    expect((await run('redis', { limit: 1 })).hits).toHaveLength(1);
    for (const limit of [0, 51, 1.5]) await expect(run('redis', { limit })).rejects.toThrow(EmbeddingConfigError);
    for (const query of ['', '   ', 'x'.repeat(2001)]) await expect(run(query)).rejects.toThrow(EmbeddingConfigError);
    await expect(run('x'.repeat(2000))).resolves.toMatchObject({ vector: 'ok' });
    await expect(run('redis', { depth: 3 })).rejects.toThrow(EmbeddingConfigError);
    await expect(searchSpace(gemma, 'not-a-uuid', 'redis', {})).rejects.toThrow(NotFoundError);
  });

  it('falls back to the text leg when the provider is down', async () => {
    stub.respond = () => ({ status: 500, body: '{}' });
    const result = await run('eviction');
    expect(result.vector).toBe('unavailable');
    expect(keys(result)).toEqual(['cache']);
    expect(result.hits[0]?.ranks).toEqual({ vector: undefined, text: 1 });
  });

  describe('when the provider is unusable, search answers from the text leg', () => {
    const wrongDims = JSON.stringify({ data: [{ index: 0, embedding: [0.1, 0.2] }] });
    const unusable: [string, () => { status: number; body: string }][] = [
      ['an HTTP 500', () => ({ status: 500, body: '{}' })],
      ['a body that is not JSON', () => ({ status: 200, body: 'oops' })],
      ['vectors of the wrong dimension', () => ({ status: 200, body: wrongDims })],
    ];

    it.each(unusable)('with %s, even for a natural question', async (_name, reply) => {
      stub.respond = reply;
      const result = await run('redis cache eviction policy');
      expect(result.vector).toBe('unavailable');
      expect(keys(result)).toEqual(['cache']);
    });

    it('with a refused connection', async () => {
      const closed = await startStub();
      await closed.close();
      const result = await searchSpace({ ...gemma, baseUrl: closed.baseUrl }, space.id, 'redis cache eviction', {});
      expect(result.vector).toBe('unavailable');
      expect(keys(result)).toEqual(['cache']);
    });

    it('but a configuration error is not hidden as "unavailable"', async () => {
      await expect(searchSpace({ ...gemma, model: 'nope' }, space.id, 'redis', {})).rejects.toThrow(
        EmbeddingConfigError,
      );
    });
  });

  it('gives up on a slow provider within the query timeout and answers from the text', async () => {
    stub.delayMs = QUERY_TIMEOUT_MS + 500;
    const started = performance.now();
    const result = await run('redis cache eviction policy');
    expect(performance.now() - started).toBeLessThan(QUERY_TIMEOUT_MS + 400);
    expect(result.vector).toBe('unavailable');
    expect(keys(result)).toEqual(['cache']);
  });

  it('still finds an entity that has no vector yet, through the text leg', async () => {
    await add(space.id, 'learning', 'fresh', 'zeppelin');
    // Its text rank 1 ties with the vector leg's first hit, so look it up instead of expecting it on top.
    const fresh = (await run('zeppelin')).hits.find((h) => h.entity.key === 'fresh');
    expect(fresh?.ranks).toEqual({ vector: undefined, text: 1 });
  });

  it('compares only vectors of the active model', async () => {
    // Only Gemma vectors exist: a Qwen search must not touch them (their dimension would not even match).
    const result = await searchSpace({ ...gemma, model: 'qwen3-embedding:0.6b' }, space.id, PAYMENTS, {});
    expect(result).toEqual({ hits: [], context: { entities: [], relations: [] }, vector: 'unavailable' });
  });

  it('answers a natural question from the text when the active model has no vectors at all', async () => {
    // EMBEDDINGS_MODEL changed before the sync: an empty vector leg counts as unavailable, not as "nothing found".
    const qwen = { ...gemma, model: 'qwen3-embedding:0.6b' };
    const result = await searchSpace(qwen, space.id, 'redis cache eviction policy', {});
    expect(result.vector).toBe('unavailable');
    expect(keys(result)).toEqual(['cache']);
  });

  it('never returns an entity of another space', async () => {
    const other = await createSpace({ slug: 'other', name: 'Other', preset: TEST_PRESET });
    await add(other.id, 'learning', 'foreign', 'redis cache eviction policy');
    await syncSpace(gemma, other.id, 32);
    expect(keys(await run('redis cache eviction'))).not.toContain('foreign');
  });

  describe('context', () => {
    const ctx = async (depth: 0 | 1 | 2) => {
      const { hits, context } = await run('eviction', { limit: 1, depth });
      expect(hits.map((h) => h.entity.key)).toEqual(['cache']);
      return {
        entities: context.entities.map((e) => [e.key, e.depth]),
        relations: context.relations.map((r) => `${keyOf.get(r.fromId)} ${r.type} ${keyOf.get(r.toId)}`).sort(),
      };
    };

    beforeEach(async () => {
      const link = (from: string, type: string, to: string) =>
        linkEntities(space.id, { fromId: idOf.get(from) ?? '', toId: idOf.get(to) ?? '', type }, agent);
      await link('cache', 'learned_from', 'billing');
      await link('naming', 'applies_to', 'billing');
      await link('old', 'relates_to', 'cache');
    });

    it('is empty at depth 0', async () => {
      expect(await ctx(0)).toEqual({ entities: [], relations: [] });
    });

    it('brings the neighbors at depth 1 and 2, once each, without the hits or other statuses', async () => {
      expect(await ctx(1)).toEqual({ entities: [['billing', 1]], relations: ['cache learned_from billing'] });
      expect(await ctx(2)).toEqual({
        entities: [
          ['billing', 1],
          ['naming', 2],
        ],
        relations: ['cache learned_from billing', 'naming applies_to billing'],
      });
    });

    it('keeps a relation that links two hits', async () => {
      const { hits, context } = await run('redis cache invoice snake', { limit: 50, depth: 1 });
      expect(keys({ hits })).toEqual(expect.arrayContaining(['cache', 'billing', 'naming']));
      const relations = context.relations.map((r) => `${keyOf.get(r.fromId)} ${r.type} ${keyOf.get(r.toId)}`);
      expect(relations.sort()).toEqual(['cache learned_from billing', 'naming applies_to billing']);
    });

    it('never repeats a hit in the context', async () => {
      const { hits, context } = await run('redis cache invoice snake', { limit: 50, depth: 2 });
      const hitIds = new Set(hits.map((h) => h.entity.id));
      expect(context.entities.filter((e) => hitIds.has(e.id))).toEqual([]);
    });
  });

  describe('BM25 text leg', () => {
    const text = (query: string) =>
      textLeg(query, { spaceId: space.id, statuses: ['approved', 'draft', 'deprecated'], types: undefined }, 50).then(
        (hits) => hits.map((h) => keyOf.get(h.id)),
      );

    beforeEach(async () => {
      await add(space.id, 'learning', 'stopwords', 'como como como para de que');
      await add(space.id, 'learning', 'efeitos', 'efeitos duplicados no modo estrito');
      await add(space.id, 'learning', 'fila-a', 'fila de jobs do faturamento');
      await add(space.id, 'learning', 'fila-b', 'fila de jobs das notas');
      await add(space.id, 'learning', 'raro', 'zeppelin pousou na fila');
      await add(space.id, 'learning', 'migration', 'migration of stored notes');
    });

    it('ignores stopwords: a document with only "como" never matches', async () => {
      const keys = await text('como evitar efeitos duplicados');
      expect(keys[0]).toBe('efeitos');
      expect(keys).not.toContain('stopwords');
      expect(await text('como de que para')).toEqual([]);
    });

    it('ignores English-only stopwords too: a document made of them never matches', async () => {
      await add(space.id, 'learning', 'en-stops', 'the of be an the of be an');
      expect(await text('the of be an')).toEqual([]);
    });

    it('ranks a rare exact term above a common one', async () => {
      expect((await text('fila zeppelin'))[0]).toBe('raro');
    });

    it('matches by stem in Portuguese and in English', async () => {
      expect(await text('faturar')).toContain('fila-a');
      expect(await text('migrating')).toContain('migration');
    });

    it('treats symbols and query operators as plain text', async () => {
      expect(await text('¿?! -- && ||')).toEqual([]);
      expect((await text("zeppelin & !pousou | (fila) <-> 'x':*"))[0]).toBe('raro');
    });
  });

  it('reads the provider from the environment in the public function', async () => {
    vi.stubEnv('EMBEDDINGS_BASE_URL', stub.baseUrl);
    try {
      const result = await search(space.id, 'eviction');
      expect(result.vector).toBe('ok');
      expect(result.hits[0]?.entity.key).toBe('cache');
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
