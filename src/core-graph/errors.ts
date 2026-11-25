/** Base class for errors the core-graph API raises on purpose; messages are written for agents. */
export class CoreGraphError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** The write violates the space ontology (unknown type, invalid metadata, disallowed relation). */
export class OntologyError extends CoreGraphError {}

/** The target does not exist in the given space. */
export class NotFoundError extends CoreGraphError {}

/** Optimistic concurrency check failed: the target changed since it was read. */
export class VersionConflictError extends CoreGraphError {}

/** A uniqueness rule was violated (e.g. duplicate space slug). */
export class ConflictError extends CoreGraphError {}

/** True when a driver error (possibly wrapped by Drizzle) is a Postgres unique violation. */
export function isUniqueViolation(err: unknown): boolean {
  const e = err as { code?: string; cause?: { code?: string } };
  return e?.code === '23505' || e?.cause?.code === '23505';
}
