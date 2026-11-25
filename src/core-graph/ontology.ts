import { z } from 'zod';
import { OntologyError } from './errors.ts';

export { OntologyError };

export type EntityStatus = 'draft' | 'approved' | 'deprecated' | 'rejected';

export type Ontology = {
  entityTypes: Record<string, { metadata: z.ZodType; defaultStatus: 'draft' | 'approved' }>;
  relationTypes: Record<string, { from: string[]; to: string[] }>;
};

// shortcut: in-memory registry filled at startup; move to the DB when the web-ui edits types.
const registry = new Map<string, Ontology>();

export function registerOntology(preset: string, ontology: Ontology): void {
  registry.set(preset, ontology);
}

export function getOntology(preset: string): Ontology {
  const ontology = registry.get(preset);
  if (!ontology) throw new OntologyError(`Preset "${preset}" is not registered.`);
  return ontology;
}

/** Validates an entity type and its metadata; returns the parsed metadata and the type's default status. */
export function validateEntity(
  ontology: Ontology,
  type: string,
  metadata: unknown,
): { metadata: Record<string, unknown>; defaultStatus: 'draft' | 'approved' } {
  const def = ontology.entityTypes[type];
  if (!def) {
    const allowed = Object.keys(ontology.entityTypes).join(', ');
    throw new OntologyError(`Entity type "${type}" is not defined. Allowed types: ${allowed}.`);
  }
  const parsed = def.metadata.safeParse(metadata ?? {});
  if (!parsed.success) {
    throw new OntologyError(`Invalid metadata for "${type}": ${z.prettifyError(parsed.error)}`);
  }
  return { metadata: parsed.data as Record<string, unknown>, defaultStatus: def.defaultStatus };
}
