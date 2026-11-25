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
  decision: { valid: {} },
  principle: { valid: { polarity: 'forbids' }, badEnum: { polarity: 'suggests' } },
  invariant: { valid: { state: 'holds', guardRef: 'tests/api.test.ts' }, badEnum: { state: 'unknown' } },
  assumption: { valid: { kind: 'compile', state: 'violated' }, badEnum: { kind: 'hope' } },
  gap: { valid: { state: 'narrowing', upstreamUrl: 'https://example.com/issue/1' }, badEnum: { state: 'open' } },
  learning: { valid: { kind: 'gotcha' }, badEnum: { kind: 'rumor' } },
};

/** The ontology as SPEC-presets.md defines it. */
const SPEC_ENTITY_TYPES: Record<string, 'draft' | 'approved'> = {
  repo: 'approved',
  component: 'approved',
  dependency: 'approved',
  spec: 'approved',
  decision: 'draft',
  principle: 'draft',
  invariant: 'draft',
  assumption: 'draft',
  gap: 'draft',
  learning: 'draft',
};
const SPEC_RELATIONS: Record<string, [from: string[], to: string[]]> = {
  part_of: [['component'], ['repo', 'component']],
  depends_on: [
    ['repo', 'component'],
    ['component', 'dependency'],
  ],
  describes: [['spec'], ['repo', 'component']],
  applies_to: [
    ['decision', 'principle'],
    ['repo', 'component', 'dependency', 'spec'],
  ],
  establishes: [['decision'], ['principle', 'invariant']],
  relaxes: [['decision'], ['principle', 'invariant']],
  supersedes: [
    ['decision', 'spec', 'principle'],
    ['decision', 'spec', 'principle'],
  ],
  about: [
    ['learning', 'invariant', 'assumption', 'gap'],
    ['repo', 'component', 'dependency'],
  ],
  references: [
    ['learning', 'spec'],
    ['decision', 'spec'],
  ],
  undermines: [['gap'], ['invariant']],
  waits_for: [['gap'], ['dependency']],
  relates_to: [Object.keys(SPEC_ENTITY_TYPES), Object.keys(SPEC_ENTITY_TYPES)],
};

type JsonSchema = { additionalProperties?: boolean; properties?: Record<string, { description?: string }> };

describe('development graph ontology', () => {
  it('has exactly the entity types and default statuses of the spec', () => {
    const actual = Object.fromEntries(Object.entries(entityTypes).map(([type, def]) => [type, def.defaultStatus]));
    expect(actual).toEqual(SPEC_ENTITY_TYPES);
  });

  it('has exactly the relations and endpoints of the spec', () => {
    const sorted = (types: string[]) => [...types].sort();
    const actual = Object.fromEntries(
      Object.entries(relationTypes).map(([name, def]) => [name, [sorted(def.from), sorted(def.to)]]),
    );
    const expected = Object.fromEntries(
      Object.entries(SPEC_RELATIONS).map(([name, [from, to]]) => [name, [sorted(from), sorted(to)]]),
    );
    expect(actual).toEqual(expected);
  });

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
