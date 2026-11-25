import { describe, expect, it } from 'vitest';
import { getOntology, OntologyError, validateEntity } from '../../src/core-graph/ontology.ts';
import { testOntology } from '../fixtures/ontology.ts';

describe('validateEntity', () => {
  it('rejects an entity type the ontology does not define', () => {
    expect(() => validateEntity(testOntology, 'meeting', {})).toThrow(OntologyError);
  });

  it('rejects metadata that does not match the type schema', () => {
    expect(() => validateEntity(testOntology, 'rule', { severity: 'urgent' })).toThrow(OntologyError);
  });

  it('returns parsed metadata and the type default status for valid input', () => {
    const result = validateEntity(testOntology, 'rule', { severity: 'high' });
    expect(result).toEqual({ metadata: { severity: 'high' }, defaultStatus: 'approved' });
  });
});

describe('getOntology', () => {
  it('fails for a preset that was never registered', () => {
    expect(() => getOntology('never-registered')).toThrow(OntologyError);
  });
});
