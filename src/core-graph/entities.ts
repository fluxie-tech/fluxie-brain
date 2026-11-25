import { and, eq, inArray, sql } from 'drizzle-orm';
import { logChange } from './changelog.ts';
import { db, type Tx } from './db.ts';
import { isUniqueViolation, NotFoundError, OntologyError, VersionConflictError } from './errors.ts';
import { type EntityStatus, getOntology, validateEntity } from './ontology.ts';
import { createProposal, type Proposal, pendingProposalsFor } from './proposals.ts';
import { type Relation, relationsOf } from './relations.ts';
import { type Entity, entityColumns, findEntityOrThrow, sameContent } from './rows.ts';
import { entities, type ProposedChange } from './schema.ts';
import { findSpaceOrThrow, isUuid } from './scope.ts';
import type { Actor } from './types.ts';

export type { Entity };

export type EntityInput = {
  type: string;
  key: string;
  title: string;
  content: string;
  metadata?: Record<string, unknown>;
  confidence?: number;
  expectedVersion?: number;
};

type UpsertResult = { entity: Entity; proposal?: Proposal };

/**
 * Creates or updates an entity by (space, key). Status is never taken from input:
 * new entities get the type's default status; status changes go through setStatus.
 */
export async function upsertEntity(spaceId: string, input: EntityInput, actor: Actor): Promise<UpsertResult> {
  assertConfidence(input.confidence);
  try {
    return await db.transaction(async (tx) => {
      const space = await findSpaceOrThrow(tx, spaceId);
      const [existing] = await tx
        .select(entityColumns)
        .from(entities)
        .where(and(eq(entities.spaceId, spaceId), eq(entities.key, input.key)))
        .for('update');
      // Omitted metadata keeps the current one; send {} explicitly to clear it.
      const { metadata, defaultStatus } = validateEntity(
        getOntology(space.preset),
        input.type,
        input.metadata ?? existing?.metadata,
      );
      if (!existing) {
        return { entity: await insertEntity(tx, { ...input, spaceId, metadata, status: defaultStatus }, actor) };
      }
      assertUpdatable(existing, input);
      const next: ProposedChange = {
        title: input.title,
        content: input.content,
        metadata,
        confidence: input.confidence ?? existing.confidence,
      };
      // Agents repeat themselves; an upsert that changes nothing must not create curation work.
      if (sameContent(existing, next)) return { entity: existing };
      if (existing.status === 'approved') {
        // Approved knowledge never changes without review: the edit becomes a pending proposal.
        return { entity: existing, proposal: await createProposal(tx, existing, next, actor) };
      }
      return { entity: await updateEntity(tx, existing, next, actor) };
    });
  } catch (err) {
    // Two concurrent creates of the same key: the loser sees the row the winner inserted.
    if (isUniqueViolation(err))
      throw new VersionConflictError(`Entity "${input.key}" was created concurrently; retry.`);
    throw err;
  }
}

function assertConfidence(confidence: number | undefined): void {
  // `!(x >= 0 && x <= 1)` also rejects NaN, which a range comparison alone would let through.
  if (confidence !== undefined && !(confidence >= 0 && confidence <= 1)) {
    throw new OntologyError(`Confidence must be between 0 and 1, got ${confidence}.`);
  }
}

function assertUpdatable(existing: Entity, input: EntityInput): void {
  if (existing.type !== input.type) {
    throw new OntologyError(`Key "${input.key}" already belongs to a "${existing.type}", not a "${input.type}".`);
  }
  if (input.expectedVersion !== undefined && input.expectedVersion !== existing.version) {
    throw new VersionConflictError(
      `Entity "${input.key}" is at version ${existing.version}, expected ${input.expectedVersion}.`,
    );
  }
}

type NewEntity = Omit<EntityInput, 'expectedVersion'> & {
  spaceId: string;
  metadata: Record<string, unknown>;
  status: EntityStatus;
};

async function insertEntity(tx: Tx, values: NewEntity, actor: Actor): Promise<Entity> {
  const { spaceId, type, key, title, content, metadata, confidence, status } = values;
  const [created] = await tx
    .insert(entities)
    .values({ spaceId, type, key, title, content, metadata, confidence, status, createdBy: actor })
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
  return created;
}

async function updateEntity(tx: Tx, existing: Entity, next: ProposedChange, actor: Actor): Promise<Entity> {
  const [updated] = await tx
    .update(entities)
    .set({
      ...next,
      // Rejected or deprecated knowledge that is proposed again goes back to review.
      status: 'draft',
      version: sql`${entities.version} + 1`,
      updatedAt: new Date(),
    })
    .where(eq(entities.id, existing.id))
    .returning(entityColumns);
  if (!updated) throw new Error('update returned no row');
  await logChange(tx, {
    spaceId: existing.spaceId,
    kind: 'entity',
    action: 'update',
    target: existing.id,
    actor,
    before: existing,
    after: updated,
  });
  return updated;
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
    await findSpaceOrThrow(tx, spaceId);
    const updated = await tx
      .update(entities)
      .set({ usageCount: sql`${entities.usageCount} + 1`, lastUsedAt: new Date() })
      .where(and(eq(entities.spaceId, spaceId), inArray(entities.id, ids)))
      .returning({ id: entities.id });
    // Any id outside the space rolls back the whole batch.
    if (updated.length !== ids.length) throw new NotFoundError('One or more entities were not found in this space.');
  });
}

export type EntityDetail = Entity & { relations: Relation[]; pendingProposals: Proposal[] };

/** Returns the entity with this key in the space (with its relations and pending proposals), or null. */
export async function getEntity(spaceId: string, key: string): Promise<EntityDetail | null> {
  await findSpaceOrThrow(db, spaceId);
  const [entity] = await db
    .select(entityColumns)
    .from(entities)
    .where(and(eq(entities.spaceId, spaceId), eq(entities.key, key)));
  if (!entity) return null;
  return {
    ...entity,
    relations: await relationsOf(entity.id),
    pendingProposals: await pendingProposalsFor(entity.id),
  };
}
