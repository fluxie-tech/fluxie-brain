// Fusion calibration on the dogfooding dataset (SPEC-embeddings.md, Emenda 1). Run by hand with Ollama up:
// `pnpm bench:fusion`. Wipes and fills the TEST database. Prints aggregates only, never text from the dataset.
import { readFileSync } from 'node:fs';
import { chooseFusion, type FusionEval, mean, percentile, recall, reciprocalRank } from './bench-metrics.ts';

const testUrl = process.env.TEST_DATABASE_URL;
if (!testUrl) throw new Error('Missing TEST_DATABASE_URL. Copy .env.example to .env.');
// core-graph opens its pool at import (pendência 1): point it at the test database before importing anything.
process.env.DATABASE_URL = testUrl;

const { createSpace } = await import('../src/core-graph/index.ts');
const { pool } = await import('../src/core-graph/db.ts');
const { combine, queryShape } = await import('../src/embeddings/fusion.ts');
const { runLegs } = await import('../src/embeddings/legs.ts');
const { configFromEnv } = await import('../src/embeddings/provider.ts');
const { FUSION, legSize, searchSpace } = await import('../src/embeddings/search.ts');
const { syncSpace } = await import('../src/embeddings/sync.ts');
const { DEVELOPMENT_GRAPH, registerPresets } = await import('../src/presets/index.ts');
const { loadCorpus } = await import('../tests/fixtures/development-graph/load.ts');
const { queryRows, truncateAll } = await import('../tests/setup/db.ts');

type Fusion = FusionEval['fusion'];
type Scored = { id: string; score: number };
type Legs = { vector: Scored[] | undefined; text: Scored[]; graph: Scored[] };
type Query = { id: string; lang: string; targetLang: string; kind: string; text: string; expected: string[] };
type SplitQuery = Query & { split: 'calibration' | 'test' };
type Dataset = {
  entities: {
    type: string;
    key: string;
    title: string;
    content: string;
    metadata: Record<string, unknown>;
    lang: 'pt' | 'en';
  }[];
  relations: { from: string; to: string; type: string }[];
  queries: SplitQuery[];
};

const data = JSON.parse(readFileSync('.dogfood/dataset.json', 'utf8')) as Dataset;
// --model=<catalog id>; the provider comes from the environment, as in production (EMBEDDINGS_BASE_URL, EMBEDDINGS_API_KEY).
const MODEL = process.argv.find((a) => a.startsWith('--model='))?.slice('--model='.length) ?? 'embeddinggemma-2:270m';
// --no-latency: skip the timing (e.g. when the machine is busy); quality numbers do not depend on CPU load.
const MEASURE_LATENCY = !process.argv.includes('--no-latency');
// Small sync batches keep each provider call under its 60 s timeout on a slow or busy CPU.
const SYNC_BATCH = 4;
const GROUPS = ['en->en', 'en->pt', 'pt->en', 'pt->pt'];
const KINDS = ['lexical', 'paraphrase', 'exact', 'multihop'];
const GRID: Fusion[] = (['rrf', 'convex'] as const).flatMap((fn) =>
  [0, 0.25, 0.5, 0.75, 1].flatMap((text) => [0, 0.25, 0.5].map((graph) => ({ fn, text, graph }))),
);
const groupOf = (q: Query) => `${q.lang}->${q.targetLang}`;
const label = (f: Fusion) => `${f.fn} texto=${f.text} grafo=${f.graph}`;

/** Loads the dataset into a fresh test space and embeds it; returns the space id and entity key by id. */
async function prepare(config: ReturnType<typeof configFromEnv>) {
  await truncateAll();
  const space = await createSpace({ slug: 'dogfood', name: 'Dogfood', preset: DEVELOPMENT_GRAPH });
  const corpus = {
    entities: data.entities.map((e) => ({ ...e, project: 'dogfood' as const })),
    relations: data.relations,
  };
  const byKey = await loadCorpus(space.id, 'agent:bench', corpus);
  const sync = await syncSpace(config, space.id, SYNC_BATCH);
  if (sync.remaining !== 0) throw new Error(`${sync.remaining} entities left without a vector`);
  return { spaceId: space.id, keyOf: new Map([...byKey].map(([key, e]) => [e.id, key])) };
}

/** Runs the three legs once per query (graph included) and keeps them, with entity keys in place of ids. */
async function collectLegs(config: ReturnType<typeof configFromEnv>, spaceId: string, keyOf: Map<string, string>) {
  const filter = { spaceId, statuses: ['approved' as const, 'draft' as const], types: undefined };
  const toKeys = (list: Scored[]) => list.map((s) => ({ id: keyOf.get(s.id) ?? s.id, score: s.score }));
  const legs = new Map<string, Legs>();
  for (const q of data.queries) {
    const l = await runLegs(config, q.text, filter, { size: legSize(10), graph: true });
    legs.set(q.id, { vector: l.vector && toKeys(l.vector), text: toKeys(l.text), graph: toKeys(l.graph) });
  }
  return legs;
}

type Ranker = (q: Query) => string[];
type Score = { mrr: number; recall: number };

function score(queries: Query[], rank: Ranker, expectedOf: (q: Query) => string[]): Score {
  if (queries.length === 0) return { mrr: Number.NaN, recall: Number.NaN };
  return {
    mrr: mean(queries.map((q) => reciprocalRank(rank(q), expectedOf(q), 10))),
    recall: mean(queries.map((q) => recall(rank(q), expectedOf(q), 5))),
  };
}

function evaluate(queries: Query[], rank: Ranker, fusion: Fusion, expectedOf: (q: Query) => string[]): FusionEval {
  const of = (pick: (q: Query) => boolean) => score(queries.filter(pick), rank, expectedOf).mrr;
  return {
    fusion,
    mrr: of(() => true),
    groups: Object.fromEntries(GROUPS.map((g) => [g, of((q) => groupOf(q) === g)])),
    multihop: of((q) => q.kind === 'multihop'),
  };
}

/** Entity keys whose vector is almost the same as another entity of the same type (cosine >= 0.93): cross-batch twins. */
async function twinsOf(spaceId: string): Promise<Map<string, Set<string>>> {
  const rows = await queryRows<{ key: string; type: string; v: string }>(
    `select e.key, e.type, ee.embedding::text as v from entity_embeddings ee join entities e on e.id = ee.entity_id
      where e.space_id = $1 and ee.model = $2`,
    [spaceId, MODEL],
  );
  const vecs = rows.map((r) => ({ ...r, v: JSON.parse(r.v) as number[] }));
  const twins = new Map<string, Set<string>>();
  for (const [i, a] of vecs.entries()) {
    for (const b of vecs.slice(i + 1)) {
      if (a.type !== b.type || a.v.reduce((s, x, k) => s + x * (b.v[k] ?? 0), 0) < 0.93) continue;
      twins.set(a.key, (twins.get(a.key) ?? new Set()).add(b.key));
      twins.set(b.key, (twins.get(b.key) ?? new Set()).add(a.key));
    }
  }
  return twins;
}

/** Full-search latency (embed, legs, fusion, context) with the production constants, over the test queries. */
async function latency(config: ReturnType<typeof configFromEnv>, spaceId: string, queries: Query[]) {
  await searchSpace(config, spaceId, 'aquecimento', {});
  const ms: number[] = [];
  for (const q of queries) {
    const start = performance.now();
    await searchSpace(config, spaceId, q.text, {});
    ms.push(performance.now() - start);
  }
  return { p50: percentile(ms, 50), p95: percentile(ms, 95) };
}

function row(name: string, queries: Query[], rank: Ranker, expectedOf: (q: Query) => string[]): string {
  const cell = (pick: (q: Query) => boolean) => {
    const s = score(queries.filter(pick), rank, expectedOf);
    return `${s.mrr.toFixed(3)} / ${s.recall.toFixed(2)}`;
  };
  const cells = [cell(() => true), ...GROUPS.map((g) => cell((q) => groupOf(q) === g))];
  return `| ${name} | ${[...cells, ...KINDS.map((k) => cell((q) => q.kind === k))].join(' | ')} |`;
}

/** Test-split tables, once with the exact gold set and once counting near-duplicate twins as hits. */
function printTables(
  test: Query[],
  rows: [string, Ranker][],
  gold: { exact: (q: Query) => string[]; withTwins: (q: Query) => string[] },
): void {
  const header = `| Configuração | todas | ${GROUPS.join(' | ')} | ${KINDS.join(' | ')} |`;
  const rule = `|---|${Array.from({ length: 1 + GROUPS.length + KINDS.length }, () => '---').join('|')}|`;
  for (const [title, expectedOf] of [
    ['Teste (gabarito exato)', gold.exact],
    ['Teste (gêmeos contam como acerto)', gold.withTwins],
  ] as const) {
    console.log(`\n${title}, MRR@10 / recall@5:\n${header}\n${rule}`);
    for (const [name, rank] of rows) console.log(row(name, test, rank, expectedOf));
  }
}

/**
 * A remote provider costs money and receives the dataset texts: print the token estimate and stop unless --yes.
 * Never prints the API key.
 */
function confirmRemote(baseUrl: string): boolean {
  if (/^https?:\/\/(127\.0\.0\.1|localhost)[:/]/.test(baseUrl) || process.argv.includes('--yes')) return true;
  const bytes = (s: string) => Buffer.byteLength(s);
  const entityBytes = data.entities.reduce(
    (n, e) =>
      n +
      bytes(`${e.title}
${e.content}`),
    0,
  );
  const queryBytes = data.queries.reduce((n, q) => n + bytes(q.text), 0) * (MEASURE_LATENCY ? 2 : 1);
  const host = new URL(baseUrl).host;
  console.log(`Provedor remoto (${host}), modelo ${MODEL}: ~${Math.ceil((entityBytes + queryBytes) / 4)} tokens.`);
  console.log('Nada foi enviado. Rode de novo com --yes para seguir.');
  return false;
}

type Shape = 'identifier' | 'short' | 'natural';
type Adaptive = Record<Shape, Fusion>;
const SHAPES: Shape[] = ['identifier', 'short', 'natural'];
const shapeOf = (q: Query) => queryShape(q.text) as Shape;
const adaptiveLabel = (a: Adaptive) => SHAPES.map((s) => `${s}: ${label(a[s])}`).join(' | ');
/** One Fusion standing for an adaptive config in the rule: it uses the graph if any shape does. */
const summary = (a: Adaptive): Fusion => ({ ...a.natural, graph: Math.max(...SHAPES.map((s) => a[s].graph)) });

/**
 * Best grid configuration per query shape on the calibration split (graph-free ones only, if asked). Ties keep the grid
 * order, which starts at vector alone, so an uninformative shape stays conservative.
 */
function calibrateByShape(calibration: Query[], ranked: (f: Fusion) => Ranker, graphFree: boolean): Adaptive {
  const grid = GRID.filter((f) => !graphFree || f.graph === 0);
  const pick = (shape: Shape): Fusion => {
    const queries = calibration.filter((q) => shapeOf(q) === shape);
    if (queries.length === 0) return { fn: 'rrf', text: 0, graph: 0 };
    const evals = grid.map((f) => evaluate(queries, ranked(f), f, (q) => q.expected));
    return (evals.sort((a, b) => b.mrr - a.mrr)[0] as FusionEval).fusion;
  };
  return { identifier: pick('identifier'), short: pick('short'), natural: pick('natural') };
}

/** How the detector splits the gold kinds, so a reader can see whether `identifier` really catches `exact`. */
function printShapes(): void {
  console.log('\nFormato detectado × tipo do gabarito (todas as consultas):');
  for (const shape of SHAPES) {
    const of = data.queries.filter((q) => shapeOf(q) === shape);
    const kinds = KINDS.map((k) => `${k} ${of.filter((q) => q.kind === k).length}`).join(', ');
    console.log(`- ${shape}: ${of.length} (${kinds})`);
  }
}

/** Rankings from the cached legs: one fixed fusion, a per-shape fusion, or a single leg as is. */
function rankers(legs: Map<string, Legs>) {
  const ranked = (fusion: Fusion): Ranker => {
    return (q) => combine(legs.get(q.id) as Legs, fusion).map((s) => s.id);
  };
  const adaptive = (a: Adaptive): Ranker => {
    return (q) => ranked(a[shapeOf(q)])(q);
  };
  const leg = (name: 'vector' | 'text' | 'graph'): Ranker => {
    return (q) => (legs.get(q.id)?.[name] ?? []).map((s) => s.id);
  };
  return { ranked, adaptive, leg };
}

async function main() {
  const config = { ...configFromEnv(), model: MODEL };
  if (!confirmRemote(config.baseUrl)) return;
  const { spaceId, keyOf } = await prepare(config);
  const legs = await collectLegs(config, spaceId, keyOf);
  const twins = await twinsOf(spaceId);
  const calibration = data.queries.filter((q) => q.split === 'calibration');
  const test = data.queries.filter((q) => q.split === 'test');
  const { ranked, adaptive, leg } = rankers(legs);
  const exact = (q: Query) => q.expected;
  const withTwins = (q: Query) => [...new Set(q.expected.flatMap((k) => [k, ...(twins.get(k) ?? [])]))];

  const best = calibrateByShape(calibration, ranked, false);
  const bestNoGraph = calibrateByShape(calibration, ranked, true);
  const vectorOnly: Fusion = { fn: 'rrf', text: 0, graph: 0 };
  const evals = {
    vectorOnly: evaluate(test, ranked(vectorOnly), vectorOnly, exact),
    calibrated: evaluate(test, adaptive(best), summary(best), exact),
    calibratedNoGraph: evaluate(test, adaptive(bestNoGraph), summary(bestNoGraph), exact),
  };
  const timing = MEASURE_LATENCY ? await latency(config, spaceId, test) : { p50: Number.NaN, p95: 0 };
  const decision = chooseFusion(evals, timing.p95);
  const chosen = { [evals.calibrated.mrr]: best, [evals.calibratedNoGraph.mrr]: bestNoGraph };

  console.log(
    `Dataset: ${data.queries.length} consultas (calibração ${calibration.length}, teste ${test.length}); modelo ${MODEL}`,
  );
  printShapes();
  console.log(`
Calibrada por formato: ${adaptiveLabel(best)}
Sem grafo: ${adaptiveLabel(bestNoGraph)}`);
  const rows: [string, Ranker][] = [
    ['só vetor', leg('vector')],
    ['só texto (BM25)', leg('text')],
    ['provisória (constantes atuais)', adaptive(FUSION)],
    ['adaptativa calibrada', adaptive(best)],
    ['adaptativa sem grafo', adaptive(bestNoGraph)],
  ];
  printTables(test, rows, { exact, withTwins });
  console.log(
    MEASURE_LATENCY
      ? `\nBusca inteira (constantes atuais, ${test.length} consultas): p50 ${timing.p50.toFixed(0)} ms, p95 ${timing.p95.toFixed(0)} ms`
      : '\nLatência não medida (--no-latency): a decisão abaixo ainda precisa do corte de 300 ms, medido depois.',
  );
  const picked = decision.chosen === evals.vectorOnly ? 'só vetor' : adaptiveLabel(chosen[decision.chosen.mrr] ?? best);
  const quality = chooseFusion(evals, 0);
  const mrr4 = (e: FusionEval) => e.mrr.toFixed(4);
  console.log(
    `MRR@10 de teste: só vetor ${mrr4(evals.vectorOnly)}, adaptativa ${mrr4(evals.calibrated)}, sem grafo ${mrr4(evals.calibratedNoGraph)}`,
  );
  console.log(
    `Só pela qualidade: ${quality.chosen === evals.vectorOnly ? 'só vetor' : 'adaptativa'} (${quality.reason}).`,
  );
  console.log(`Decisão pela regra: ${picked} (${decision.reason}).`);
}

registerPresets();
try {
  await main();
} finally {
  await truncateAll();
  await pool.end();
}
