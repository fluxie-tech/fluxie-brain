/**
 * Development Graph preset: decisions, rules and lessons behind codebases, anchored to repos, components
 * and dependencies.
 *
 * Adapted from the governance/knowledge layer of the omnigraph-cookbooks `dev-graph` schema
 * (https://github.com/ModernRelay/omnigraph-cookbooks/tree/main/dev-graph), MIT License,
 * Copyright (c) 2026 ModernRelay. Tracker types (Issue, PR, Commit, Release...) are left out on purpose;
 * lifecycle status maps onto core-graph's curation status (see SPEC-presets.md).
 */
import type { Preset } from '../types.ts';
import { entityTypes } from './entities.ts';
import { relationTypes } from './relations.ts';

export const DEVELOPMENT_GRAPH = 'development-graph';

export const developmentGraph = {
  id: DEVELOPMENT_GRAPH,
  name: 'Development Graph',
  description:
    'Decisions, rules and lessons behind codebases, anchored to the repos, components and dependencies they ' +
    'apply to. One space can hold many repos: stack-specific knowledge stays with its anchors, shared knowledge ' +
    'is reached through shared dependencies.',
  ontology: { entityTypes, relationTypes },
} satisfies Preset;
