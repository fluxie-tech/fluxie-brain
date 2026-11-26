// Turns the extraction agents' JSON into a validated benchmark dataset (SPEC-embeddings.md, Emenda 1). Pure: no DB.
import { z } from 'zod';
import { developmentGraph } from '../src/presets/development-graph/index.ts';

const { entityTypes, relationTypes } = developmentGraph.ontology;

const lang = z.enum(['pt', 'en']);
const entitySchema = z.object({
  type: z.string(),
  key: z.string().min(3),
  title: z.string().min(1),
  content: z.string().min(1),
  metadata: z.record(z.string(), z.unknown()).default({}),
  lang,
  source: z.string().optional(),
});
const relationSchema = z.object({ from: z.string(), to: z.string(), type: z.string() });
const querySchema = z.object({
  lang,
  targetLang: lang,
  kind: z.enum(['lexical', 'paraphrase', 'exact', 'multihop']),
  text: z.string().min(1).max(2000),
  expected: z.array(z.string()).min(1),
});

export type DogEntity = z.infer<typeof entitySchema>;
export type DogRelation = z.infer<typeof relationSchema>;
export type DogQuery = z.infer<typeof querySchema>;
export type ExtractionFile = { entities?: unknown[]; relations?: unknown[]; queries?: unknown[] };

export type Dropped = Record<
  'entity' | 'duplicateKey' | 'relation' | 'query' | 'unknownExpected' | 'paraphraseOverlap' | 'exactMissing',
  number
>;

/** Content words: lowercased runs of letters/digits longer than 3 characters (the fixture rule). */
export const contentWords = (text: string) =>
  new Set((text.toLowerCase().match(/[\p{L}\p{M}\p{N}]+/gu) ?? []).filter((w) => w.length > 3));

/** True when the entity has a preset type and metadata that the type's schema accepts. */
export function fitsPreset(e: DogEntity): boolean {
  const def = entityTypes[e.type as keyof typeof entityTypes];
  return def?.metadata.safeParse(e.metadata).success ?? false;
}

function fitsRelation(r: DogRelation, typeOf: Map<string, string>): boolean {
  const def = relationTypes[r.type as keyof typeof relationTypes];
  const from = typeOf.get(r.from);
  const to = typeOf.get(r.to);
  return def !== undefined && from !== undefined && to !== undefined && def.from.includes(from) && def.to.includes(to);
}

function parseAll<T>(items: unknown[] | undefined, schema: z.ZodType<T>, onBad: () => void): T[] {
  return (items ?? []).flatMap((item) => {
    const parsed = schema.safeParse(item);
    if (parsed.success) return [parsed.data];
    onBad();
    return [];
  });
}

/** Checks a query against its expected entities; returns the drop reason, or undefined when it is kept. */
function queryProblem(q: DogQuery, byKey: Map<string, DogEntity>): keyof Dropped | undefined {
  const targets = q.expected.map((k) => byKey.get(k));
  if (targets.some((t) => t === undefined)) return 'unknownExpected';
  const known = targets as DogEntity[];
  if (q.kind === 'paraphrase' || q.kind === 'multihop') {
    const words = contentWords(q.text);
    if (known.some((t) => [...contentWords(t.title)].some((w) => words.has(w)))) return 'paraphraseOverlap';
  }
  if (q.kind === 'exact') {
    const needle = q.text.trim().toLowerCase();
    if (!known.some((t) => `${t.title}\n${t.content}`.toLowerCase().includes(needle))) return 'exactMissing';
  }
  return undefined;
}

/**
 * Merges anchors and batch files: drops entities that do not fit the preset, keeps the first of duplicate keys,
 * drops relations with unknown ends or disallowed endpoint types, and queries that break the gold-set rules.
 * targetLang is recomputed from the first expected entity, so a wrong label cannot skew the language groups.
 */
export function buildDataset(files: ExtractionFile[]) {
  const dropped: Dropped = {
    entity: 0,
    duplicateKey: 0,
    relation: 0,
    query: 0,
    unknownExpected: 0,
    paraphraseOverlap: 0,
    exactMissing: 0,
  };
  const byKey = new Map<string, DogEntity>();
  for (const e of files.flatMap((f) => parseAll(f.entities, entitySchema, () => dropped.entity++))) {
    if (!fitsPreset(e)) dropped.entity++;
    else if (byKey.has(e.key)) dropped.duplicateKey++;
    else byKey.set(e.key, e);
  }
  const typeOf = new Map([...byKey].map(([k, e]) => [k, e.type]));
  const seen = new Set<string>();
  const relations = files
    .flatMap((f) => parseAll(f.relations, relationSchema, () => dropped.relation++))
    .filter((r) => {
      const id = `${r.from} ${r.type} ${r.to}`;
      const ok = r.from !== r.to && !seen.has(id) && fitsRelation(r, typeOf);
      if (!ok) dropped.relation++;
      seen.add(id);
      return ok;
    });
  const queries = files
    .flatMap((f) => parseAll(f.queries, querySchema, () => dropped.query++))
    .flatMap((q) => {
      const problem = queryProblem(q, byKey);
      if (problem) {
        dropped[problem]++;
        return [];
      }
      return [{ ...q, targetLang: byKey.get(q.expected[0] ?? '')?.lang ?? q.targetLang }];
    });
  return { entities: [...byKey.values()], relations, queries, dropped };
}

/** Deterministic PRNG (mulberry32) so the split is reproducible from its seed. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export type Split = 'calibration' | 'test';

/** 50/50 split stratified by language group and kind: each stratum is shuffled and alternated. */
export function splitQueries<T extends DogQuery>(queries: T[], seed = 20261126): (T & { split: Split })[] {
  const random = rng(seed);
  const strata = Map.groupBy(queries, (q) => `${q.lang}->${q.targetLang}|${q.kind}`);
  const out: (T & { split: Split })[] = [];
  for (const key of [...strata.keys()].sort()) {
    const items = [...(strata.get(key) ?? [])];
    for (let i = items.length - 1; i > 0; i--) {
      const j = Math.floor(random() * (i + 1));
      [items[i], items[j]] = [items[j] as T, items[i] as T];
    }
    items.forEach((q, i) => {
      out.push({ ...q, split: i % 2 === 0 ? 'calibration' : 'test' });
    });
  }
  return out;
}
