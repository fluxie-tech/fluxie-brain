// Embeddings benchmark (SPEC-embeddings.md, "Benchmark"). Run by hand with Ollama up: `pnpm bench:embeddings`.
// It wipes and fills the TEST database (TEST_DATABASE_URL); truncateAll refuses any database without the _test suffix.
import { execFileSync } from 'node:child_process';
import { chooseModel, type ModelRun, mean, percentile, recall, reciprocalRank } from './bench-metrics.ts';

const testUrl = process.env.TEST_DATABASE_URL;
if (!testUrl) throw new Error('Missing TEST_DATABASE_URL. Copy .env.example to .env.');
// core-graph opens its pool at import (pendência 1): point it at the test database before importing anything.
process.env.DATABASE_URL = testUrl;

const { createSpace } = await import('../src/core-graph/index.ts');
const { pool } = await import('../src/core-graph/db.ts');
const { combine, queryShape } = await import('../src/embeddings/fusion.ts');
const { MODELS, modelSpec } = await import('../src/embeddings/models.ts');
const { configFromEnv, embed, isLocalProvider } = await import('../src/embeddings/provider.ts');
const { runLegs } = await import('../src/embeddings/legs.ts');
const { FUSION, legSize } = await import('../src/embeddings/search.ts');
const { syncSpace } = await import('../src/embeddings/sync.ts');
const { DEVELOPMENT_GRAPH, registerPresets } = await import('../src/presets/index.ts');
const { loadBenchmarkData, queries } = await import('../tests/fixtures/embeddings/load.ts');
const { queryRows, truncateAll } = await import('../tests/setup/db.ts');

type Config = ReturnType<typeof configFromEnv>;
type Leg = 'vector' | 'text' | 'graph' | 'hybrid';
type Ranked = { query: (typeof queries)[number]; lists: Record<Leg, string[]> };

const LEGS: Leg[] = ['vector', 'text', 'graph', 'hybrid'];
const GROUPS = ['all', 'en->en', 'pt->pt', 'pt->en', 'en->pt'];
const FILTER_STATUSES = ['approved', 'draft'] as const;

const ollama = (...args: string[]) =>
  execFileSync('docker', ['compose', 'exec', '-T', 'ollama', 'ollama', ...args], { encoding: 'utf8' });
const seconds = (ms: number) => `${(ms / 1000).toFixed(1)} s`;

async function timed<T>(fn: () => Promise<T>): Promise<[T, number]> {
  const start = performance.now();
  const value = await fn();
  return [value, performance.now() - start];
}

/** Fresh test space with the corpus and the distractors; returns key by entity id. */
async function prepareSpace(): Promise<{ spaceId: string; keyOf: Map<string, string> }> {
  await truncateAll();
  const space = await createSpace({ slug: 'bench', name: 'Bench', preset: DEVELOPMENT_GRAPH });
  const byKey = await loadBenchmarkData(space.id);
  return { spaceId: space.id, keyOf: new Map([...byKey].map(([key, e]) => [e.id, key])) };
}

/** Unloads every model, then times the first embedding call: the cold load. */
async function coldLoad(config: Config): Promise<number> {
  for (const model of Object.keys(MODELS)) {
    try {
      ollama('stop', model);
    } catch {
      // Not loaded: nothing to stop.
    }
  }
  return (await timed(() => embed(config, ['warm-up'])))[1];
}

async function rankAll(config: Config, spaceId: string, keyOf: Map<string, string>): Promise<Ranked[]> {
  const filter = { spaceId, statuses: [...FILTER_STATUSES], types: undefined };
  const toKeys = (ids: string[]) => ids.map((id) => keyOf.get(id) ?? id);
  const ranked: Ranked[] = [];
  for (const query of queries) {
    const legs = await runLegs(config, query.text, filter, { size: legSize(10), graph: true });
    const ids = (list: { id: string }[] | undefined) => toKeys((list ?? []).map((s) => s.id));
    const hybrid = ids(combine(legs, FUSION[queryShape(query.text)]));
    ranked.push({ query, lists: { vector: ids(legs.vector), text: ids(legs.text), graph: ids(legs.graph), hybrid } });
  }
  return ranked;
}

/** Embedding time of each query with the model already loaded (the CPU latency the rule looks at). */
async function queryLatencies(config: Config): Promise<number[]> {
  const { query } = modelSpec(config.model);
  const ms: number[] = [];
  for (const q of queries) ms.push((await timed(() => embed(config, [query(q.text)])))[1]);
  return ms;
}

function scores(ranked: Ranked[], leg: Leg, group: string): { mrr: number; recall: number } {
  const rows = ranked.filter((r) => group === 'all' || `${r.query.lang}->${r.query.targetLang}` === group);
  return {
    mrr: mean(rows.map((r) => reciprocalRank(r.lists[leg], r.query.expected, 10))),
    recall: mean(rows.map((r) => recall(r.lists[leg], r.query.expected, 5))),
  };
}

function memoryOfOllama(): string {
  const id = execFileSync('docker', ['compose', 'ps', '-q', 'ollama'], { encoding: 'utf8' }).trim();
  return execFileSync('docker', ['stats', '--no-stream', '--format', '{{.MemUsage}}', id], { encoding: 'utf8' }).trim();
}

async function nanVectors(model: string): Promise<number> {
  const [row] = await queryRows<{ n: string }>(
    `select count(*) as n from entity_embeddings where model = $1 and 'NaN'::real = any(embedding::real[])`,
    [model],
  );
  return Number(row?.n ?? 0);
}

async function benchModel(model: string) {
  const config = { ...configFromEnv(), model };
  ollama('pull', model);
  const { spaceId, keyOf } = await prepareSpace();
  const cold = await coldLoad(config);
  const [sync, syncMs] = await timed(() => syncSpace(config, spaceId, 32));
  if (sync.remaining !== 0) throw new Error(`${model}: ${sync.remaining} entities left without a vector`);
  const ranked = await rankAll(config, spaceId, keyOf);
  const latencies = await queryLatencies(config);
  return {
    model,
    ranked,
    cold,
    syncMs,
    embedded: sync.embedded,
    p50: percentile(latencies, 50),
    p95: percentile(latencies, 95),
    memory: memoryOfOllama(),
    nan: await nanVectors(model),
  };
}

type Result = Awaited<ReturnType<typeof benchModel>>;

function printQuality(results: Result[]): void {
  console.log(`\n| Modelo | Perna | ${GROUPS.join(' | ')} |`);
  console.log(`|---|---|${GROUPS.map(() => '---').join('|')}|`);
  for (const r of results) {
    for (const leg of LEGS) {
      const cells = GROUPS.map((g) => {
        const s = scores(r.ranked, leg, g);
        return `${s.mrr.toFixed(3)} / ${s.recall.toFixed(2)}`;
      });
      console.log(`| ${r.model} | ${leg} | ${cells.join(' | ')} |`);
    }
  }
  console.log('\nCélulas: MRR@10 / recall@5.');
}

function printPerformance(results: Result[]): void {
  console.log(
    '\n| Modelo | Carga a frio | p50 consulta | p95 consulta | Corpus (embutir) | Memória do ollama | Vetores com NaN |',
  );
  console.log('|---|---|---|---|---|---|---|');
  for (const r of results) {
    const corpus = `${seconds(r.syncMs)} (${r.embedded} entidades)`;
    const latency = `${r.p50.toFixed(0)} ms | ${r.p95.toFixed(0)} ms`;
    console.log(`| ${r.model} | ${seconds(r.cold)} | ${latency} | ${corpus} | ${r.memory} | ${r.nan} |`);
  }
}

// A remote provider costs money and receives the benchmark texts: stop unless --yes. Never prints the API key.
const baseUrl = configFromEnv().baseUrl;
if (!isLocalProvider(baseUrl) && !process.argv.includes('--yes')) {
  console.log(`Provedor remoto (${new URL(baseUrl).host}): nada foi enviado. Rode de novo com --yes para seguir.`);
  process.exit(0);
}

registerPresets();
try {
  const results: Result[] = [];
  for (const model of Object.keys(MODELS)) {
    console.error(`benchmarking ${model}...`);
    results.push(await benchModel(model));
  }
  console.log(`Ollama ${ollama('--version').trim()} · ${queries.length} consultas · ${new Date().toISOString()}`);
  printQuality(results);
  printPerformance(results);
  const runs: ModelRun[] = results.map((r) => ({
    model: r.model,
    hybridMrr: scores(r.ranked, 'hybrid', 'all').mrr,
    p50: r.p50,
    p95: r.p95,
  }));
  const { winner, reason } = chooseModel(runs);
  console.log(`\nVencedor pela regra: ${winner ?? 'nenhum'} (${reason}).`);
} finally {
  await truncateAll();
  await pool.end();
}
