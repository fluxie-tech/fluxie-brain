import { describe, expect, it } from 'vitest';
import { EmbeddingConfigError, EmbeddingProviderError } from '../../src/embeddings/index.ts';
import { configFromEnv, embed } from '../../src/embeddings/provider.ts';
import { startStub } from './stub-provider.ts';

const GEMMA = 'embeddinggemma-2:270m';

describe('credentials in EMBEDDINGS_BASE_URL', () => {
  it.each(['http://user:s3cret@host.example/v1', 'http://user@host.example/v1', 'http://:s3cret@host.example/v1'])(
    'refuses %s without echoing it',
    (baseUrl) => {
      const attempt = () => configFromEnv({ EMBEDDINGS_BASE_URL: baseUrl });
      expect(attempt).toThrow(EmbeddingConfigError);
      expect(attempt).not.toThrow(/s3cret|user|host\.example/);
    },
  );

  it('does not echo a malformed URL either', () => {
    expect(() => configFromEnv({ EMBEDDINGS_BASE_URL: 'ftp://host.example/v1' })).not.toThrow(/host\.example/);
  });

  it('keeps the password out of the error of an unreachable provider (hand-built config)', async () => {
    const closed = await startStub();
    await closed.close();
    const baseUrl = closed.baseUrl.replace('http://', 'http://user:s3cret@');
    const err = await embed({ baseUrl, model: GEMMA, apiKey: undefined }, ['x']).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EmbeddingProviderError);
    expect((err as Error).message).toMatch(/unreachable/);
    expect((err as Error).message).not.toMatch(/s3cret|user|127\.0\.0\.1/);
  });
});
