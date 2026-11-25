/**
 * Architecture boundaries for fluxie-brain (see CAPABILITY-MAP.md and CONSTRAINTS.md).
 * Modules live in src/<module-id>/ and talk to each other only through src/<module-id>/index.ts.
 */

// Allowed dependencies per module, mirroring CAPABILITY-MAP.md. A module missing here may import no other module.
const allowed = {
  'core-graph': [],
  embeddings: ['core-graph'],
  presets: ['core-graph'],
  'mcp-server': ['core-graph', 'embeddings', 'presets'],
  'agent-loop': ['mcp-server'],
  curation: ['mcp-server'],
  'ingest-conversations': ['mcp-server', 'embeddings'],
  'web-ui': ['mcp-server', 'curation'],
};

const moduleRules = Object.entries(allowed).map(([mod, deps]) => ({
  name: `capability-map:${mod}`,
  comment: `${mod} may only depend on: ${deps.join(', ') || 'nothing'} (CAPABILITY-MAP.md).`,
  severity: 'error',
  from: { path: `^src/${mod}/` },
  to: { path: '^src/[^/]+/', pathNot: [`^src/${mod}/`, ...deps.map((d) => `^src/${d}/`)] },
}));

module.exports = {
  forbidden: [
    {
      name: 'no-circular',
      comment: 'Circular imports hide layering and make load order fragile.',
      severity: 'error',
      from: {},
      to: { circular: true },
    },
    {
      name: 'cross-module-via-index',
      comment: 'Import another module only through its public index.ts.',
      severity: 'error',
      from: { path: '^src/([^/]+)/' },
      to: { path: '^src/[^/]+/', pathNot: ['^src/$1/', '^src/[^/]+/index\\.ts$'] },
    },
    {
      name: 'not-to-dev-dep',
      comment: 'Production code must not import devDependencies.',
      severity: 'error',
      from: { path: '^src/' },
      to: { dependencyTypes: ['npm-dev'], dependencyTypesNot: ['type-only'] },
    },
    {
      name: 'not-to-unresolvable',
      comment: 'Every import must resolve.',
      severity: 'error',
      from: {},
      to: { couldNotResolve: true },
    },
    ...moduleRules,
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    tsConfig: { fileName: 'tsconfig.json' },
    parser: 'swc',
    tsPreCompilationDeps: true,
    enhancedResolveOptions: { exportsFields: ['exports'], conditionNames: ['import', 'require', 'node', 'default'] },
  },
};
