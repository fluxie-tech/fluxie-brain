import { and, eq, getTableColumns, sql } from 'drizzle-orm';
import { db } from './db.ts';
import { isUniqueViolation, OntologyError, VersionConflictError } from './errors.ts';
import { logChange } from './history.ts';
import { getOntology, validateEntity } from './ontology.ts';
import { entities } from './schema.ts';
import { findSpaceOrThrow } from './scope.ts';
import type { Actor } from './types.ts';

// tsv is an internal search column; keep it out of returned rows and change-log snapshots.
const { tsv: _tsv, ...entityColumns } = getTableColumns(entities);

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
      if (existing.status !== 'draft') {
        // Approved / deprecated / rejected flows are added in the next tasks (proposals, re-drafting).
        throw new Error(`Updating a "${existing.status}" entity is not implemented yet.`);
      }

      const [updated] = await tx
        .update(entities)
        .set({
          title: input.title,
          content: input.content,
          metadata,
          confidence: input.confidence ?? existing.confidence,
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

/** Returns the entity with this key in the space, or null. */
export async function getEntity(spaceId: string, key: string): Promise<Entity | null> {
  await findSpaceOrThrow(db, spaceId);
  const [entity] = await db
    .select(entityColumns)
    .from(entities)
    .where(and(eq(entities.spaceId, spaceId), eq(entities.key, key)));
  return entity ?? null;
}
