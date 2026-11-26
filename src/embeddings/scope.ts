import { and, eq, sql } from 'drizzle-orm';
import { db, entities, NotFoundError } from '../core-graph/index.ts';

/** How an anchor scopes search: `containment` both ways and transitively, `usage` one hop outward. */
export type ScopeRule = { containment: string[]; usage: string[] };

export type Anchor = { key: string; scope: ScopeRule };

/**
 * Ids in the anchor's scope (SPEC-embeddings.md, "Escopo pela âncora"):
 * own = the anchor plus its containment closure, both directions;
 * used = one usage hop out of any own entity, never expanded further (so no way back to another repo);
 * in scope = own and used, plus every entity linked to them by a relation that is neither containment nor usage.
 * UNION (not UNION ALL) in the recursive part makes cycles terminate.
 */
export async function scopeIds(spaceId: string, anchor: Anchor): Promise<string[]> {
  const [root] = await db
    .select({ id: entities.id })
    .from(entities)
    .where(and(eq(entities.spaceId, spaceId), eq(entities.key, anchor.key)));
  if (!root) throw new NotFoundError(`Anchor ${anchor.key} not found in this space.`);
  const containment = sql`${sql.param(anchor.scope.containment)}::text[]`;
  const usage = sql`${sql.param(anchor.scope.usage)}::text[]`;
  const { rows } = await db.execute<{ id: string }>(sql`
    with recursive own(id) as (
      select ${root.id}::uuid
      union
      select case when r.from_id = own.id then r.to_id else r.from_id end
        from relations r join own on r.from_id = own.id or r.to_id = own.id
       where r.type = any(${containment})
    ),
    core(id) as (
      select id from own
      union
      select r.to_id from relations r join own on r.from_id = own.id where r.type = any(${usage})
    )
    select id from core
    union
    select case when r.from_id = core.id then r.to_id else r.from_id end
      from relations r join core on r.from_id = core.id or r.to_id = core.id
     where not (r.type = any(${containment}) or r.type = any(${usage}))`);
  return rows.map((r) => r.id);
}
