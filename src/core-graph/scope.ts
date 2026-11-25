import { eq } from 'drizzle-orm';
import type { Db, Tx } from './db.ts';
import { NotFoundError } from './errors.ts';
import { spaces } from './schema.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Treats malformed ids like missing ones, so callers get NotFoundError instead of a driver error. */
export function isUuid(id: string): boolean {
  return UUID.test(id);
}

export async function findSpaceOrThrow(tx: Db | Tx, spaceId: string) {
  const [space] = isUuid(spaceId) ? await tx.select().from(spaces).where(eq(spaces.id, spaceId)) : [];
  if (!space) throw new NotFoundError(`Space ${spaceId} not found.`);
  return space;
}
