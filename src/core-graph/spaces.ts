import { db } from './db.ts';
import { ConflictError, isUniqueViolation } from './errors.ts';
import { getOntology } from './ontology.ts';
import { spaces } from './schema.ts';

export type Space = typeof spaces.$inferSelect;

/** Creates a space; its preset must already be registered. */
export async function createSpace(input: { slug: string; name: string; preset: string }): Promise<Space> {
  getOntology(input.preset);
  try {
    const [space] = await db.insert(spaces).values(input).returning();
    if (!space) throw new Error('insert returned no row');
    return space;
  } catch (err) {
    if (isUniqueViolation(err)) throw new ConflictError(`A space with slug "${input.slug}" already exists.`);
    throw err;
  }
}
