import { CoreGraphError } from '../core-graph/index.ts';

// Derived from CoreGraphError so the mcp-server handles every domain error the same way.

/** The embeddings provider failed: network, HTTP status, or a response that does not validate. */
export class EmbeddingProviderError extends CoreGraphError {}

/** The embeddings configuration or a call argument is invalid (unknown model, bad base URL, out-of-range limit). */
export class EmbeddingConfigError extends CoreGraphError {}
