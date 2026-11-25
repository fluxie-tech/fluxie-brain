import { z } from 'zod';
import type { Ontology } from '../../src/core-graph/index.ts';

/** Fictional ontology used only by tests; independent of the real presets. */
export const TEST_PRESET = 'test-preset';

export const testOntology: Ontology = {
  entityTypes: {
    project: { metadata: z.object({ repo: z.string().optional() }), defaultStatus: 'approved' },
    learning: { metadata: z.object({ cause: z.string().optional() }), defaultStatus: 'draft' },
    rule: { metadata: z.object({ severity: z.enum(['low', 'high']) }), defaultStatus: 'approved' },
  },
  relationTypes: {
    learned_from: { from: ['learning'], to: ['project'] },
    applies_to: { from: ['rule'], to: ['project'] },
    relates_to: { from: ['learning', 'rule', 'project'], to: ['learning', 'rule', 'project'] },
  },
};
