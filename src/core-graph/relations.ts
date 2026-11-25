import { and, eq, getTableColumns, or } from 'drizzle-orm';
import { db } from './db.ts';
import { findEntityOrThrow } from './entities.ts';
import { NotFoundError, OntologyError } from './errors.ts';
import { logChange } from './history.ts';
import { getOntology, validateRelation } from './ontology.ts';
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
    const [to] = isUuid(toId) ? await tx.select().from(entities).where(eq(entities.id, toId)) : [];
    if (!to) throw new NotFoundError(`Entity ${toId} not found.`);
    if (to.spaceId !== spaceId) throw new OntologyError('Relations between different spaces are not allowed.');
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

/** All relations touching an entity, in either direction. */
export async function relationsOf(entityId: string): Promise<Relation[]> {
  return db
    .select()
    .from(relations)
    .where(or(eq(relations.fromId, entityId), eq(relations.toId, entityId)))
    .orderBy(relations.createdAt);
}
