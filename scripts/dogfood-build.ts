// Dogfooding step 3 (SPEC-embeddings.md, Emenda 1): merge the agents' batches into .dogfood/dataset.json.
// Validates against the preset, loads everything into the TEST database through core-graph (proof that no write is
// refused), then empties it again. Prints counts only, never content.
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildDataset, type ExtractionFile, splitQueries } from './dogfood-dataset.ts';

const testUrl = process.env.TEST_DATABASE_URL;
if (!testUrl) throw new Error('Missing TEST_DATABASE_URL. Copy .env.example to .env.');
// core-graph opens its pool at import (pendência 1): point it at the test database before importing it.
process.env.DATABASE_URL = testUrl;

const { createSpace } = await import('../src/core-graph/index.ts');
const { pool } = await import('../src/core-graph/db.ts');
const { DEVELOPMENT_GRAPH, registerPresets } = await import('../src/presets/index.ts');
const { loadCorpus } = await import('../tests/fixtures/development-graph/load.ts');
const { truncateAll } = await import('../tests/setup/db.ts');

const dir = '.dogfood';
const read = (file: string) => JSON.parse(readFileSync(file, 'utf8')) as ExtractionFile;
const batchFiles = readdirSync(join(dir, 'extracted'))
  .filter((f) => f.endsWith('.json'))
  .sort();
const files = [read(join(dir, 'anchors.json')), ...batchFiles.map((f) => read(join(dir, 'extracted', f)))];
const raw = {
  entities: files.reduce((n, f) => n + (f.entities?.length ?? 0), 0),
  relations: files.reduce((n, f) => n + (f.relations?.length ?? 0), 0),
  queries: files.reduce((n, f) => n + (f.queries?.length ?? 0), 0),
};
const { entities, relations, queries, dropped } = buildDataset(files);
const split = splitQueries(queries).map((q, i) => ({ id: `q${String(i + 1).padStart(4, '0')}`, ...q }));

registerPresets();
try {
  await truncateAll();
  const space = await createSpace({ slug: 'dogfood', name: 'Dogfood', preset: DEVELOPMENT_GRAPH });
  const corpus = {
    entities: entities.map(({ source: _source, ...e }) => ({ ...e, project: 'dogfood' as const })),
    relations,
  };
  const stored = await loadCorpus(space.id, 'agent:dogfood', corpus);
  if (stored.size !== entities.length) throw new Error(`stored ${stored.size} of ${entities.length} entities`);
} finally {
  await truncateAll();
  await pool.end();
}

writeFileSync(
  join(dir, 'dataset.json'),
  JSON.stringify({
    createdAt: new Date().toISOString(),
    batches: batchFiles.length,
    entities,
    relations,
    queries: split,
  }),
);
const count = (key: (q: (typeof split)[number]) => string) =>
  JSON.stringify(Object.fromEntries([...Map.groupBy(split, key)].map(([k, v]) => [k, v.length]).sort()));
console.log(`lotes: ${batchFiles.length} + âncoras`);
console.log(`brutos: ${raw.entities} entidades, ${raw.relations} relações, ${raw.queries} consultas`);
console.log(`válidos: ${entities.length} entidades, ${relations.length} relações, ${split.length} consultas`);
console.log(`descartes: ${JSON.stringify(dropped)}`);
console.log(`consultas por grupo: ${count((q) => `${q.lang}->${q.targetLang}`)}`);
console.log(`consultas por tipo: ${count((q) => q.kind)}`);
console.log(`divisão: ${count((q) => q.split)}`);
console.log('carga no banco de testes pelo core-graph: ok');
