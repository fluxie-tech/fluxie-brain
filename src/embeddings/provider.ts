import { z } from 'zod';
import { EmbeddingConfigError, EmbeddingProviderError } from './errors.ts';
import { DEFAULT_MODEL, modelSpec } from './models.ts';

/** Where and how to embed. Public functions build it from the environment on every call; internals take it explicitly. */
export type ProviderConfig = { baseUrl: string; model: string; apiKey: string | undefined };

// A CPU batch of 32 documents took ~8–18 s in the spike; this only stops a hung provider from blocking forever.
const TIMEOUT_MS = 60_000;

const responseSchema = z.object({
  data: z.array(z.object({ index: z.int().nonnegative(), embedding: z.array(z.number()) })),
});

export function configFromEnv(env: NodeJS.ProcessEnv = process.env): ProviderConfig {
  const baseUrl = env.EMBEDDINGS_BASE_URL || 'http://127.0.0.1:11434/v1';
  const protocol = URL.parse(baseUrl)?.protocol;
  if (protocol !== 'http:' && protocol !== 'https:') {
    throw new EmbeddingConfigError(`EMBEDDINGS_BASE_URL must be an http(s) URL, got "${baseUrl}".`);
  }
  const model = env.EMBEDDINGS_MODEL || DEFAULT_MODEL;
  modelSpec(model);
  return { baseUrl, model, apiKey: env.EMBEDDINGS_API_KEY || undefined };
}

/** Embeds already-formatted texts in one request; returns one validated vector per text, in input order. */
export async function embed(config: ProviderConfig, texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];
  const { dimensions } = modelSpec(config.model);
  const body = await post(config, texts);
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
    vectors[index] = embedding;
  }
  return vectors;
}

async function post(config: ProviderConfig, texts: string[]): Promise<unknown> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (config.apiKey) headers.authorization = `Bearer ${config.apiKey}`;
  let res: Response;
  try {
    res = await fetch(`${config.baseUrl.replace(/\/+$/, '')}/embeddings`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ model: config.model, input: texts }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    throw new EmbeddingProviderError(`Embeddings provider unreachable: ${(err as Error).message}.`);
  }
  // The body may echo internals (paths, prompts); keep it out of messages that reach agents.
  if (!res.ok) throw new EmbeddingProviderError(`Embeddings provider returned HTTP ${res.status}.`);
  try {
    return await res.json();
  } catch {
    throw new EmbeddingProviderError('Embeddings provider returned a body that is not JSON.');
  }
}
