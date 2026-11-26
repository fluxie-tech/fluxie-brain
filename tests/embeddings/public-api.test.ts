import { describe, expect, it } from 'vitest';
import * as embeddings from '../../src/embeddings/index.ts';

describe('embeddings public API', () => {
  it('exports exactly what the spec defines so far', () => {
    expect(Object.keys(embeddings).sort()).toEqual(
      ['EmbeddingConfigError', 'EmbeddingProviderError', 'search', 'syncEmbeddings'].sort(),
    );
  });
});
