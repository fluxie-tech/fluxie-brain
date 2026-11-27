import { describe, expect, it } from 'vitest';
import { buildDataset, splitQueries } from '../../scripts/dogfood-dataset.ts';

const repo = {
  type: 'repo',
  key: 'repo:acme/app',
  title: 'App',
  content: 'The app.',
  metadata: { host: 'github' },
  lang: 'en',
};
const component = {
  type: 'component',
  key: 'component:acme/app/queue',
  title: 'Fila de mensagens',
  content: 'Processa jobs.',
  metadata: { criticality: 'high' },
  lang: 'pt',
};
const learning = {
  type: 'learning',
  key: 'learning:retry-after',
  title: 'Retry after maior que timeout',
  content: 'Ajustar QUEUE_RETRY_AFTER acima do timeout do job.',
  metadata: { kind: 'gotcha' },
  lang: 'pt',
};
const anchors = { entities: [repo, component], relations: [{ from: component.key, to: repo.key, type: 'part_of' }] };

describe('buildDataset', () => {
  it('keeps valid items and counts every kind of drop', () => {
    const batch = {
      entities: [
        learning,
        { ...learning, title: 'Duplicate' },
        { ...learning, key: 'learning:bad-kind', metadata: { kind: 'rumor' } },
        { ...learning, key: 'x:unknown-type', type: 'note' },
        { key: 'missing:fields' },
      ],
      relations: [
        { from: learning.key, to: component.key, type: 'about' },
        { from: learning.key, to: component.key, type: 'about' },
        { from: learning.key, to: 'component:acme/app/ghost', type: 'about' },
        { from: component.key, to: learning.key, type: 'about' },
      ],
      queries: [
        { lang: 'en', targetLang: 'en', kind: 'lexical', text: 'retry after timeout', expected: [learning.key] },
        { lang: 'en', targetLang: 'pt', kind: 'paraphrase', text: 'jobs running twice', expected: [learning.key] },
        { lang: 'pt', targetLang: 'pt', kind: 'paraphrase', text: 'timeout do job', expected: [learning.key] },
        { lang: 'en', targetLang: 'pt', kind: 'exact', text: 'QUEUE_RETRY_AFTER', expected: [learning.key] },
        { lang: 'en', targetLang: 'pt', kind: 'exact', text: 'QUEUE_TIMEOUT', expected: [learning.key] },
        { lang: 'pt', targetLang: 'pt', kind: 'lexical', text: 'nada', expected: ['learning:ghost'] },
        { lang: 'xx', kind: 'lexical', text: 'bad', expected: [] },
      ],
    };
    const { entities, relations, queries, dropped } = buildDataset([anchors, batch]);
    expect(entities.map((e) => e.key)).toEqual([repo.key, component.key, learning.key]);
    expect(relations).toEqual([anchors.relations[0], batch.relations[0]]);
    expect(queries.map((q) => q.text)).toEqual(['retry after timeout', 'jobs running twice', 'QUEUE_RETRY_AFTER']);
    expect(dropped).toEqual({
      entity: 3,
      duplicateKey: 1,
      relation: 3,
      query: 1,
      unknownExpected: 1,
      paraphraseOverlap: 1,
      exactMissing: 1,
    });
  });

  it('recomputes targetLang from the expected entity', () => {
    const batch = {
      entities: [learning],
      queries: [{ lang: 'en', targetLang: 'en', kind: 'lexical', text: 'retry', expected: [learning.key] }],
    };
    expect(buildDataset([batch]).queries[0]?.targetLang).toBe('pt');
  });
});

describe('splitQueries', () => {
  const queries = Array.from({ length: 40 }, (_, i) => ({
    lang: i % 2 ? ('pt' as const) : ('en' as const),
    targetLang: 'pt' as const,
    kind: i % 4 < 2 ? ('lexical' as const) : ('paraphrase' as const),
    text: `q${i}`,
    expected: ['k'],
  }));

  it('is deterministic for a seed and changes with another seed', () => {
    const a = splitQueries(queries).map((q) => `${q.text}:${q.split}`);
    expect(splitQueries(queries).map((q) => `${q.text}:${q.split}`)).toEqual(a);
    expect(splitQueries(queries, 7).map((q) => `${q.text}:${q.split}`)).not.toEqual(a);
  });

  it('splits every stratum in half and keeps every query once', () => {
    const split = splitQueries(queries);
    expect(split.map((q) => q.text).sort()).toEqual(queries.map((q) => q.text).sort());
    const strata = Map.groupBy(split, (q) => `${q.lang}|${q.kind}`);
    for (const items of strata.values()) {
      expect(items.filter((q) => q.split === 'calibration')).toHaveLength(items.length / 2);
    }
  });
});
