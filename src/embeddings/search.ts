import { and, asc, desc, eq, getTableColumns, inArray, type SQL, sql } from 'drizzle-orm';
import { db, type Entity, type EntityStatus, entities, type GraphSlice, NotFoundError } from '../core-graph/index.ts';
import { contextOf } from './context.ts';
import { EmbeddingConfigError, EmbeddingProviderError } from './errors.ts';
import { fuse, orQuery } from './fusion.ts';
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

/** Ids of the LEG_SIZE best full-text matches (any query word, ranked by ts_rank_cd); none for a query without words. */
export async function textLeg(query: string, filter: LegFilter): Promise<string[]> {
  const terms = orQuery(query);
  if (!terms) return [];
  const tsquery = sql`to_tsquery('simple', ${terms})`;
  const rows = await db
    .select({ id: entities.id })
    .from(entities)
    .where(and(matches(filter), sql`${entities.tsv} @@ ${tsquery}`))
    .orderBy(desc(sql`ts_rank_cd(${entities.tsv}, ${tsquery})`), asc(entities.id))
    .limit(LEG_SIZE);
  return rows.map((r) => r.id);
}

async function loadEntities(ids: string[]): Promise<Map<string, Entity>> {
  if (ids.length === 0) return new Map();
  const rows = await db.select(entityColumns).from(entities).where(inArray(entities.id, ids));
  return new Map(rows.map((e) => [e.id, e]));
}
