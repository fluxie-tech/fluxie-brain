import { getTableColumns, inArray } from 'drizzle-orm';
import { db, type Entity, type EntityStatus, entities, type GraphSlice, NotFoundError } from '../core-graph/index.ts';
import { contextOf } from './context.ts';
import { EmbeddingConfigError } from './errors.ts';
import { combine, type Fusion, type Scored } from './fusion.ts';
import { type LegFilter, runLegs } from './legs.ts';
import { configFromEnv, type ProviderConfig } from './provider.ts';
import { type Anchor, scopeIds } from './scope.ts';

export type SearchOptions = {
  /** Restricts every leg to the anchor's scope; the mcp-server passes the space preset's rule. */
  anchor?: Anchor;
  statuses?: EntityStatus[];
  types?: string[];
  limit?: number;
  depth?: 0 | 1 | 2;
};

export type SearchHit = {
  entity: Entity;
  score: number;
  ranks: { vector?: number; text?: number; graph?: number };
};

export type SearchResult = { hits: SearchHit[]; context: GraphSlice; vector: 'ok' | 'unavailable' };

/**
 * The fusion in production. Provisional until the dogfooding benchmark calibrates it (task T18 of the embeddings plan);
 * fixed in code on purpose, never read from the environment.
 */
export const FUSION: Fusion = { fn: 'rrf', text: 1, graph: 1 };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_QUERY = 2000;
const MAX_LIMIT = 50;
/** Candidates per leg: twice the hits asked for (as in Supabase's hybrid search), at most 60. */
export const legSize = (limit: number) => Math.min(2 * limit, 60);

// tsv is an internal search column; keep it out of returned entities, as core-graph does.
const { tsv: _tsv, ...entityColumns } = getTableColumns(entities);

/** Hybrid search (vector, BM25 text and graph legs, fused) over the space, with the provider read from the environment. */
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
  const legs = await runLegs(config, query, filter, { size: legSize(limit), graph: FUSION.graph > 0 });
  const fused = combine(legs, FUSION).slice(0, limit);
  const byId = await loadEntities(fused.map((f) => f.id));
  const rankIn = (list: Scored[] | undefined, id: string) => {
    const i = list?.findIndex((s) => s.id === id) ?? -1;
    return i >= 0 ? i + 1 : undefined;
  };
  const hits = fused.flatMap(({ id, score }) => {
    const entity = byId.get(id);
    // An entity cannot disappear between the legs and this read (no hard delete in v1); skip it if it ever does.
    if (!entity) return [];
    const ranks = { vector: rankIn(legs.vector, id), text: rankIn(legs.text, id), graph: rankIn(legs.graph, id) };
    return [{ entity, score, ranks }];
  });
  const context = await contextOf(
    spaceId,
    hits.map((h) => h.entity.id),
    depth,
    filter,
  );
  return { hits, context, vector: legs.vector ? 'ok' : 'unavailable' };
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

async function loadEntities(ids: string[]): Promise<Map<string, Entity>> {
  if (ids.length === 0) return new Map();
  const rows = await db.select(entityColumns).from(entities).where(inArray(entities.id, ids));
  return new Map(rows.map((e) => [e.id, e]));
}
