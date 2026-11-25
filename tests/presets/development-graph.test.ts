import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { developmentGraph } from '../../src/presets/index.ts';

const { entityTypes, relationTypes } = developmentGraph.ontology;

/** One valid metadata per type, plus one with an out-of-enum value for types that have an enum. */
const examples: Record<string, { valid: Record<string, unknown>; badEnum?: Record<string, unknown> }> = {
  repo: { valid: { host: 'github', ref: 'acme/app', defaultBranch: 'main' }, badEnum: { host: 'bitbucket' } },
  component: { valid: { path: 'src/api', criticality: 'high' }, badEnum: { criticality: 'extreme' } },
  dependency: { valid: { ecosystem: 'npm', version: '1.2.3' }, badEnum: { ecosystem: 'apt' } },
  spec: { valid: { location: 'SPEC-api.md' } },
};

type JsonSchema = { additionalProperties?: boolean; properties?: Record<string, { description?: string }> };

describe('development graph ontology', () => {
  it('only links entity types that exist', () => {
    for (const [name, def] of Object.entries(relationTypes)) {
      for (const type of [...def.from, ...def.to]) expect(entityTypes, `${name} → ${type}`).toHaveProperty(type);
    }
  });

  it('describes every entity and relation type', () => {
    for (const def of [...Object.values(entityTypes), ...Object.values(relationTypes)]) {
      expect(def.description.trim()).not.toBe('');
    }
  });

  it('teaches the key convention in every entity type instruction', () => {
    for (const [type, def] of Object.entries(entityTypes)) expect(def.instruction).toContain(`${type}:`);
  });

  it('has a metadata example for every entity type', () => {
    expect(Object.keys(examples).sort()).toEqual(Object.keys(entityTypes).sort());
  });

  describe.each(Object.entries(entityTypes))('%s metadata', (type, def) => {
    const example = examples[type] ?? { valid: {} };

    it('converts to a closed JSON Schema with a description on every field', () => {
      const schema = z.toJSONSchema(def.metadata) as JsonSchema;
      expect(schema.additionalProperties).toBe(false);
      for (const [field, prop] of Object.entries(schema.properties ?? {})) {
        expect(prop.description, field).toBeTruthy();
      }
    });

    it('accepts the valid example and rejects unknown keys', () => {
      expect(def.metadata.safeParse(example.valid).success).toBe(true);
      expect(def.metadata.safeParse({ ...example.valid, unexpected: 1 }).success).toBe(false);
    });
  });

  const withEnum = Object.entries(entityTypes).filter(([type]) => examples[type]?.badEnum);
  it.each(withEnum)('%s metadata rejects a value outside its enum', (type, def) => {
    const example = examples[type];
    expect(def.metadata.safeParse({ ...example?.valid, ...example?.badEnum }).success).toBe(false);
  });
});
