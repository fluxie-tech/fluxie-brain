import { describe, expect, it } from 'vitest';
import * as coreGraph from '../../src/core-graph/index.ts';

describe('core-graph public API', () => {
  it('exports exactly the functions, errors and read-only handles the specs define', () => {
    expect(Object.keys(coreGraph).sort()).toEqual(
      [
        'acceptProposal',
        'ConflictError',
        'CoreGraphError',
        'db',
        'entities',
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
        'relations',
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
