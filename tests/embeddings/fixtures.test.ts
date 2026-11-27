import { beforeAll, describe, expect, it } from 'vitest';
import { createSpace } from '../../src/core-graph/index.ts';
import { DEVELOPMENT_GRAPH, registerPresets } from '../../src/presets/index.ts';
import { corpus } from '../fixtures/development-graph/load.ts';
import { distractors, loadBenchmarkData, queries } from '../fixtures/embeddings/load.ts';
import { queryRows, truncateAll } from '../setup/db.ts';

const all = [...corpus.entities, ...distractors.entities];
const titleOf = new Map(all.map((e) => [e.key, e.title]));
/** Content words: lowercased runs of letters/digits longer than 3 characters. */
const words = (text: string) =>
  new Set((text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter((w) => w.length > 3));

describe('embeddings benchmark fixtures', () => {
  it('has 30–40 distractors with keys that do not clash with the corpus', () => {
    expect(distractors.entities.length).toBeGreaterThanOrEqual(30);
    expect(distractors.entities.length).toBeLessThanOrEqual(40);
    expect(new Set(all.map((e) => e.key)).size).toBe(all.length);
  });

  it('has unique query ids, at least 8 queries per language group and only known expected keys', () => {
    expect(new Set(queries.map((q) => q.id)).size).toBe(queries.length);
    const groups = Map.groupBy(queries, (q) => `${q.lang}->${q.targetLang}`);
    expect([...groups.keys()].sort()).toEqual(['en->en', 'en->pt', 'pt->en', 'pt->pt']);
    for (const group of groups.values()) expect(group.length).toBeGreaterThanOrEqual(8);
    for (const q of queries) {
      expect(q.expected.length).toBeGreaterThan(0);
      for (const key of q.expected) expect(titleOf.has(key), `${q.id}: ${key}`).toBe(true);
    }
  });

  it('keeps every paraphrase free of content words from its expected titles', () => {
    for (const q of queries.filter((x) => x.kind === 'paraphrase')) {
      const query = words(q.text);
      const shared = q.expected.flatMap((key) => [...words(titleOf.get(key) ?? '')].filter((w) => query.has(w)));
      expect(shared, q.id).toEqual([]);
    }
  });

  it('targets the language each query says', () => {
    const langOf = new Map(all.map((e) => [e.key, e.lang]));
    for (const q of queries) for (const key of q.expected) expect(langOf.get(key), q.id).toBe(q.targetLang);
  });

  describe('loaded through core-graph with the Development Graph preset', () => {
    beforeAll(() => registerPresets());

    it('stores the corpus and every distractor with its relations', async () => {
      await truncateAll();
      const space = await createSpace({ slug: 'bench', name: 'Bench', preset: DEVELOPMENT_GRAPH });
      const byKey = await loadBenchmarkData(space.id);
      expect(byKey.size).toBe(all.length);
      const relations = corpus.relations.length + distractors.relations.length;
      expect(await queryRows('select id from relations')).toHaveLength(relations);
    }, 30_000);
  });
});
