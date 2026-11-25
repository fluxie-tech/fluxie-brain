export {
  type Entity,
  type EntityDetail,
  type EntityInput,
  getEntity,
  recordUsage,
  setStatus,
  upsertEntity,
} from './entities.ts';
export { ConflictError, CoreGraphError, NotFoundError, OntologyError, VersionConflictError } from './errors.ts';
export { type EntityStatus, type Ontology, registerOntology } from './ontology.ts';
export { acceptProposal, listProposals, type Proposal, rejectProposal } from './proposals.ts';
export { linkEntities, type Relation, unlink } from './relations.ts';
export { createSpace, type Space } from './spaces.ts';
export type { Actor } from './types.ts';
