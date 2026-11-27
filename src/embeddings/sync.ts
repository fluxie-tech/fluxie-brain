import { and, asc, count, eq, gt, isNull, ne, or, sql } from 'drizzle-orm';
import { db, entities, NotFoundError } from '../core-graph/index.ts';
import { EmbeddingConfigError, EmbeddingProviderError } from './errors.ts';
import { modelSpec } from './models.ts';
import { configFromEnv, embed, type ProviderConfig } from './provider.ts';
import { entityEmbeddings, vectorOf } from './schema.ts';

/** `failed`: ids of entities the provider kept refusing even alone; they stay stale and the next sync retries them. */
export type SyncResult = { embedded: number; remaining: number; failed: string[] };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_BATCH = 256;

/** Embeds the space's entities that have no vector for the active model, or a stale one. Idempotent. */
export async function syncEmbeddings(spaceId: string, opts: { batchSize?: number } = {}): Promise<SyncResult> {
  return syncSpace(configFromEnv(), spaceId, opts.batchSize ?? 32);
}

export async function syncSpace(config: ProviderConfig, spaceId: string, batchSize: number): Promise<SyncResult> {
  // Same rule as core-graph: a malformed id behaves as missing. A well-formed unknown space just has no entities.
  if (!UUID.test(spaceId)) throw new NotFoundError(`Space ${spaceId} not found.`);
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > MAX_BATCH) {
    throw new EmbeddingConfigError(`batchSize must be an integer between 1 and ${MAX_BATCH}, got ${batchSize}.`);
  }
  let embedded = 0;
  const failed: string[] = [];
  let lastError: EmbeddingProviderError | undefined;
  // Keyset pagination: one pass over the stale set, so concurrent edits cannot keep the loop alive. A batch the
  // provider refuses is split and retried; an entity refused alone is skipped (and reported), so it cannot block the
  // entities after it.
  let after = '';
  for (;;) {
    const batch = await staleEntities(spaceId, config.model, after, batchSize);
    if (batch.length === 0) break;
    const result = await embedSplitting(config, batch);
    await store(config.model, result.done);
    embedded += result.done.length;
    failed.push(...result.failed);
    lastError = result.error ?? lastError;
    after = batch.at(-1)?.id ?? after;
  }
  // Nothing embedded and something refused: that is the provider being down, not one bad entity.
  if (embedded === 0 && lastError) throw lastError;
  const [left] = await db
    .select({ n: count() })
    .from(entities)
    .leftJoin(entityEmbeddings, vectorOf(config.model))
    .where(isStale(spaceId));
  return { embedded, remaining: left?.n ?? 0, failed };
}

type Row = { id: string; title: string; content: string; hash: string };
type Embedded = { done: { row: Row; vector: number[] }[]; failed: string[]; error?: EmbeddingProviderError };

/** Embeds the rows in one request; if the provider refuses, halves the batch and retries, down to single entities. */
async function embedSplitting(config: ProviderConfig, rows: Row[]): Promise<Embedded> {
  const { document } = modelSpec(config.model);
  try {
    const vectors = await embed(
      config,
      rows.map((r) => document(r.title, r.content)),
    );
    return { done: rows.map((row, i) => ({ row, vector: vectors[i] ?? [] })), failed: [] };
  } catch (err) {
    if (!(err instanceof EmbeddingProviderError)) throw err;
    const [only] = rows;
    if (only && rows.length === 1) return { done: [], failed: [only.id], error: err };
    const middle = rows.length >> 1;
    const left = await embedSplitting(config, rows.slice(0, middle));
    const right = await embedSplitting(config, rows.slice(middle));
    return {
      done: [...left.done, ...right.done],
      failed: [...left.failed, ...right.failed],
      error: right.error ?? left.error ?? err,
    };
  }
}

async function store(model: string, done: Embedded['done']): Promise<void> {
  if (done.length === 0) return;
  await db
    .insert(entityEmbeddings)
    .values(done.map(({ row, vector }) => ({ entityId: row.id, model, sourceHash: row.hash, embedding: vector })))
    .onConflictDoUpdate({
      target: [entityEmbeddings.entityId, entityEmbeddings.model],
      set: { sourceHash: sql`excluded.source_hash`, embedding: sql`excluded.embedding`, updatedAt: sql`now()` },
    });
}

/** In the space, with no vector for the model (left join miss) or one embedded from older title/content. */
const isStale = (spaceId: string) =>
  and(
    eq(entities.spaceId, spaceId),
    or(isNull(entityEmbeddings.entityId), ne(entityEmbeddings.sourceHash, entities.contentHash)),
  );

async function staleEntities(spaceId: string, model: string, after: string, limit: number) {
  const rows = await db
    .select({ id: entities.id, title: entities.title, content: entities.content, hash: entities.contentHash })
    .from(entities)
    .leftJoin(entityEmbeddings, vectorOf(model))
    .where(and(isStale(spaceId), after ? gt(entities.id, after) : undefined))
    .orderBy(asc(entities.id))
    .limit(limit);
  // content_hash is a generated column over two NOT NULL columns, so it is never null in practice.
  return rows.map((r) => ({ ...r, hash: r.hash ?? '' }));
}
