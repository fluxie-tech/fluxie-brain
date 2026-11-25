import { and, eq, getTableColumns, inArray, sql } from 'drizzle-orm';
import { type Db, db, type Tx } from './db.ts';
import { isUniqueViolation, NotFoundError, OntologyError, VersionConflictError } from './errors.ts';
import { logChange } from './history.ts';
import { type EntityStatus, getOntology, validateEntity } from './ontology.ts';
import { entities } from './schema.ts';
import { findSpaceOrThrow, isUuid } from './scope.ts';
import type { Actor } from './types.ts';

// tsv is an internal search column; keep it out of returned rows and change-log snapshots.
const { tsv: _tsv, ...entityColumns } = getTableColumns(entities);

/** Loads an entity by id, locking it for update; ids outside the space behave as missing. */
export async function findEntityOrThrow(tx: Db | Tx, spaceId: string, entityId: string): Promise<Entity> {
  const [entity] = isUuid(entityId)
    ? await tx
        .select(entityColumns)
        .from(entities)
        .where(and(eq(entities.spaceId, spaceId), eq(entities.id, entityId)))
        .for('update')
    : [];
  if (!entity) throw new NotFoundError(`Entity ${entityId} not found in this space.`);
  return entity;
}

export { entityColumns };

export type Entity = Omit<typeof entities.$inferSelect, 'tsv'>;

export type EntityInput = {
  type: string;
  key: string;
  title: string;
  content: string;
  metadata?: Record<string, unknown>;
  confidence?: number;
  expectedVersion?: number;
};

/**
 * Creates or updates an entity by (space, key). Status is never taken from input:
 * new entities get the type's default status; status changes go through setStatus.
 */
export async function upsertEntity(spaceId: string, input: EntityInput, actor: Actor): Promise<{ entity: Entity }> {
  try {
    return await db.transaction(async (tx) => {
      const space = await findSpaceOrThrow(tx, spaceId);
      const { metadata, defaultStatus } = validateEntity(getOntology(space.preset), input.type, input.metadata);

      const [existing] = await tx
        .select(entityColumns)
        .from(entities)
        .where(and(eq(entities.spaceId, spaceId), eq(entities.key, input.key)))
        .for('update');

      if (!existing) {
        const [created] = await tx
          .insert(entities)
          .values({
            spaceId,
            type: input.type,
            key: input.key,
            title: input.title,
            content: input.content,
            metadata,
            confidence: input.confidence,
            status: defaultStatus,
            createdBy: actor,
          })
          .returning(entityColumns);
        if (!created) throw new Error('insert returned no row');
        await logChange(tx, {
          spaceId,
          kind: 'entity',
          action: 'create',
          target: created.id,
          actor,
          before: null,
          after: created,
        });
        return { entity: created };
      }

      if (existing.type !== input.type) {
        throw new OntologyError(`Key "${input.key}" already belongs to a "${existing.type}", not a "${input.type}".`);
      }
      if (input.expectedVersion !== undefined && input.expectedVersion !== existing.version) {
        throw new VersionConflictError(
          `Entity "${input.key}" is at version ${existing.version}, expected ${input.expectedVersion}.`,
        );
      }
      if (existing.status === 'approved') {
        // Proposal flow for approved entities is added in T6.
        throw new Error('Updating an approved entity is not implemented yet.');
      }

      const [updated] = await tx
        .update(entities)
        .set({
          title: input.title,
          content: input.content,
          metadata,
          confidence: input.confidence ?? existing.confidence,
          // Rejected or deprecated knowledge that is proposed again goes back to review.
          status: 'draft',
          version: sql`${entities.version} + 1`,
          updatedAt: new Date(),
        })
        .where(eq(entities.id, existing.id))
        .returning(entityColumns);
      if (!updated) throw new Error('update returned no row');
      await logChange(tx, {
        spaceId,
        kind: 'entity',
        action: 'update',
        target: existing.id,
        actor,
        before: existing,
        after: updated,
      });
      return { entity: updated };
    });
  } catch (err) {
    // Two concurrent creates of the same key: the loser sees the row the winner inserted.
    if (isUniqueViolation(err))
      throw new VersionConflictError(`Entity "${input.key}" was created concurrently; retry.`);
    throw err;
  }
}

/** Changes an entity's status (the only way status changes); logged as a curation decision. */
export async function setStatus(
  spaceId: string,
  entityId: string,
  status: EntityStatus,
  actor: Actor,
): Promise<Entity> {
  return db.transaction(async (tx) => {
    const before = await findEntityOrThrow(tx, spaceId, entityId);
    const [after] = await tx
      .update(entities)
      .set({ status, version: sql`${entities.version} + 1`, updatedAt: new Date() })
      .where(eq(entities.id, entityId))
      .returning(entityColumns);
    if (!after) throw new Error('update returned no row');
    await logChange(tx, { spaceId, kind: 'entity', action: 'status', target: entityId, actor, before, after });
    return after;
  });
}

/** Marks entities as used. Not an edit: no version bump and no change-log entry. */
export async function recordUsage(spaceId: string, entityIds: string[]): Promise<void> {
  const ids = [...new Set(entityIds)];
  if (ids.length === 0) return;
  if (!ids.every(isUuid)) throw new NotFoundError('One or more entities were not found in this space.');
  await db.transaction(async (tx) => {
    const updated = await tx
      .update(entities)
      .set({ usageCount: sql`${entities.usageCount} + 1`, lastUsedAt: new Date() })
      .where(and(eq(entities.spaceId, spaceId), inArray(entities.id, ids)))
      .returning({ id: entities.id });
    // Any id outside the space rolls back the whole batch.
    if (updated.length !== ids.length) throw new NotFoundError('One or more entities were not found in this space.');
  });
}

/** Returns the entity with this key in the space, or null. */
export async function getEntity(spaceId: string, key: string): Promise<Entity | null> {
  await findSpaceOrThrow(db, spaceId);
  const [entity] = await db
    .select(entityColumns)
    .from(entities)
    .where(and(eq(entities.spaceId, spaceId), eq(entities.key, key)));
  return entity ?? null;
}
