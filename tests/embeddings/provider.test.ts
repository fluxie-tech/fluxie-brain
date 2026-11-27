import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CoreGraphError } from '../../src/core-graph/index.ts';
import { EmbeddingConfigError, EmbeddingProviderError } from '../../src/embeddings/index.ts';
import { MODELS, modelSpec } from '../../src/embeddings/models.ts';
import { configFromEnv, embed, isLocalProvider, type ProviderConfig } from '../../src/embeddings/provider.ts';
import { type Stub, startStub } from './stub-provider.ts';

const GEMMA = 'embeddinggemma-2:270m';
const QWEN = 'qwen3-embedding:0.6b';

describe('model catalog', () => {
  it('knows both benchmark models with the dimensions measured in the spike', () => {
    expect(MODELS[GEMMA].dimensions).toBe(768);
    expect(MODELS[QWEN].dimensions).toBe(1024);
  });

  it('formats EmbeddingGemma 2 documents and queries as its model card says', () => {
    expect(modelSpec(GEMMA).document('Sync engine', 'Merges notes.')).toBe('title: Sync engine | text: Merges notes.');
    expect(modelSpec(GEMMA).query('sync notes')).toBe('task: search result | query: sync notes');
  });

  it('formats Qwen3 queries with an English instruction and leaves documents bare', () => {
    expect(modelSpec(QWEN).document('Sync engine', 'Merges notes.')).toBe('Sync engine\nMerges notes.');
    expect(modelSpec(QWEN).query('sync notes')).toBe(
      'Instruct: Given a web search query, retrieve relevant passages that answer the query\nQuery:sync notes',
    );
  });

  it('rejects a model outside the catalog with a config error', () => {
    expect(() => modelSpec('nomic-embed-text')).toThrow(EmbeddingConfigError);
    expect(() => modelSpec('nomic-embed-text')).toThrow(/nomic-embed-text/);
  });
});

describe('configFromEnv', () => {
  it('defaults to the local Ollama and the EmbeddingGemma 2 model', () => {
    expect(configFromEnv({})).toEqual({ baseUrl: 'http://127.0.0.1:11434/v1', model: GEMMA, apiKey: undefined });
  });

  it('reads the provider, model and optional key from the environment', () => {
    const env = { EMBEDDINGS_BASE_URL: 'https://emb.example/v1', EMBEDDINGS_MODEL: QWEN, EMBEDDINGS_API_KEY: 'k' };
    expect(configFromEnv(env)).toEqual({ baseUrl: 'https://emb.example/v1', model: QWEN, apiKey: 'k' });
  });

  it('treats an empty key as no key', () => {
    expect(configFromEnv({ EMBEDDINGS_API_KEY: '' }).apiKey).toBeUndefined();
  });

  describe('EMBEDDINGS_API_KEY', () => {
    it('is refused over plain http to a host that is not loopback, without echoing the URL', () => {
      const env = { EMBEDDINGS_BASE_URL: 'http://emb.remote.example/v1', EMBEDDINGS_API_KEY: 'k' };
      expect(() => configFromEnv(env)).toThrow(EmbeddingConfigError);
      expect(() => configFromEnv(env)).not.toThrow(/remote\.example/);
    });

    it('is accepted over https, and over http to a loopback host', () => {
      for (const baseUrl of ['https://emb.remote.example/v1', 'http://127.0.0.1:11434/v1', 'http://localhost/v1']) {
        expect(configFromEnv({ EMBEDDINGS_BASE_URL: baseUrl, EMBEDDINGS_API_KEY: 'k' }).apiKey).toBe('k');
      }
    });

    it('does not matter without a key: plain http to a remote host stays allowed', () => {
      expect(configFromEnv({ EMBEDDINGS_BASE_URL: 'http://emb.remote.example/v1' }).apiKey).toBeUndefined();
    });
  });

  it('decides local or remote by the real hostname, not by text in the URL', () => {
    for (const url of ['http://127.0.0.1:11434/v1', 'http://localhost/v1', 'http://[::1]:11434/v1']) {
      expect(isLocalProvider(url), url).toBe(true);
    }
    const lookalikes = [
      'http://notlocalhost/v1',
      'http://localhost.evil.example/v1',
      'http://127.0.0.1.evil.example/v1',
    ];
    for (const url of [
      'http://localhost:1@host-remoto/v1',
      'https://remote.example/localhost/',
      'nonsense',
      ...lookalikes,
    ]) {
      expect(isLocalProvider(url), url).toBe(false);
    }
  });

  it('rejects an unknown model and a base URL that is not http(s)', () => {
    expect(() => configFromEnv({ EMBEDDINGS_MODEL: 'nope' })).toThrow(EmbeddingConfigError);
    expect(() => configFromEnv({ EMBEDDINGS_BASE_URL: 'not a url' })).toThrow(EmbeddingConfigError);
    expect(() => configFromEnv({ EMBEDDINGS_BASE_URL: 'file:///etc/passwd' })).toThrow(EmbeddingConfigError);
  });
});

describe('embed', () => {
  let stub: Stub;
  let config: ProviderConfig;
  const fail = (status: number, body: string) => () => ({ status, body });
  const okBody = (data: unknown[]) => JSON.stringify({ object: 'list', data });

  beforeAll(async () => {
    stub = await startStub();
  });
  afterAll(() => stub.close());
  beforeEach(() => {
    stub.requests.length = 0;
    stub.respond = undefined;
    config = { baseUrl: stub.baseUrl, model: GEMMA, apiKey: undefined };
  });

  it('returns one vector per input, in input order, in one request', async () => {
    const vectors = await embed(config, ['alpha', 'beta', 'gamma']);
    expect(vectors).toHaveLength(3);
    expect(vectors.every((v) => v.length === 768)).toBe(true);
    expect(stub.requests).toEqual([
      { path: '/v1/embeddings', model: GEMMA, input: ['alpha', 'beta', 'gamma'], authorization: undefined },
    ]);
  });

  it('orders vectors by the response index, not by arrival', async () => {
    const [a, b] = [new Array(768).fill(0.1), new Array(768).fill(0.2)];
    stub.respond = fail(
      200,
      okBody([
        { index: 1, embedding: b },
        { index: 0, embedding: a },
      ]),
    );
    expect(await embed(config, ['first', 'second'])).toEqual([a, b]);
  });

  it('sends the key as a bearer token when one is configured', async () => {
    await embed({ ...config, apiKey: 'secret' }, ['alpha']);
    expect(stub.requests[0]?.authorization).toBe('Bearer secret');
  });

  it('does not call the provider for an empty batch', async () => {
    expect(await embed(config, [])).toEqual([]);
    expect(stub.requests).toHaveLength(0);
  });

  it('turns an HTTP error into a provider error without leaking the response body', async () => {
    stub.respond = fail(500, '{"error":{"message":"internal detail XYZ"}}');
    const err = await embed(config, ['alpha']).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EmbeddingProviderError);
    expect(err).toBeInstanceOf(CoreGraphError);
    expect((err as Error).message).toMatch(/HTTP 500/);
    expect((err as Error).message).not.toMatch(/XYZ/);
  });

  it('rejects a body that is not JSON', async () => {
    stub.respond = fail(200, 'not json');
    await expect(embed(config, ['alpha'])).rejects.toThrow(EmbeddingProviderError);
  });

  it('rejects a response with the wrong number of vectors', async () => {
    stub.respond = fail(200, okBody([{ index: 0, embedding: new Array(768).fill(0) }]));
    await expect(embed(config, ['alpha', 'beta'])).rejects.toThrow(/2 inputs.*1 vectors/);
  });

  it('rejects vectors whose dimension differs from the catalog', async () => {
    stub.respond = fail(200, okBody([{ index: 0, embedding: [0.1, 0.2] }]));
    await expect(embed(config, ['alpha'])).rejects.toThrow(/768/);
  });

  it('rejects non-finite values (JSON carries NaN from the model as null)', async () => {
    const withNull = [...new Array(767).fill(0.1), null];
    stub.respond = fail(200, okBody([{ index: 0, embedding: withNull }]));
    await expect(embed(config, ['alpha'])).rejects.toThrow(EmbeddingProviderError);
  });

  it('rejects duplicate or out-of-range indexes', async () => {
    const v = new Array(768).fill(0.1);
    stub.respond = fail(
      200,
      okBody([
        { index: 0, embedding: v },
        { index: 0, embedding: v },
      ]),
    );
    await expect(embed(config, ['alpha', 'beta'])).rejects.toThrow(EmbeddingProviderError);
  });

  it('turns a refused connection into a provider error', async () => {
    const closed = await startStub();
    await closed.close();
    await expect(embed({ ...config, baseUrl: closed.baseUrl }, ['alpha'])).rejects.toThrow(EmbeddingProviderError);
  });

  it('rejects an index past the end of the inputs even when the count matches', async () => {
    stub.respond = fail(200, okBody([{ index: 5, embedding: new Array(768).fill(0.1) }]));
    await expect(embed(config, ['alpha'])).rejects.toThrow(/duplicate or out-of-range/);
  });

  it('rejects a number too large for a double (1e999 parses as Infinity)', async () => {
    const body = `{"data":[{"index":0,"embedding":[1e999,${new Array(767).fill(0.1).join(',')}]}]}`;
    stub.respond = fail(200, body);
    await expect(embed(config, ['alpha'])).rejects.toThrow(EmbeddingProviderError);
  });

  it('posts to /v1/embeddings whatever trailing slashes the base URL has', async () => {
    await embed({ ...config, baseUrl: `${stub.baseUrl}//` }, ['alpha']);
    expect(stub.requests.map((r) => r.path)).toEqual(['/v1/embeddings']);
  });
});

describe('catalog guards', () => {
  it('refuses a model named like an inherited Object property', () => {
    for (const name of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) {
      expect(() => modelSpec(name), name).toThrow(EmbeddingConfigError);
      expect(() => configFromEnv({ EMBEDDINGS_MODEL: name }), name).toThrow(EmbeddingConfigError);
    }
  });
});
