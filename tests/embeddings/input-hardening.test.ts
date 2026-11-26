import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createSpace, registerOntology, type Space, upsertEntity } from '../../src/core-graph/index.ts';
import { EmbeddingConfigError, EmbeddingProviderError } from '../../src/embeddings/index.ts';
import { textLeg } from '../../src/embeddings/legs.ts';
import { modelSpec } from '../../src/embeddings/models.ts';
import { embed, type ProviderConfig } from '../../src/embeddings/provider.ts';
import { searchSpace } from '../../src/embeddings/search.ts';
import { TEST_PRESET, testOntology } from '../fixtures/ontology.ts';
import { truncateAll } from '../setup/db.ts';
import { type Stub, startStub } from './stub-provider.ts';

const GEMMA = 'embeddinggemma-2:270m';

describe('input hardening (owner decisions of the Verify phase)', () => {
  let stub: Stub;
  let space: Space;
  let gemma: ProviderConfig;

  beforeAll(async () => {
    registerOntology(TEST_PRESET, testOntology);
    stub = await startStub();
  });
  afterAll(() => stub.close());
  beforeEach(async () => {
    await truncateAll();
    stub.respond = undefined;
    stub.fixed.clear();
    gemma = { baseUrl: stub.baseUrl, model: GEMMA, apiKey: undefined };
    space = await createSpace({ slug: 'dev', name: 'Dev', preset: TEST_PRESET });
  });

  it('matches a decomposed (NFD) query against the same word stored composed (NFC)', async () => {
    await upsertEntity(space.id, { type: 'learning', key: 'k', title: 'k', content: 'faturação mensal' }, 'agent:t');
    const filter = { spaceId: space.id, statuses: ['approved' as const, 'draft' as const], types: undefined };
    const composed = await textLeg('faturação', filter, 10);
    const decomposed = await textLeg('faturação'.normalize('NFD'), filter, 10);
    expect(composed).toHaveLength(1);
    expect(decomposed.map((h) => h.id)).toEqual(composed.map((h) => h.id));
  });

  describe('statuses and types', () => {
    const run = (opts: object) => searchSpace(gemma, space.id, 'alpha', opts);

    it.each([
      ['an empty statuses list', { statuses: [] }],
      ['a status outside the core-graph enum', { statuses: ['bogus'] }],
      ['an empty types list', { types: [] }],
    ])('rejects %s with a config error that carries no SQL', async (_name, opts) => {
      const err = await run(opts).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(EmbeddingConfigError);
      expect((err as Error).message).not.toMatch(/select|Failed query/i);
    });
  });

  it('rejects a zero-norm vector from the provider (cosine distance is undefined for it)', async () => {
    const { dimensions } = modelSpec(GEMMA);
    stub.respond = () => ({
      status: 200,
      body: JSON.stringify({ data: [{ index: 0, embedding: new Array(dimensions).fill(0) }] }),
    });
    await expect(embed(gemma, ['alpha'])).rejects.toThrow(EmbeddingProviderError);
  });
});
