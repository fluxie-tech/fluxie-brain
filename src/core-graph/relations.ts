import { and, eq, getTableColumns, inArray, or } from 'drizzle-orm';
import { db } from './db.ts';
import { type Entity, entityColumns, findEntityOrThrow } from './entities.ts';
import { NotFoundError } from './errors.ts';
import { logChange } from './history.ts';
import { type EntityStatus, getOntology, validateRelation } from './ontology.ts';
import { entities, relations } from './schema.ts';
import { findSpaceOrThrow, isUuid } from './scope.ts';
import type { Actor } from './types.ts';

export type Relation = typeof relations.$inferSelect;

/**
 * Creates a typed relation between two entities of the same space. Idempotent: linking the same
 * (from, to, type) again returns the existing relation without writing.
 */
export async function linkEntities(
  spaceId: string,
  fromId: string,
  toId: string,
  type: string,
  actor: Actor,
  opts: { weight?: number; metadata?: Record<string, unknown> } = {},
): Promise<Relation> {
  return db.transaction(async (tx) => {
    const space = await findSpaceOrThrow(tx, spaceId);
    const from = await findEntityOrThrow(tx, spaceId, fromId);
    // Both endpoints must be in this space; v1 has no cross-space links, so a foreign id is just missing.
    const to = await findEntityOrThrow(tx, spaceId, toId);
    validateRelation(getOntology(space.preset), type, from.type, to.type);

    const [created] = await tx
      .insert(relations)
      .values({ fromId, toId, type, weight: opts.weight, metadata: opts.metadata, createdBy: actor })
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
    const [before] = isUuid(relationId)
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

/**
 * Entities reachable from `entityId` within `depth` hops (either direction), plus the relations among them.
 * Breadth-first with a visited set, so cycles terminate and each entity appears once at its shortest depth.
 * Entities filtered out by `statuses` are neither returned nor traversed.
 */
export async function neighbors(
  spaceId: string,
  entityId: string,
  depth: 1 | 2,
  opts: { relationTypes?: string[]; statuses?: EntityStatus[] } = {},
): Promise<GraphSlice> {
  await findSpaceOrThrow(db, spaceId);
  const [root] = isUuid(entityId)
    ? await db
        .select({ id: entities.id })
        .from(entities)
        .where(and(eq(entities.spaceId, spaceId), eq(entities.id, entityId)))
    : [];
  if (!root) throw new NotFoundError(`Entity ${entityId} not found in this space.`);

  const visited = new Set([entityId]);
  const found: GraphSlice['entities'] = [];
  const edges = new Map<string, Relation>();
  let frontier = [entityId];

  for (let d = 1; d <= depth && frontier.length > 0; d++) {
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
    const next =
      candidates.length === 0
        ? []
        : await db
            .select(entityColumns)
            .from(entities)
            .where(
              and(
                eq(entities.spaceId, spaceId),
                inArray(entities.id, candidates),
                opts.statuses ? inArray(entities.status, opts.statuses) : undefined,
              ),
            );
    for (const e of next) {
      visited.add(e.id);
      found.push({ ...e, depth: d });
    }
    for (const r of touching) if (visited.has(r.fromId) && visited.has(r.toId)) edges.set(r.id, r);
    frontier = next.map((e) => e.id);
  }

  return { entities: found, relations: [...edges.values()] };
}

/** All relations touching an entity, in either direction. */
export async function relationsOf(entityId: string): Promise<Relation[]> {
  return db
    .select()
    .from(relations)
    .where(or(eq(relations.fromId, entityId), eq(relations.toId, entityId)))
    .orderBy(relations.createdAt);
}
