import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  acceptProposal,
  createSpace,
  history,
  NotFoundError,
  registerOntology,
  revertEntity,
  type Space,
  upsertEntity,
} from '../../src/core-graph/index.ts';
import { EmbeddingConfigError, EmbeddingProviderError, syncEmbeddings } from '../../src/embeddings/index.ts';
import { modelSpec } from '../../src/embeddings/models.ts';
import type { ProviderConfig } from '../../src/embeddings/provider.ts';
import { syncSpace } from '../../src/embeddings/sync.ts';
import { TEST_PRESET, testOntology } from '../fixtures/ontology.ts';
import { queryRows, truncateAll } from '../setup/db.ts';
import { type Stub, startStub } from './stub-provider.ts';

const GEMMA = 'embeddinggemma-2:270m';
const QWEN = 'qwen3-embedding:0.6b';
const agent = 'agent:test';

describe('syncEmbeddings', () => {
  let stub: Stub;
  let space: Space;
  let gemma: ProviderConfig;

  const learning = (key: string, content: string) =>
    upsertEntity(space.id, { type: 'learning', key, title: key.toUpperCase(), content }, agent);
  const stored = (model = GEMMA) =>
    queryRows<{ key: string; fresh: boolean }>(
      `select e.key, ee.source_hash = e.content_hash as fresh
         from entity_embeddings ee join entities e on e.id = ee.entity_id
        where ee.model = $1 order by e.key`,
      [model],
    );
  const embeddedTexts = () => stub.requests.flatMap((r) => r.input);

  beforeAll(async () => {
    registerOntology(TEST_PRESET, testOntology);
    stub = await startStub();
  });
  afterAll(() => stub.close());
  beforeEach(async () => {
    await truncateAll();
    stub.requests.length = 0;
    stub.respond = undefined;
    gemma = { baseUrl: stub.baseUrl, model: GEMMA, apiKey: undefined };
    space = await createSpace({ slug: 'dev', name: 'Dev', preset: TEST_PRESET });
    await learning('a', 'alpha');
    await learning('b', 'beta');
    await learning('c', 'gamma');
  });

  it('embeds every entity of the space in batches, with the model document template', async () => {
    expect(await syncSpace(gemma, space.id, 2)).toEqual({ embedded: 3, remaining: 0 });
    expect(stub.requests.map((r) => r.input.length)).toEqual([2, 1]);
    expect(embeddedTexts()).toContain(modelSpec(GEMMA).document('A', 'alpha'));
    expect(await stored()).toEqual([
      { key: 'a', fresh: true },
      { key: 'b', fresh: true },
      { key: 'c', fresh: true },
    ]);
  });

  it('does nothing when every vector is fresh', async () => {
    await syncSpace(gemma, space.id, 32);
    stub.requests.length = 0;
    expect(await syncSpace(gemma, space.id, 32)).toEqual({ embedded: 0, remaining: 0 });
    expect(stub.requests).toHaveLength(0);
  });

  it('re-embeds only the entity whose title or content changed, not a metadata-only change', async () => {
    await syncSpace(gemma, space.id, 32);
    await learning('b', 'beta, revised');
    await upsertEntity(
      space.id,
      { type: 'learning', key: 'c', title: 'C', content: 'gamma', metadata: { cause: 'x' } },
      agent,
    );
    stub.requests.length = 0;
    expect(await syncSpace(gemma, space.id, 32)).toEqual({ embedded: 1, remaining: 0 });
    expect(embeddedTexts()).toEqual([modelSpec(GEMMA).document('B', 'beta, revised')]);
  });

  it('re-embeds after an accepted proposal and after a revert', async () => {
    const { entity: rule } = await upsertEntity(
      space.id,
      { type: 'rule', key: 'r', title: 'R', content: 'v1', metadata: { severity: 'low' } },
      agent,
    );
    await syncSpace(gemma, space.id, 32);
    const { proposal } = await upsertEntity(
      space.id,
      { type: 'rule', key: 'r', title: 'R', content: 'v2', metadata: { severity: 'low' } },
      agent,
    );
    await acceptProposal(space.id, proposal?.id ?? '', 'human:owner');
    expect(await syncSpace(gemma, space.id, 32)).toEqual({ embedded: 1, remaining: 0 });

    const created = (await history(space.id, rule.id)).find((c) => c.action === 'create');
    await revertEntity(space.id, rule.id, created?.id ?? 0, 'human:owner');
    stub.requests.length = 0;
    expect(await syncSpace(gemma, space.id, 32)).toEqual({ embedded: 1, remaining: 0 });
    expect(embeddedTexts()).toEqual([modelSpec(GEMMA).document('R', 'v1')]);
  });

  it('keeps each model separate', async () => {
    await syncSpace(gemma, space.id, 32);
    await syncSpace({ ...gemma, model: QWEN }, space.id, 32);
    await learning('a', 'alpha, revised');
    await syncSpace({ ...gemma, model: QWEN }, space.id, 32);
    expect(await stored(QWEN)).toEqual([
      { key: 'a', fresh: true },
      { key: 'b', fresh: true },
      { key: 'c', fresh: true },
    ]);
    expect((await stored(GEMMA)).find((r) => r.key === 'a')).toEqual({ key: 'a', fresh: false });
  });

  it('does not duplicate rows when two syncs run at the same time', async () => {
    await Promise.all([syncSpace(gemma, space.id, 1), syncSpace(gemma, space.id, 1)]);
    expect(await queryRows('select 1 from entity_embeddings')).toHaveLength(3);
  });

  it('keeps finished batches when the provider fails, and resumes on the next call', async () => {
    stub.respond = () => (stub.requests.length > 1 ? { status: 500, body: '{}' } : undefined);
    await expect(syncSpace(gemma, space.id, 2)).rejects.toThrow(EmbeddingProviderError);
    expect(await stored()).toHaveLength(2);
    stub.respond = undefined;
    expect(await syncSpace(gemma, space.id, 2)).toEqual({ embedded: 1, remaining: 0 });
  });

  it('only touches the given space', async () => {
    const other = await createSpace({ slug: 'other', name: 'Other', preset: TEST_PRESET });
    await upsertEntity(other.id, { type: 'learning', key: 'z', title: 'Z', content: 'zeta' }, agent);
    expect(await syncSpace(gemma, space.id, 32)).toEqual({ embedded: 3, remaining: 0 });
    expect((await stored()).map((r) => r.key)).toEqual(['a', 'b', 'c']);
  });

  it('re-embeds when only the title changes', async () => {
    await syncSpace(gemma, space.id, 32);
    await upsertEntity(space.id, { type: 'learning', key: 'a', title: 'A, renamed', content: 'alpha' }, agent);
    stub.requests.length = 0;
    expect(await syncSpace(gemma, space.id, 32)).toEqual({ embedded: 1, remaining: 0 });
    expect(embeddedTexts()).toEqual([modelSpec(GEMMA).document('A, renamed', 'alpha')]);
  });

  it('answers zero for an empty space and for a well-formed but unknown space id', async () => {
    const empty = await createSpace({ slug: 'empty', name: 'Empty', preset: TEST_PRESET });
    expect(await syncSpace(gemma, empty.id, 32)).toEqual({ embedded: 0, remaining: 0 });
    expect(await syncSpace(gemma, '00000000-0000-4000-8000-000000000000', 32)).toEqual({ embedded: 0, remaining: 0 });
    expect(stub.requests).toHaveLength(0);
  });

  it('accepts a batch of 256 and rejects 257', async () => {
    await expect(syncSpace(gemma, space.id, 257)).rejects.toThrow(EmbeddingConfigError);
    await expect(syncSpace(gemma, space.id, 256)).resolves.toEqual({ embedded: 3, remaining: 0 });
  });

  it('leaves an entity stale, never fresh, when it is edited while its batch is in flight', async () => {
    let seen = () => {};
    const requestSeen = new Promise<void>((resolve) => {
      seen = resolve;
    });
    stub.respond = () => {
      seen();
      return undefined;
    };
    const running = syncSpace(gemma, space.id, 32);
    await requestSeen; // the batch was already read: this edit lands after it
    await learning('b', 'beta, edited meanwhile');
    await running;
    expect((await stored()).find((r) => r.key === 'b')).toEqual({ key: 'b', fresh: false });
    stub.respond = undefined;
    expect(await syncSpace(gemma, space.id, 32)).toEqual({ embedded: 1, remaining: 0 });
    expect((await stored()).every((r) => r.fresh)).toBe(true);
  });

  describe('a malformed provider response writes nothing', () => {
    const okRow = (index: number, dims = 768) => ({ index, embedding: new Array(dims).fill(0.1) });
    const bodies: [string, string][] = [
      ['wrong dimension', JSON.stringify({ data: [okRow(0, 3), okRow(1, 3), okRow(2, 3)] })],
      ['wrong count', JSON.stringify({ data: [okRow(0)] })],
      ['null (NaN from the model)', JSON.stringify({ data: [{ index: 0, embedding: [null] }, okRow(1), okRow(2)] })],
      ['not JSON', 'oops'],
    ];
    it.each(bodies)('%s', async (_name, body) => {
      stub.respond = () => ({ status: 200, body });
      await expect(syncSpace(gemma, space.id, 32)).rejects.toThrow(EmbeddingProviderError);
      expect(await queryRows('select 1 from entity_embeddings')).toHaveLength(0);
    });

    it('Infinity (1e999) in a vector', async () => {
      const row = (index: number, first: string) =>
        `{"index":${index},"embedding":[${first},${new Array(767).fill(0.1).join(',')}]}`;
      stub.respond = () => ({ status: 200, body: `{"data":[${row(0, '1e999')},${row(1, '0.1')},${row(2, '0.1')}]}` });
      await expect(syncSpace(gemma, space.id, 32)).rejects.toThrow(EmbeddingProviderError);
      expect(await queryRows('select 1 from entity_embeddings')).toHaveLength(0);
    });
  });

  it('treats a malformed space id as missing and rejects an invalid batch size', async () => {
    await expect(syncSpace(gemma, 'not-a-uuid', 32)).rejects.toThrow(NotFoundError);
    await expect(syncSpace(gemma, space.id, 0)).rejects.toThrow(EmbeddingConfigError);
    await expect(syncSpace(gemma, space.id, 1.5)).rejects.toThrow(EmbeddingConfigError);
  });

  it('reads the provider from the environment in the public function', async () => {
    vi.stubEnv('EMBEDDINGS_BASE_URL', stub.baseUrl);
    vi.stubEnv('EMBEDDINGS_MODEL', QWEN);
    try {
      expect(await syncEmbeddings(space.id)).toEqual({ embedded: 3, remaining: 0 });
      expect(stub.requests.every((r) => r.model === QWEN)).toBe(true);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
