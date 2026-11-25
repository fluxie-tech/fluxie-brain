/** Development Graph relation types. Origin and license: see ./index.ts. */
import type { RelationTypeDef } from '../types.ts';
import { ANCHORS, entityTypes } from './entities.ts';

const ALL_TYPES = Object.keys(entityTypes);

export const relationTypes = {
  part_of: {
    description: 'A component belongs to a repo or to a parent component.',
    from: ['component'],
    to: ['repo', 'component'],
  },
  depends_on: {
    description: 'A repo or component depends on a component or dependency (runtime or build time).',
    from: ['repo', 'component'],
    to: ['component', 'dependency'],
  },
  describes: { description: 'A spec specifies a repo or component.', from: ['spec'], to: ['repo', 'component'] },
  applies_to: {
    description: 'Scope a decision or principle governs.',
    from: ['decision', 'principle'],
    to: [...ANCHORS, 'spec'],
  },
  establishes: {
    description: 'A decision introduces a principle or invariant.',
    from: ['decision'],
    to: ['principle', 'invariant'],
  },
  relaxes: {
    description: 'A decision loosens a principle or invariant, which stays in force in its narrower form.',
    from: ['decision'],
    to: ['principle', 'invariant'],
  },
  supersedes: {
    description: 'A newer item replaces an older one of the same type; mark the old one deprecated.',
    from: ['decision', 'spec', 'principle'],
    to: ['decision', 'spec', 'principle'],
  },
  about: {
    description: 'A lesson, invariant, assumption or gap concerns a repo, component or dependency (its anchor).',
    from: ['learning', 'invariant', 'assumption', 'gap'],
    to: ANCHORS,
  },
  references: {
    description: 'A lesson or spec cites a decision or another spec.',
    from: ['learning', 'spec'],
    to: ['decision', 'spec'],
  },
  undermines: { description: 'A gap breaks an invariant we want to hold.', from: ['gap'], to: ['invariant'] },
  waits_for: {
    description: 'A gap is blocked until a dependency ships a fix (pin and versions live on the gap).',
    from: ['gap'],
    to: ['dependency'],
  },
  relates_to: {
    description: 'Informational link when no specific relation fits. Prefer a specific relation.',
    from: ALL_TYPES,
    to: ALL_TYPES,
  },
} satisfies Record<string, RelationTypeDef>;
