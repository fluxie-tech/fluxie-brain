import { and, eq, getTableColumns, inArray, or } from 'drizzle-orm';
import { logChange } from './changelog.ts';
import { db } from './db.ts';
import { NotFoundError } from './errors.ts';
import { type EntityStatus, getOntology, validateRelation } from './ontology.ts';
import { type Entity, entityColumns, findEntityOrThrow } from './rows.ts';
import { entities, relations } from './schema.ts';
import { findSpaceOrThrow, isUuid } from './scope.ts';
import type { Actor } from './types.ts';

export type Relation = typeof relations.$inferSelect;

export type LinkInput = {
  fromId: string;
  toId: string;
  type: string;
  weight?: number;
  metadata?: Record<string, unknown>;
};

/**
 * Creates a typed relation between two entities of the same space. Idempotent: linking the same
 * (from, to, type) again returns the existing relation without writing.
 */
export async function linkEntities(spaceId: string, link: LinkInput, actor: Actor): Promise<Relation> {
  const { fromId, toId, type } = link;
  return db.transaction(async (tx) => {
    const space = await findSpaceOrThrow(tx, spaceId);
    // Both endpoints must be in this space; v1 has no cross-space links, so a foreign id is just missing.
    // Lock in a fixed (sorted) order so concurrent A->B and B->A links cannot deadlock.
    const [first, second] = [fromId, toId].sort((x, y) => x.toLowerCase().localeCompare(y.toLowerCase()));
    const a = await findEntityOrThrow(tx, spaceId, first ?? fromId);
    const b = await findEntityOrThrow(tx, spaceId, second ?? toId);
    const from = a.id === fromId.toLowerCase() ? a : b;
    const to = b.id === toId.toLowerCase() ? b : a;
    validateRelation(getOntology(space.preset), type, from.type, to.type);

    const [created] = await tx
      .insert(relations)
      .values({ fromId, toId, type, weight: link.weight, metadata: link.metadata, createdBy: actor })
      .onConflictDoNothing()
      .returning();
    if (!created) {
      const [existing] = await tx
        .select()
        .from(relations)
        .where(and(eq(relations.fromId, fromId), eq(relations.toId, toId), eq(relations.type, type)));
      if (!existing) throw new Error('relation conflict without existing row');
      return existing;
    }
    await logChange(tx, {
      spaceId,
      kind: 'relation',
      action: 'create',
      target: created.id,
      actor,
      before: null,
      after: created,
    });
    return created;
  });
}

/** Removes a relation; its previous state is kept in the change log. */
export async function unlink(spaceId: string, relationId: string, actor: Actor): Promise<void> {
  await db.transaction(async (tx) => {
    const [before] =
      isUuid(spaceId) && isUuid(relationId)
        ? await tx
            .select(getTableColumns(relations))
            .from(relations)
            .innerJoin(entities, eq(entities.id, relations.fromId))
            .where(and(eq(relations.id, relationId), eq(entities.spaceId, spaceId)))
            .for('update', { of: relations })
        : [];
    if (!before) throw new NotFoundError(`Relation ${relationId} not found in this space.`);
    await tx.delete(relations).where(eq(relations.id, relationId));
    await logChange(tx, {
      spaceId,
      kind: 'relation',
      action: 'unlink',
      target: relationId,
      actor,
      before,
      after: null,
    });
  });
}

export type GraphSlice = { entities: (Entity & { depth: number })[]; relations: Relation[] };
type NeighborFilters = { relationTypes?: string[]; statuses?: EntityStatus[] };

/**
 * Entities reachable from `entityId` within `depth` hops (either direction), plus the relations among them.
 * Breadth-first with a visited set, so cycles terminate and each entity appears once at its shortest depth.
 * Entities filtered out by `statuses` are neither returned nor traversed.
 */
export async function neighbors(
  spaceId: string,
  entityId: string,
  depth: 1 | 2,
  opts: NeighborFilters = {},
): Promise<GraphSlice> {
  await findSpaceOrThrow(db, spaceId);
  const [root] = isUuid(entityId)
    ? await db
        .select({ id: entities.id })
        .from(entities)
        .where(and(eq(entities.spaceId, spaceId), eq(entities.id, entityId)))
    : [];
  if (!root) throw new NotFoundError(`Entity ${entityId} not found in this space.`);

  const visited = new Set([root.id]);
  const found: GraphSlice['entities'] = [];
  let frontier = [root.id];
  for (let d = 1; d <= depth && frontier.length > 0; d++) {
    const next = await expandLevel(spaceId, frontier, visited, opts);
    for (const e of next) {
      visited.add(e.id);
      found.push({ ...e, depth: d });
    }
    frontier = next.map((e) => e.id);
  }
  // One final query so edges between entities found at the deepest level are included too.
  const ids = [...visited];
  const among = await db
    .select()
    .from(relations)
    .where(
      and(
        inArray(relations.fromId, ids),
        inArray(relations.toId, ids),
        opts.relationTypes ? inArray(relations.type, opts.relationTypes) : undefined,
      ),
    );
  return { entities: found, relations: among };
}

/** One BFS step: the not-yet-visited entities reached by relations touching the frontier. */
async function expandLevel(
  spaceId: string,
  frontier: string[],
  visited: Set<string>,
  opts: NeighborFilters,
): Promise<Entity[]> {
  const touching = await db
    .select()
    .from(relations)
    .where(
      and(
        or(inArray(relations.fromId, frontier), inArray(relations.toId, frontier)),
        opts.relationTypes ? inArray(relations.type, opts.relationTypes) : undefined,
      ),
    );
  const candidates = [...new Set(touching.flatMap((r) => [r.fromId, r.toId]))].filter((id) => !visited.has(id));
  if (candidates.length === 0) return [];
  return db
    .select(entityColumns)
    .from(entities)
    .where(
      and(
        eq(entities.spaceId, spaceId),
        inArray(entities.id, candidates),
        opts.statuses ? inArray(entities.status, opts.statuses) : undefined,
      ),
    );
}

/** All relations touching an entity, in either direction. */
export async function relationsOf(entityId: string): Promise<Relation[]> {
  return db
    .select()
    .from(relations)
    .where(or(eq(relations.fromId, entityId), eq(relations.toId, entityId)))
    .orderBy(relations.createdAt);
}
