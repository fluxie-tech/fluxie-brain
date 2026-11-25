import type { z } from 'zod';

/** An entity type as agents see it: what it is, how to fill it, and its metadata schema. */
export type EntityTypeDef = {
  description: string;
  /** Usage guidance for agents: title/content shape, key convention, when to pick this type. */
  instruction: string;
  defaultStatus: 'draft' | 'approved';
  /** A z.strictObject without Date/transform/refine, so it survives JSON round-trips and JSON Schema export. */
  metadata: z.ZodType;
};

export type RelationTypeDef = { description: string; from: string[]; to: string[] };

/** A memory type. Its `ontology` is a structural superset of core-graph's `Ontology`. */
export type Preset = {
  /** Persisted in spaces.preset: a stable contract, never renamed. */
  id: string;
  name: string;
  description: string;
  ontology: { entityTypes: Record<string, EntityTypeDef>; relationTypes: Record<string, RelationTypeDef> };
};
