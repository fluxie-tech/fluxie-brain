import { describe, expect, it } from 'vitest';
import { fuse, queryWords } from '../../src/embeddings/fusion.ts';

describe('fuse', () => {
  it('sums 1/(k + rank) over the lists and orders by score', () => {
    expect(
      fuse([
        ['a', 'b'],
        ['b', 'c'],
      ]),
    ).toEqual([
      { id: 'b', score: 1 / 61 + 1 / 62 },
      { id: 'a', score: 1 / 61 },
      { id: 'c', score: 1 / 62 },
    ]);
  });

  it('breaks ties by id, so the output is deterministic', () => {
    expect(fuse([['b'], ['a']]).map((f) => f.id)).toEqual(['a', 'b']);
  });

  it('works when one list is empty, and with a custom k', () => {
    expect(fuse([[], ['x', 'y']])).toEqual([
      { id: 'x', score: 1 / 61 },
      { id: 'y', score: 1 / 62 },
    ]);
    expect(fuse([['x']], 0)).toEqual([{ id: 'x', score: 1 }]);
    expect(fuse([[], []])).toEqual([]);
  });
});

describe('queryWords', () => {
  it('lowercases and keeps each word once', () => {
    expect(queryWords('Como faturar boletos? como')).toEqual(['como', 'faturar', 'boletos']);
  });

  it('keeps accented letters and digits', () => {
    expect(queryWords('Faturação em 2026')).toEqual(['faturação', 'em', '2026']);
  });

  it('drops query operators and quotes, so user text cannot change the query', () => {
    expect(queryWords("foo & !bar | (baz) <-> 'qux':*")).toEqual(['foo', 'bar', 'baz', 'qux']);
  });

  it('gives no words for a query with symbols only', () => {
    expect(queryWords('¿?! -- && ||')).toEqual([]);
  });
});
