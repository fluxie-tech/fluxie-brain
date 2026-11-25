import { isDeepStrictEqual } from 'node:util';
import { and, eq, getTableColumns } from 'drizzle-orm';
import type { Db, Tx } from './db.ts';
import { NotFoundError } from './errors.ts';
import { entities, type ProposedChange } from './schema.ts';
import { isUuid } from './scope.ts';

// Base layer shared by entities, proposals, relations and history. Must not import those files.

// tsv is an internal search column; keep it out of returned rows and change-log snapshots.
const { tsv: _tsv, ...entityColumns } = getTableColumns(entities);

export { entityColumns };

export type Entity = Omit<typeof entities.$inferSelect, 'tsv'>;

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

/** True when applying `next` would leave the entity's content fields unchanged. */
export function sameContent(current: ProposedChange, next: ProposedChange): boolean {
  return (
    current.title === next.title &&
    current.content === next.content &&
    // confidence is stored as `real` (float32): compare at that precision or repeats never match.
    Math.fround(current.confidence) === Math.fround(next.confidence) &&
    isDeepStrictEqual(current.metadata, next.metadata)
  );
}
