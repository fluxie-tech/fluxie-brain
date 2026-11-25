/** Development Graph entity types. Origin and license: see ./index.ts. */
import { z } from 'zod';
import type { EntityTypeDef } from '../types.ts';

/** Every knowledge entity must link to at least one anchor, so retrieval can start from the work context. */
export const ANCHORS = ['repo', 'component', 'dependency'];

const ANCHOR_RULE =
  'Always link it to at least one repo, component or dependency, or it cannot be found from the work.';
/** Shared by invariant, assumption and learning so agents pick the right one. */
const CHOOSE_TYPE =
  'Choose the type by what you know: a property of OUR code that a test or check can verify is an invariant; ' +
  'a belief about how an EXTERNAL system behaves is an assumption; a lesson with no checkable guarantee is a learning.';
const holdsState = z
  .enum(['holds', 'violated'])
  .meta({ description: 'holds = currently true; violated = currently broken (a bug or a moved upstream)' });
const guardRef = z
  .string()
  .optional()
  .meta({ description: 'Path to the test or check that enforces it; absent = unguarded' });

const structureTypes = {
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
} satisfies Record<string, EntityTypeDef>;

const governanceTypes = {
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
      `${CHOOSE_TYPE} Title: the property, e.g. "confidence is compared at float32 precision". ` +
      'Content: what breaks if it does not hold. ' +
      `Key: invariant:<kebab-slug>. Link it with about to the component it protects. ${ANCHOR_RULE}`,
    defaultStatus: 'draft',
    metadata: z.strictObject({ state: holdsState, guardRef }),
  },
} satisfies Record<string, EntityTypeDef>;

const externalTypes = {
  assumption: {
    description:
      "Checkable belief about an EXTERNAL system's API or behavior (library, service, platform), optionally " +
      'pinned by a guard. External twin of invariant.',
    instruction:
      `${CHOOSE_TYPE} Title: the belief, e.g. "dependency-cruiser cannot parse TypeScript 7 sources". ` +
      'Content: what we rely on, how we noticed, and the workaround if it is violated. ' +
      `Key: assumption:<kebab-slug>. Link it with about to the dependency it is about. ${ANCHOR_RULE}`,
    defaultStatus: 'draft',
    metadata: z.strictObject({
      kind: z
        .enum(['compile', 'runtime', 'manual'])
        .meta({ description: 'How it is checked: at compile time, at runtime, or only by a person' }),
      state: holdsState,
      guardRef,
    }),
  },
  gap: {
    description:
      'Tracked technical debt: a desired invariant not yet held, or work blocked until an upstream fix ships.',
    instruction:
      'Title: the debt in one sentence. Content: current behavior, target behavior and the workaround in place. ' +
      'Key: gap:<kebab-slug>. Link it with about to what it affects, with undermines to the invariant it breaks, ' +
      `and with waits_for to the dependency whose fix it waits for. Set state closed when paid off. ${ANCHOR_RULE}`,
    defaultStatus: 'draft',
    metadata: z.strictObject({
      state: z
        .enum(['narrowing', 'widened', 'closed'])
        .meta({ description: 'narrowing = being paid off; widened = got worse; closed = paid off' }),
      upstreamUrl: z.string().optional().meta({ description: 'Upstream issue, PR or release that would close it' }),
      pinnedVersion: z.string().optional().meta({ description: 'Version we are pinned to while waiting' }),
      shippedInVersion: z.string().optional().meta({ description: 'Upstream version that ships the fix' }),
    }),
  },
  learning: {
    description: 'Captured lesson: a discovered gotcha, design hindsight, retro takeaway or incident analysis.',
    instruction:
      `${CHOOSE_TYPE} Title: the lesson as one actionable sentence. Content: what happened, why, and what to do ` +
      'next time. Key: learning:<kebab-slug>. Link it with about to the repo, component or dependency it is ' +
      `about, and with references to related decisions or specs. ${ANCHOR_RULE}`,
    defaultStatus: 'draft',
    metadata: z.strictObject({
      kind: z
        .enum(['gotcha', 'hindsight', 'retro', 'incident_review'])
        .meta({ description: 'gotcha = surprising behavior; hindsight = design lesson; retro/incident_review' }),
    }),
  },
} satisfies Record<string, EntityTypeDef>;

export const entityTypes = { ...structureTypes, ...governanceTypes, ...externalTypes };
