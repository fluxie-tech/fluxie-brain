export { type Entity, type EntityInput, getEntity, upsertEntity } from './entities.ts';
export { ConflictError, CoreGraphError, NotFoundError, OntologyError, VersionConflictError } from './errors.ts';
export { type EntityStatus, type Ontology, registerOntology } from './ontology.ts';
export { createSpace, type Space } from './spaces.ts';
export type { Actor } from './types.ts';
