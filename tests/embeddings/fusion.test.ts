import { describe, expect, it } from 'vitest';
import { fuse, orQuery } from '../../src/embeddings/fusion.ts';

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

describe('orQuery', () => {
  it('joins the lowercased words with OR, once each', () => {
    expect(orQuery('Como faturar boletos? como')).toBe('como | faturar | boletos');
  });

  it('keeps accented letters and digits', () => {
    expect(orQuery('Faturação em 2026')).toBe('faturação | em | 2026');
  });

  it('drops tsquery operators and quotes, so user text cannot change the query', () => {
    expect(orQuery("foo & !bar | (baz) <-> 'qux':*")).toBe('foo | bar | baz | qux');
  });

  it('gives undefined for a query with symbols only', () => {
    expect(orQuery('¿?! -- && ||')).toBeUndefined();
  });
});
