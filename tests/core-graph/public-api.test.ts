import { describe, expect, it } from 'vitest';
import * as coreGraph from '../../src/core-graph/index.ts';

describe('core-graph public API', () => {
  it('exports exactly the functions and errors the spec defines', () => {
    expect(Object.keys(coreGraph).sort()).toEqual(
      [
        'acceptProposal',
        'ConflictError',
        'CoreGraphError',
        'createSpace',
        'getEntity',
        'history',
        'linkEntities',
        'listProposals',
        'neighbors',
        'NotFoundError',
        'OntologyError',
        'recordUsage',
        'registerOntology',
        'rejectProposal',
        'revertEntity',
        'setStatus',
        'unlink',
        'upsertEntity',
        'VersionConflictError',
      ].sort(),
    );
  });
});
