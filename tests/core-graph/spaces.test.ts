import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ConflictError, createSpace, OntologyError, registerOntology } from '../../src/core-graph/index.ts';
import { TEST_PRESET, testOntology } from '../fixtures/ontology.ts';
import { truncateAll } from '../setup/db.ts';

describe('createSpace', () => {
  beforeAll(() => registerOntology(TEST_PRESET, testOntology));
  beforeEach(() => truncateAll());

  it('creates a space for a registered preset', async () => {
    const space = await createSpace({ slug: 'dev', name: 'Dev graph', preset: TEST_PRESET });
    expect(space).toMatchObject({ slug: 'dev', name: 'Dev graph', preset: TEST_PRESET });
    expect(space.id).toBeTypeOf('string');
  });

  it('rejects a preset that is not registered', async () => {
    await expect(createSpace({ slug: 'x', name: 'X', preset: 'unknown-preset' })).rejects.toThrow(OntologyError);
  });

  it('rejects a duplicate slug', async () => {
    await createSpace({ slug: 'dev', name: 'Dev graph', preset: TEST_PRESET });
    await expect(createSpace({ slug: 'dev', name: 'Other', preset: TEST_PRESET })).rejects.toThrow(ConflictError);
  });
});
