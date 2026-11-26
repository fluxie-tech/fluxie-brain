import { and, asc, eq, getTableColumns, inArray, type SQL, sql } from 'drizzle-orm';
import { db, type Entity, type EntityStatus, entities, type GraphSlice, NotFoundError } from '../core-graph/index.ts';
import { contextOf } from './context.ts';
import { EmbeddingConfigError, EmbeddingProviderError } from './errors.ts';
import { fuse, queryWords } from './fusion.ts';
import { modelSpec } from './models.ts';
import { configFromEnv, embed, type ProviderConfig } from './provider.ts';
import { entityEmbeddings, vectorLiteral, vectorOf } from './schema.ts';
import { type Anchor, scopeIds } from './scope.ts';

export type SearchOptions = {
  /** Restricts both legs to the anchor's scope; the mcp-server passes the space preset's rule. */
  anchor?: Anchor;
  statuses?: EntityStatus[];
  types?: string[];
  limit?: number;
  depth?: 0 | 1 | 2;
};

export type SearchHit = { entity: Entity; score: number; ranks: { vector?: number; text?: number } };

export type SearchResult = { hits: SearchHit[]; context: GraphSlice; vector: 'ok' | 'unavailable' };

/** Which entities a leg may return: the space, the requested statuses and, if given, the types and scope ids. */
export type LegFilter = {
  spaceId: string;
  statuses: EntityStatus[];
  types: string[] | undefined;
  ids?: string[] | undefined;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_QUERY = 2000;
const MAX_LIMIT = 50;
/** Candidates per leg before fusion. */
export const LEG_SIZE = 50;

// tsv is an internal search column; keep it out of returned entities, as core-graph does.
const { tsv: _tsv, ...entityColumns } = getTableColumns(entities);

/** Hybrid search (vector + full text, fused by RRF) over the space, with the provider read from the environment. */
export function search(spaceId: string, query: string, opts: SearchOptions = {}): Promise<SearchResult> {
  return searchSpace(configFromEnv(), spaceId, query, opts);
}

export async function searchSpace(
  config: ProviderConfig,
  spaceId: string,
  query: string,
  opts: SearchOptions,
): Promise<SearchResult> {
  const limit = opts.limit ?? 10;
  const depth = opts.depth ?? 1;
  validate(spaceId, query, limit, depth);
  const filter: LegFilter = {
    spaceId,
    statuses: opts.statuses ?? ['approved', 'draft'],
    types: opts.types,
    ids: opts.anchor ? await scopeIds(spaceId, opts.anchor) : undefined,
  };
  const [vector, text] = await Promise.all([vectorLegOrNothing(config, query, filter), textLeg(query, filter)]);
  const fused = fuse([vector ?? [], text]).slice(0, limit);
  const byId = await loadEntities(fused.map((f) => f.id));
  const rankIn = (list: string[] | undefined, id: string) => {
    const i = list?.indexOf(id) ?? -1;
    return i >= 0 ? i + 1 : undefined;
  };
  const hits = fused.flatMap(({ id, score }) => {
    const entity = byId.get(id);
    // An entity cannot disappear between the legs and this read (no hard delete in v1); skip it if it ever does.
    if (!entity) return [];
    return [{ entity, score, ranks: { vector: rankIn(vector, id), text: rankIn(text, id) } }];
  });
  const context = await contextOf(
    spaceId,
    hits.map((h) => h.entity.id),
    depth,
    filter,
  );
  return { hits, context, vector: vector ? 'ok' : 'unavailable' };
}

function validate(spaceId: string, query: string, limit: number, depth: number): void {
  // Same rule as core-graph: a malformed id behaves as missing. A well-formed unknown space just has no entities.
  if (!UUID.test(spaceId)) throw new NotFoundError(`Space ${spaceId} not found.`);
  if (query.trim().length === 0 || query.length > MAX_QUERY) {
    throw new EmbeddingConfigError(`query must have 1 to ${MAX_QUERY} characters, got ${query.length}.`);
  }
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    throw new EmbeddingConfigError(`limit must be an integer between 1 and ${MAX_LIMIT}, got ${limit}.`);
  }
  if (depth !== 0 && depth !== 1 && depth !== 2)
    throw new EmbeddingConfigError(`depth must be 0, 1 or 2, got ${depth}.`);
}

/** The vector leg, or undefined when the provider is down: search then falls back to the text leg alone. */
async function vectorLegOrNothing(config: ProviderConfig, query: string, filter: LegFilter) {
  try {
    return await vectorLeg(config, query, filter);
  } catch (err) {
    if (err instanceof EmbeddingProviderError) return undefined;
    throw err;
  }
}

const matches = (filter: LegFilter): SQL | undefined =>
  and(
    eq(entities.spaceId, filter.spaceId),
    inArray(entities.status, filter.statuses),
    filter.types ? inArray(entities.type, filter.types) : undefined,
    filter.ids ? inArray(entities.id, filter.ids) : undefined,
  );

/** Ids of the LEG_SIZE nearest entities by cosine distance, among the active model's vectors only (exact search). */
export async function vectorLeg(config: ProviderConfig, query: string, filter: LegFilter): Promise<string[]> {
  const [vector = []] = await embed(config, [modelSpec(config.model).query(query)]);
  const distance = sql`${entityEmbeddings.embedding} <=> ${vectorLiteral(vector)}::vector`;
  const rows = await db
    .select({ id: entities.id })
    .from(entities)
    .innerJoin(entityEmbeddings, vectorOf(config.model))
    .where(matches(filter))
    .orderBy(distance, asc(entities.id))
    .limit(LEG_SIZE);
  return rows.map((r) => r.id);
}

/** The BM25 indexes of migration 0008: same expression, one text search config each (Emenda 1). */
const BM25_INDEXES = ['entities_bm25_pt', 'entities_bm25_en'] as const;

/** Top BM25 matches in one index: pg_textsearch scores are negative (lower is better) and 0 means no term matched. */
async function bm25Leg(query: string, filter: LegFilter, index: string) {
  // Must stay the exact expression the indexes were built on, or the planner cannot use them.
  const score = sql<number>`(${entities.title} || ' ' || ${entities.content}) <@> to_bm25query(${query}, ${index})`;
  return db
    .select({ id: entities.id, score })
    .from(entities)
    .where(and(matches(filter), sql`${score} < 0`))
    .orderBy(score, asc(entities.id))
    .limit(LEG_SIZE);
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
 * Ids of the LEG_SIZE best BM25 matches, each entity at its best score across the Portuguese and English indexes
 * (stopwords of both languages dropped, words reduced to their stem). A query with no content word matches nothing.
 */
export async function textLeg(query: string, filter: LegFilter): Promise<string[]> {
  const words = await contentWords(query);
  if (!words) return [];
  const best = new Map<string, number>();
  for (const rows of await Promise.all(BM25_INDEXES.map((index) => bm25Leg(words, filter, index)))) {
    for (const { id, score } of rows) best.set(id, Math.min(score, best.get(id) ?? 0));
  }
  return [...best]
    .sort(([a, x], [b, y]) => x - y || (a < b ? -1 : 1))
    .slice(0, LEG_SIZE)
    .map(([id]) => id);
}

async function loadEntities(ids: string[]): Promise<Map<string, Entity>> {
  if (ids.length === 0) return new Map();
  const rows = await db.select(entityColumns).from(entities).where(inArray(entities.id, ids));
  return new Map(rows.map((e) => [e.id, e]));
}
