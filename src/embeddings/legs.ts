import { and, asc, eq, inArray, type SQL, sql } from 'drizzle-orm';
import { db, type EntityStatus, entities } from '../core-graph/index.ts';
import { EmbeddingProviderError } from './errors.ts';
import { type Legs, queryWords, type Scored } from './fusion.ts';
import { graphLeg } from './graph.ts';
import { modelSpec } from './models.ts';
import { embed, type ProviderConfig, QUERY_TIMEOUT_MS } from './provider.ts';
import { entityEmbeddings, vectorLiteral, vectorOf } from './schema.ts';

/** Which entities a leg may return: the space, the requested statuses and, if given, the types and scope ids. */
export type LegFilter = {
  spaceId: string;
  statuses: EntityStatus[];
  types: string[] | undefined;
  ids?: string[] | undefined;
};

/** How many vector hits seed the graph walk, each weighted by its similarity. */
const SEEDS = 5;

const matches = (filter: LegFilter): SQL | undefined =>
  and(
    eq(entities.spaceId, filter.spaceId),
    inArray(entities.status, filter.statuses),
    filter.types ? inArray(entities.type, filter.types) : undefined,
    filter.ids ? inArray(entities.id, filter.ids) : undefined,
  );

/** The `size` nearest entities by cosine similarity, among the active model's vectors only (exact search). */
export async function vectorLeg(config: ProviderConfig, query: string, filter: LegFilter, size: number) {
  const [vector = []] = await embed(config, [modelSpec(config.model).query(query)], QUERY_TIMEOUT_MS);
  const distance = sql<number>`${entityEmbeddings.embedding} <=> ${vectorLiteral(vector)}::vector`;
  const rows = await db
    .select({ id: entities.id, distance })
    .from(entities)
    .innerJoin(entityEmbeddings, vectorOf(config.model))
    .where(matches(filter))
    .orderBy(distance, asc(entities.id))
    .limit(size);
  return rows.map((r): Scored => ({ id: r.id, score: 1 - r.distance }));
}

/** The BM25 indexes of migration 0008: same expression, one text search config each (Emenda 1). */
const BM25_INDEXES = ['entities_bm25_pt', 'entities_bm25_en'] as const;

/** Top BM25 matches in one index: pg_textsearch scores are negative (lower is better) and 0 means no term matched. */
async function bm25Leg(words: string, filter: LegFilter, index: string, size: number) {
  // Must stay the exact expression the indexes were built on, or the planner cannot use them.
  const score = sql<number>`(${entities.title} || ' ' || ${entities.content}) <@> to_bm25query(${words}, ${index})`;
  return db
    .select({ id: entities.id, score })
    .from(entities)
    .where(and(matches(filter), sql`${score} < 0`))
    .orderBy(score, asc(entities.id))
    .limit(size);
}

/**
 * The query's words that are not a stopword in either language. Each index drops only its own language's stopwords,
 * so without this the English index would still match Portuguese "como", "de", "para" (and vice versa).
 */
async function contentWords(query: string): Promise<string> {
  const words = queryWords(query);
  if (words.length === 0) return '';
  const { rows } = await db.execute<{ w: string }>(sql`
    select w from unnest(${sql.param(words)}::text[]) as w
     where to_tsvector('portuguese', w) <> ''::tsvector and to_tsvector('english', w) <> ''::tsvector`);
  return rows.map((r) => r.w).join(' ');
}

/**
 * The `size` best BM25 matches, each entity at its best score across the Portuguese and English indexes (stopwords of
 * both languages dropped, words reduced to their stem), as positive scores. A query with no content word matches nothing.
 */
export async function textLeg(query: string, filter: LegFilter, size: number): Promise<Scored[]> {
  const words = await contentWords(query);
  if (!words) return [];
  const best = new Map<string, number>();
  for (const rows of await Promise.all(BM25_INDEXES.map((index) => bm25Leg(words, filter, index, size)))) {
    for (const { id, score } of rows) best.set(id, Math.min(score, best.get(id) ?? 0));
  }
  return [...best]
    .map(([id, score]) => ({ id, score: -score }))
    .sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : 1))
    .slice(0, size);
}

/**
 * The vector leg, or undefined when the provider is down or the active model has no vector to offer: search then
 * falls back to the text leg alone. An empty leg counts as unavailable, so a model switched before the sync, or a
 * space never synced, does not hide every entity from a `natural` query (whose fusion ignores the text).
 */
async function vectorLegOrNothing(config: ProviderConfig, query: string, filter: LegFilter, size: number) {
  try {
    const hits = await vectorLeg(config, query, filter, size);
    return hits.length > 0 ? hits : undefined;
  } catch (err) {
    if (err instanceof EmbeddingProviderError) return undefined;
    throw err;
  }
}

/**
 * Runs the three legs of one query with `size` candidates each. The graph walk starts from the best vector hits, so it
 * runs after the vector leg, and only when `graph` is true; without vectors it is skipped.
 */
export async function runLegs(
  config: ProviderConfig,
  query: string,
  filter: LegFilter,
  opts: { size: number; graph: boolean },
): Promise<Legs> {
  const [vector, text] = await Promise.all([
    vectorLegOrNothing(config, query, filter, opts.size),
    textLeg(query, filter, opts.size),
  ]);
  const seeds = (vector ?? []).slice(0, SEEDS).map((s) => ({ id: s.id, weight: Math.max(s.score, 0) }));
  const graph = opts.graph && vector ? await graphLeg(seeds, filter, opts.size) : [];
  return { vector, text, graph };
}
