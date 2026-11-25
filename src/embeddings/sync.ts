import { and, asc, count, eq, gt, isNull, ne, or, sql } from 'drizzle-orm';
import { db, entities, NotFoundError } from '../core-graph/index.ts';
import { EmbeddingConfigError } from './errors.ts';
import { modelSpec } from './models.ts';
import { configFromEnv, embed, type ProviderConfig } from './provider.ts';
import { entityEmbeddings } from './schema.ts';

export type SyncResult = { embedded: number; remaining: number };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_BATCH = 256;

/** Embeds the space's entities that have no vector for the active model, or a stale one. Idempotent. */
export function syncEmbeddings(spaceId: string, opts: { batchSize?: number } = {}): Promise<SyncResult> {
  return syncSpace(configFromEnv(), spaceId, opts.batchSize ?? 32);
}

export async function syncSpace(config: ProviderConfig, spaceId: string, batchSize: number): Promise<SyncResult> {
  // Same rule as core-graph: a malformed id behaves as missing. A well-formed unknown space just has no entities.
  if (!UUID.test(spaceId)) throw new NotFoundError(`Space ${spaceId} not found.`);
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > MAX_BATCH) {
    throw new EmbeddingConfigError(`batchSize must be an integer between 1 and ${MAX_BATCH}, got ${batchSize}.`);
  }
  const { document } = modelSpec(config.model);
  let embedded = 0;
  // Keyset pagination: one pass over the stale set, so concurrent edits cannot keep the loop alive.
  let after = '';
  for (;;) {
    const batch = await staleEntities(spaceId, config.model, after, batchSize);
    if (batch.length === 0) break;
    const vectors = await embed(
      config,
      batch.map((e) => document(e.title, e.content)),
    );
    await db
      .insert(entityEmbeddings)
      .values(
        batch.map((e, i) => ({ entityId: e.id, model: config.model, sourceHash: e.hash, embedding: vectors[i] ?? [] })),
      )
      .onConflictDoUpdate({
        target: [entityEmbeddings.entityId, entityEmbeddings.model],
        set: { sourceHash: sql`excluded.source_hash`, embedding: sql`excluded.embedding`, updatedAt: sql`now()` },
      });
    embedded += batch.length;
    after = batch.at(-1)?.id ?? after;
  }
  const [left] = await db
    .select({ n: count() })
    .from(entities)
    .leftJoin(entityEmbeddings, vectorOf(config.model))
    .where(isStale(spaceId));
  return { embedded, remaining: left?.n ?? 0 };
}

const vectorOf = (model: string) => and(eq(entityEmbeddings.entityId, entities.id), eq(entityEmbeddings.model, model));

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
