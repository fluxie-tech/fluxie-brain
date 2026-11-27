import { describe, expect, it, vi } from 'vitest';
import * as embeddings from '../../src/embeddings/index.ts';
import { EmbeddingConfigError } from '../../src/embeddings/index.ts';

describe('embeddings public API', () => {
  it('exports exactly what the spec defines so far', () => {
    expect(Object.keys(embeddings).sort()).toEqual(
      ['EmbeddingConfigError', 'EmbeddingProviderError', 'search', 'syncEmbeddings'].sort(),
    );
  });

  it.each([
    ['search', () => embeddings.search('00000000-0000-4000-8000-000000000000', 'x')],
    ['syncEmbeddings', () => embeddings.syncEmbeddings('00000000-0000-4000-8000-000000000000')],
  ])('%s reports a bad environment as a rejected Promise, not a synchronous throw', async (_name, call) => {
    vi.stubEnv('EMBEDDINGS_MODEL', 'not-a-model');
    try {
      const promise = call(); // no await here: a synchronous throw would escape this line
      expect(promise).toBeInstanceOf(Promise);
      expect(await promise.catch((e: unknown) => e)).toBeInstanceOf(EmbeddingConfigError);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
