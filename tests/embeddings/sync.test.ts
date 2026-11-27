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
    expect(await syncSpace(gemma, space.id, 2)).toEqual({ embedded: 3, remaining: 0, failed: [] });
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
    expect(await syncSpace(gemma, space.id, 32)).toEqual({ embedded: 0, remaining: 0, failed: [] });
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
    expect(await syncSpace(gemma, space.id, 32)).toEqual({ embedded: 1, remaining: 0, failed: [] });
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
    expect(await syncSpace(gemma, space.id, 32)).toEqual({ embedded: 1, remaining: 0, failed: [] });

    const created = (await history(space.id, rule.id)).find((c) => c.action === 'create');
    await revertEntity(space.id, rule.id, created?.id ?? 0, 'human:owner');
    stub.requests.length = 0;
    expect(await syncSpace(gemma, space.id, 32)).toEqual({ embedded: 1, remaining: 0, failed: [] });
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

  it('keeps finished batches when one entity keeps failing, and retries it on the next call', async () => {
    stub.respond = () => (stub.requests.length > 1 ? { status: 500, body: '{}' } : undefined);
    const [last] = await queryRows<{ id: string }>('select id from entities order by id desc limit 1');
    // The first batch is stored; the entity with the greatest id fails alone, so it is skipped and reported instead of aborting the sync.
    expect(await syncSpace(gemma, space.id, 2)).toEqual({ embedded: 2, remaining: 1, failed: [last?.id] });
    expect(await stored()).toHaveLength(2);
    stub.respond = undefined;
    expect(await syncSpace(gemma, space.id, 2)).toEqual({ embedded: 1, remaining: 0, failed: [] });
  });

  it('an entity that always fails, between good ones, is reported and does not keep the greater ids from a vector', async () => {
    const rows = await queryRows<{ id: string; title: string; content: string }>(
      'select id, title, content from entities order by id',
    );
    const middle = rows[1];
    const poison = modelSpec(GEMMA).document(middle?.title ?? '', middle?.content ?? '');
    stub.respond = (req) => (req.input.includes(poison) ? { status: 500, body: '{}' } : undefined);
    expect(await syncSpace(gemma, space.id, 32)).toEqual({ embedded: 2, remaining: 1, failed: [middle?.id] });
    expect((await stored()).every((r) => r.fresh)).toBe(true);
    expect(await stored()).toHaveLength(2);
  });

  it('a provider that always fails is detected on the first lone entity: at most log2(batch)+1 calls, no next batch', async () => {
    for (const key of ['d', 'e', 'f', 'g', 'h']) await learning(key, `content ${key}`);
    stub.respond = () => ({ status: 500, body: '{}' });
    await expect(syncSpace(gemma, space.id, 4)).rejects.toThrow(EmbeddingProviderError);
    expect(stub.requests.map((r) => r.input.length)).toEqual([4, 2, 1]);
    expect(await stored()).toHaveLength(0);
  });

  it('splits a failing batch in halves: a transient failure costs nothing but a retry', async () => {
    stub.respond = () => (stub.requests.length === 1 ? { status: 500, body: '{}' } : undefined);
    expect(await syncSpace(gemma, space.id, 32)).toEqual({ embedded: 3, remaining: 0, failed: [] });
    expect(stub.requests.map((r) => r.input.length)).toEqual([3, 1, 2]);
  });

  it('still rejects when nothing at all could be embedded (the provider is down)', async () => {
    stub.respond = () => ({ status: 500, body: '{}' });
    await expect(syncSpace(gemma, space.id, 32)).rejects.toThrow(EmbeddingProviderError);
  });

  it('does not swallow a configuration error: it is not the provider failing', async () => {
    await expect(syncSpace({ ...gemma, model: 'nope' }, space.id, 32)).rejects.toThrow(EmbeddingConfigError);
    expect(stub.requests).toHaveLength(0);
  });

  it('only touches the given space', async () => {
    const other = await createSpace({ slug: 'other', name: 'Other', preset: TEST_PRESET });
    await upsertEntity(other.id, { type: 'learning', key: 'z', title: 'Z', content: 'zeta' }, agent);
    expect(await syncSpace(gemma, space.id, 32)).toEqual({ embedded: 3, remaining: 0, failed: [] });
    expect((await stored()).map((r) => r.key)).toEqual(['a', 'b', 'c']);
  });

  it('re-embeds when only the title changes', async () => {
    await syncSpace(gemma, space.id, 32);
    await upsertEntity(space.id, { type: 'learning', key: 'a', title: 'A, renamed', content: 'alpha' }, agent);
    stub.requests.length = 0;
    expect(await syncSpace(gemma, space.id, 32)).toEqual({ embedded: 1, remaining: 0, failed: [] });
    expect(embeddedTexts()).toEqual([modelSpec(GEMMA).document('A, renamed', 'alpha')]);
  });

  it('answers zero for an empty space and for a well-formed but unknown space id', async () => {
    const empty = await createSpace({ slug: 'empty', name: 'Empty', preset: TEST_PRESET });
    expect(await syncSpace(gemma, empty.id, 32)).toEqual({ embedded: 0, remaining: 0, failed: [] });
    expect(await syncSpace(gemma, '00000000-0000-4000-8000-000000000000', 32)).toEqual({
      embedded: 0,
      remaining: 0,
      failed: [],
    });
    expect(stub.requests).toHaveLength(0);
  });

  it('accepts a batch of 256 and rejects 257', async () => {
    await expect(syncSpace(gemma, space.id, 257)).rejects.toThrow(EmbeddingConfigError);
    await expect(syncSpace(gemma, space.id, 256)).resolves.toEqual({ embedded: 3, remaining: 0, failed: [] });
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
    expect(await syncSpace(gemma, space.id, 32)).toEqual({ embedded: 1, remaining: 0, failed: [] });
    expect((await stored()).every((r) => r.fresh)).toBe(true);
  });

  describe('a malformed provider response writes nothing', () => {
    const okRow = (index: number, dims = 768) => ({ index, embedding: new Array(dims).fill(0.1) });
    // Each case answers any number of inputs wrongly, so no split of the batch can make it right.
    const bodies: [string, (inputs: number) => string][] = [
      ['wrong dimension', (n) => JSON.stringify({ data: Array.from({ length: n }, (_, i) => okRow(i, 3)) })],
      ['wrong count', (n) => JSON.stringify({ data: Array.from({ length: n + 1 }, (_, i) => okRow(i)) })],
      ['null (NaN from the model)', () => JSON.stringify({ data: [{ index: 0, embedding: [null] }] })],
      ['not JSON', () => 'oops'],
    ];
    it.each(bodies)('%s', async (_name, body) => {
      stub.respond = (req) => ({ status: 200, body: body(req.input.length) });
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

  it('gives each batch the long timeout (60 s), not the one of a search query', async () => {
    const timeouts = vi.spyOn(AbortSignal, 'timeout');
    try {
      await syncSpace(gemma, space.id, 2);
      expect(timeouts.mock.calls.map(([ms]) => ms)).toEqual([60_000, 60_000]);
    } finally {
      timeouts.mockRestore();
    }
  });

  it('reads the provider from the environment in the public function', async () => {
    vi.stubEnv('EMBEDDINGS_BASE_URL', stub.baseUrl);
    vi.stubEnv('EMBEDDINGS_MODEL', QWEN);
    try {
      expect(await syncEmbeddings(space.id)).toEqual({ embedded: 3, remaining: 0, failed: [] });
      expect(stub.requests.every((r) => r.model === QWEN)).toBe(true);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
