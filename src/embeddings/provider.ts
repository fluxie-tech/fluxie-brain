import { z } from 'zod';
import { EmbeddingConfigError, EmbeddingProviderError } from './errors.ts';
import { DEFAULT_MODEL, modelSpec } from './models.ts';

/**
 * OpenRouter provider routing (sent as `provider` in the request body). Only the fields this project uses; see
 * SPEC-embeddings.md, Emenda 2: a closed pool (`only` + `order`), fallbacks inside it, and the data policy.
 */
const routingSchema = z.strictObject({
  only: z.array(z.string().min(1)).min(1),
  order: z.array(z.string().min(1)).min(1),
  allow_fallbacks: z.boolean().optional(),
  data_collection: z.enum(['allow', 'deny']).optional(),
  zdr: z.boolean().optional(),
});
export type ProviderRouting = z.infer<typeof routingSchema>;

/** Where and how to embed. Public functions build it from the environment on every call; internals take it explicitly. */
export type ProviderConfig = {
  baseUrl: string;
  model: string;
  apiKey: string | undefined;
  routing?: ProviderRouting | undefined;
};

// A CPU batch of 32 documents took ~8–18 s in the spike; this only stops a hung provider from blocking forever.
const SYNC_TIMEOUT_MS = 60_000;
/** Embedding one search query is a single short text: past this, search answers from the text leg instead of waiting. */
export const QUERY_TIMEOUT_MS = 3000;

const responseSchema = z.object({
  data: z.array(z.object({ index: z.int().nonnegative(), embedding: z.array(z.number()) })),
});

export function configFromEnv(env: NodeJS.ProcessEnv = process.env): ProviderConfig {
  const baseUrl = env.EMBEDDINGS_BASE_URL || 'http://127.0.0.1:11434/v1';
  const url = URL.parse(baseUrl);
  // Never echo the URL: it may carry credentials, and an error message can reach an agent or a log.
  if (url?.protocol !== 'http:' && url?.protocol !== 'https:') {
    throw new EmbeddingConfigError('EMBEDDINGS_BASE_URL must be an http(s) URL.');
  }
  if (url.username || url.password) {
    throw new EmbeddingConfigError('EMBEDDINGS_BASE_URL must not contain credentials; use EMBEDDINGS_API_KEY.');
  }
  const model = env.EMBEDDINGS_MODEL || DEFAULT_MODEL;
  modelSpec(model);
  const config = { baseUrl, model, apiKey: env.EMBEDDINGS_API_KEY || undefined, routing: parseRouting(env) };
  requireClosedRouting(config);
  return config;
}

function parseRouting(env: NodeJS.ProcessEnv): ProviderRouting | undefined {
  const raw = env.EMBEDDINGS_ROUTING;
  if (!raw) return undefined;
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new EmbeddingConfigError('EMBEDDINGS_ROUTING must be JSON.');
  }
  const parsed = routingSchema.safeParse(json);
  if (!parsed.success) throw new EmbeddingConfigError(`Invalid EMBEDDINGS_ROUTING: ${z.prettifyError(parsed.error)}`);
  return parsed.data;
}

/** Never let OpenRouter route freely: a call to it must carry a closed provider pool (only + order). */
function requireClosedRouting(config: ProviderConfig): void {
  const host = URL.parse(config.baseUrl)?.hostname ?? '';
  const openRouter = host === 'openrouter.ai' || host.endsWith('.openrouter.ai');
  if (openRouter && !config.routing) {
    throw new EmbeddingConfigError('OpenRouter needs EMBEDDINGS_ROUTING with a closed provider pool (only + order).');
  }
}

/** Embeds already-formatted texts in one request; returns one validated vector per text, in input order. */
export async function embed(config: ProviderConfig, texts: string[], timeoutMs = SYNC_TIMEOUT_MS): Promise<number[][]> {
  if (texts.length === 0) return [];
  const { dimensions } = modelSpec(config.model);
  const body = await post(config, texts, timeoutMs);
  const parsed = responseSchema.safeParse(body);
  if (!parsed.success) throw new EmbeddingProviderError('Embeddings provider returned an invalid response.');
  const { data } = parsed.data;
  if (data.length !== texts.length) {
    throw new EmbeddingProviderError(
      `Embeddings provider got ${texts.length} inputs but returned ${data.length} vectors.`,
    );
  }
  const vectors = new Array<number[]>(texts.length);
  for (const { index, embedding } of data) {
    if (index >= texts.length || vectors[index]) {
      throw new EmbeddingProviderError('Embeddings provider returned duplicate or out-of-range indexes.');
    }
    if (embedding.length !== dimensions) {
      throw new EmbeddingProviderError(
        `Embeddings provider returned ${embedding.length} dimensions; ${config.model} has ${dimensions}.`,
      );
    }
    // Cosine distance is undefined for a zero vector (NaN), which would silently degrade the fusion.
    if (embedding.every((x) => x === 0))
      throw new EmbeddingProviderError('Embeddings provider returned a zero vector.');
    vectors[index] = embedding;
  }
  return vectors;
}

/** Error name and system code only: the raw fetch message can include the URL, credentials and all. */
function failureKind(err: unknown): string {
  const name = err instanceof Error ? err.name : 'error';
  const code = (err as { cause?: { code?: unknown } } | null)?.cause?.code;
  return typeof code === 'string' ? `${name}: ${code}` : name;
}

async function post(config: ProviderConfig, texts: string[], timeoutMs: number): Promise<unknown> {
  // Checked again here so no code path can reach OpenRouter with open routing, even with a hand-built config.
  requireClosedRouting(config);
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (config.apiKey) headers.authorization = `Bearer ${config.apiKey}`;
  let res: Response;
  try {
    res = await fetch(`${config.baseUrl.replace(/\/+$/, '')}/embeddings`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ model: config.model, input: texts, ...(config.routing && { provider: config.routing }) }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    throw new EmbeddingProviderError(`Embeddings provider unreachable (${failureKind(err)}).`);
  }
  // The body may echo internals (paths, prompts); keep it out of messages that reach agents.
  if (!res.ok) throw new EmbeddingProviderError(`Embeddings provider returned HTTP ${res.status}.`);
  try {
    return await res.json();
  } catch (err) {
    // The deadline also covers reading the body: report it as what it is, not as bad JSON.
    if (err instanceof Error && err.name === 'TimeoutError') {
      throw new EmbeddingProviderError(`Embeddings provider unreachable (${failureKind(err)}).`);
    }
    throw new EmbeddingProviderError('Embeddings provider returned a body that is not JSON.');
  }
}
