/**
 * Development Graph preset: decisions, rules and lessons behind codebases, anchored to repos, components
 * and dependencies.
 *
 * Adapted from the governance/knowledge layer of the omnigraph-cookbooks `dev-graph` schema
 * (https://github.com/ModernRelay/omnigraph-cookbooks/tree/main/dev-graph), MIT License,
 * Copyright (c) 2026 ModernRelay. Tracker types (Issue, PR, Commit, Release...) are left out on purpose;
 * lifecycle status maps onto core-graph's curation status (see SPEC-presets.md).
 */
import { z } from 'zod';
import type { Preset } from './types.ts';

export const DEVELOPMENT_GRAPH = 'development-graph';

/** Every knowledge entity must link to at least one anchor, so retrieval can start from the work context. */
const ANCHORS = ['repo', 'component', 'dependency'];
const STRUCTURE = [...ANCHORS, 'spec'];
const KNOWLEDGE = ['decision', 'principle', 'invariant'];
const ANCHOR_RULE =
  'Always link it to at least one repo, component or dependency, or it cannot be found from the work.';
const holdsState = z
  .enum(['holds', 'violated'])
  .meta({ description: 'holds = currently true; violated = currently broken (a bug or a moved upstream)' });

export const developmentGraph = {
  id: DEVELOPMENT_GRAPH,
  name: 'Development Graph',
  description:
    'Decisions, rules and lessons behind codebases, anchored to the repos, components and dependencies they ' +
    'apply to. One space can hold many repos: stack-specific knowledge stays with its anchors, shared knowledge ' +
    'is reached through shared dependencies.',
  ontology: {
    entityTypes: {
      repo: {
        description: 'A version-controlled repository (VCS unit).',
        instruction:
          'Title: the repo name. Content: what the repo is for, in a few sentences. ' +
          'Key: repo:<owner>/<name>, e.g. repo:acme/billing-api. Create it once and link everything else to it.',
        defaultStatus: 'approved',
        metadata: z.strictObject({
          host: z.enum(['github', 'gitlab', 'other']).optional().meta({ description: 'Where the repo is hosted' }),
          ref: z.string().optional().meta({ description: 'owner/name on the host, e.g. acme/billing-api' }),
          defaultBranch: z.string().optional().meta({ description: 'Default branch, e.g. main' }),
          visibility: z.enum(['public', 'private']).optional().meta({ description: 'Repo visibility' }),
        }),
      },
      component: {
        description: 'A logical unit of code inside a repo: service, module or top-level package.',
        instruction:
          'Title: the component name. Content: its responsibility and boundaries. ' +
          'Key: component:<repo-name>/<component-name>, e.g. component:billing-api/invoices. ' +
          'Link it to its repo (or parent component) with part_of, and to what it uses with depends_on.',
        defaultStatus: 'approved',
        metadata: z.strictObject({
          path: z.string().optional().meta({ description: 'Path in the repo, e.g. src/invoices' }),
          criticality: z
            .enum(['low', 'medium', 'high', 'critical'])
            .optional()
            .meta({ description: 'How much breaks if this component fails' }),
        }),
      },
      dependency: {
        description:
          'Something a repo or component depends on: a language, library, container image, external service ' +
          'or tool. Shared across repos, so knowledge about it reaches every project that uses it.',
        instruction:
          'Title: the dependency name. Content: what it is used for. ' +
          'Key: dependency:<ecosystem>/<name>, without version, e.g. dependency:npm/react, ' +
          'dependency:language/php, dependency:docker/postgres. Use the same key in every repo so knowledge is shared; ' +
          'put the pinned version in metadata.',
        defaultStatus: 'approved',
        metadata: z.strictObject({
          ecosystem: z
            .enum([
              'language',
              'npm',
              'pypi',
              'composer',
              'cargo',
              'go',
              'maven',
              'nuget',
              'gem',
              'docker',
              'service',
              'tool',
              'other',
            ])
            .meta({ description: 'Package ecosystem, or language/service/tool for non-packages' }),
          version: z.string().optional().meta({ description: 'Version in use, e.g. 4.6.7' }),
        }),
      },
      spec: {
        description: 'A design document or RFC that lives outside the graph (e.g. SPEC-*.md).',
        instruction:
          'Title: the document title. Content: a short summary of what it specifies. ' +
          'Key: spec:<repo-name>/<path>, e.g. spec:billing-api/SPEC-invoices.md. ' +
          'Link it with describes to the repo or component it specifies.',
        defaultStatus: 'approved',
        metadata: z.strictObject({
          location: z.string().meta({ description: 'Path in the repo or URL of the document' }),
        }),
      },
      decision: {
        description:
          'Architecture Decision Record: a choice that was made, with its context and consequences. ' +
          'Never rewritten once approved; a later decision supersedes it.',
        instruction:
          'Title: the decision as a short statement, e.g. "Postgres runs with separate migrator and app roles". ' +
          'Content: Context (why a choice was needed), Decision, Consequences, Alternatives considered. ' +
          'Key: decision:<kebab-slug>. To change an approved decision, create a new one and link it with supersedes ' +
          `to the old one; do not edit the old one. Link it with applies_to to what it governs. ${ANCHOR_RULE}`,
        defaultStatus: 'draft',
        metadata: z.strictObject({}),
      },
      principle: {
        description: 'Prescriptive working rule that every change is reviewed against. Violation = rejected change.',
        instruction:
          'Title: the rule as one imperative sentence. Content: why it exists and, when it forbids something, the ' +
          'correct alternative. Key: principle:<kebab-slug>. Link it with applies_to to the repo, component or ' +
          `dependency it governs; a decision can establish or relax it. ${ANCHOR_RULE}`,
        defaultStatus: 'draft',
        metadata: z.strictObject({
          polarity: z
            .enum(['prescribes', 'forbids'])
            .meta({ description: 'prescribes = always do this; forbids = never do this' }),
        }),
      },
      invariant: {
        description:
          'Checkable property our own code maintains. Violation = bug. Internal twin of assumption, which is about ' +
          'external systems.',
        instruction:
          'Use invariant for a property of OUR code that a test or check can verify; use assumption for beliefs about ' +
          'an external system; use learning for a lesson with no checkable guarantee. Title: the property, e.g. ' +
          '"confidence is compared at float32 precision". Content: what breaks if it does not hold. ' +
          `Key: invariant:<kebab-slug>. Link it with about to the component it protects. ${ANCHOR_RULE}`,
        defaultStatus: 'draft',
        metadata: z.strictObject({
          state: holdsState,
          guardRef: z
            .string()
            .optional()
            .meta({ description: 'Path to the test or check that enforces it; absent = unguarded' }),
        }),
      },
    },
    relationTypes: {
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
      relates_to: {
        description: 'Informational link when no specific relation fits. Prefer a specific relation.',
        from: [...STRUCTURE, ...KNOWLEDGE],
        to: [...STRUCTURE, ...KNOWLEDGE],
      },
    },
  },
} satisfies Preset;
