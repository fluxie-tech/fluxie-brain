import { and, eq, inArray, or, sql } from 'drizzle-orm';
import { db, type Tx } from './db.ts';
import { type Entity, entityColumns, findEntityOrThrow } from './entities.ts';
import { NotFoundError } from './errors.ts';
import { getOntology, validateEntity } from './ontology.ts';
import { changeLog, entities, entityProposals } from './schema.ts';
import { findSpaceOrThrow } from './scope.ts';
import type { Actor } from './types.ts';

export type ChangeLogEntry = typeof changeLog.$inferSelect;

type ChangeEntry = {
  spaceId: string;
  kind: ChangeLogEntry['targetKind'];
  action: ChangeLogEntry['action'];
  target: string;
  actor: Actor;
  before: object | null;
  after: object | null;
};

/** Records one write in the change log; must run inside the same transaction as the write. */
export async function logChange(tx: Tx, e: ChangeEntry): Promise<void> {
  await tx.insert(changeLog).values({
    spaceId: e.spaceId,
    targetKind: e.kind,
    targetId: e.target,
    action: e.action,
    actor: e.actor,
    before: e.before,
    after: e.after,
  });
}

/** The entity's change log, oldest first, including the proposals made on it. */
export async function history(spaceId: string, entityId: string): Promise<ChangeLogEntry[]> {
  return db.transaction(async (tx) => {
    await findSpaceOrThrow(tx, spaceId);
    await findEntityOrThrow(tx, spaceId, entityId);
    const proposalIds = tx
      .select({ id: entityProposals.id })
      .from(entityProposals)
      .where(eq(entityProposals.entityId, entityId));
    return tx
      .select()
      .from(changeLog)
      .where(
        and(
          eq(changeLog.spaceId, spaceId),
          or(eq(changeLog.targetId, entityId), inArray(changeLog.targetId, proposalIds)),
        ),
      )
      .orderBy(changeLog.id);
  });
}

type ContentSnapshot = Pick<Entity, 'title' | 'content' | 'metadata' | 'confidence'>;

/**
 * Restores title, content, metadata and confidence from the `after` state of one of the entity's changes.
 * Never touches key, type, space or status; the version keeps increasing and the revert is logged.
 */
export async function revertEntity(spaceId: string, entityId: string, changeId: number, actor: Actor): Promise<Entity> {
  return db.transaction(async (tx) => {
    const space = await findSpaceOrThrow(tx, spaceId);
    const before = await findEntityOrThrow(tx, spaceId, entityId);
    const [change] = Number.isSafeInteger(changeId)
      ? await tx
          .select()
          .from(changeLog)
          .where(
            and(
              eq(changeLog.id, changeId),
              eq(changeLog.spaceId, spaceId),
              eq(changeLog.targetKind, 'entity'),
              eq(changeLog.targetId, entityId),
            ),
          )
      : [];
    const snapshot = change?.after as ContentSnapshot | null | undefined;
    if (!snapshot) throw new NotFoundError(`Change ${changeId} of entity ${entityId} not found in this space.`);

    // The ontology may have changed since that version: restored metadata must still be valid.
    const { metadata } = validateEntity(getOntology(space.preset), before.type, snapshot.metadata);
    const [after] = await tx
      .update(entities)
      .set({
        title: snapshot.title,
        content: snapshot.content,
        metadata,
        confidence: snapshot.confidence,
        version: sql`${entities.version} + 1`,
        updatedAt: new Date(),
      })
      .where(eq(entities.id, entityId))
      .returning(entityColumns);
    if (!after) throw new Error('update returned no row');
    await logChange(tx, { spaceId, kind: 'entity', action: 'revert', target: entityId, actor, before, after });
    return after;
  });
}
