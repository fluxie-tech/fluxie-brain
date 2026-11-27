import { readFileSync } from 'node:fs';
import type { Entity } from '../../../src/core-graph/index.ts';
import { type Corpus, loadCorpus } from '../development-graph/load.ts';

/** One benchmark query: `expected` holds the keys a good search returns (corpus or distractors). */
export type BenchQuery = {
  id: string;
  lang: 'pt' | 'en';
  targetLang: 'pt' | 'en';
  /** lexical: shares words with the target; paraphrase: shares no content word with the expected titles. */
  kind: 'lexical' | 'paraphrase';
  text: string;
  expected: string[];
};

const read = (file: string) => JSON.parse(readFileSync(new URL(file, import.meta.url), 'utf8'));

export const distractors = read('./distractors.json') as Corpus;
export const queries = read('./queries.json') as BenchQuery[];

/** Loads the presets corpus and then the distractors (whose relations point into the corpus). */
export async function loadBenchmarkData(spaceId: string): Promise<Map<string, Entity>> {
  return loadCorpus(spaceId, 'agent:bench', distractors, await loadCorpus(spaceId, 'agent:bench'));
}
