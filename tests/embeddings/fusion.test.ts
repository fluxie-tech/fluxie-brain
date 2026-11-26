import { describe, expect, it } from 'vitest';
import { combine, convex, fuse, queryWords } from '../../src/embeddings/fusion.ts';

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

describe('fuse with weights', () => {
  it('scales each list by its weight and leaves out lists with weight 0', () => {
    expect(fuse([['a'], ['b']], 60, [1, 2]).map((f) => f.id)).toEqual(['b', 'a']);
    expect(fuse([['a'], ['b']], 60, [1, 0])).toEqual([{ id: 'a', score: 1 / 61 }]);
  });
});

describe('convex', () => {
  const s = (id: string, score: number) => ({ id, score });

  it('normalizes each list to [0, 1] and sums the weighted values', () => {
    const fused = convex(
      [
        [s('a', 0.9), s('b', 0.5), s('c', 0.1)],
        [s('c', 30), s('b', 10)],
      ],
      [1, 0.5],
    );
    expect(fused.map((f) => f.id)).toEqual(['a', 'b', 'c']);
    expect(fused[0]?.score).toBeCloseTo(1, 12);
    expect(fused[1]?.score).toBeCloseTo(0.5, 12);
    expect(fused[2]?.score).toBeCloseTo(0.5, 12);
  });

  it('counts all-equal scores as 1, skips empty lists and weight 0, and breaks ties by id', () => {
    expect(convex([[s('b', 3), s('a', 3)], []], [1, 1])).toEqual([s('a', 1), s('b', 1)]);
    expect(convex([[s('a', 1)], [s('z', 9)]], [1, 0])).toEqual([s('a', 1)]);
  });
});

describe('combine', () => {
  const s = (id: string, score: number) => ({ id, score });
  const legs = { vector: [s('v', 0.9), s('both', 0.8)], text: [s('both', 5), s('t', 2)], graph: [s('g', 0.4)] };

  it('applies the fusion function and weights, with the vector leg at weight 1', () => {
    expect(combine(legs, { fn: 'rrf', text: 0, graph: 0 }).map((f) => f.id)).toEqual(['v', 'both']);
    expect(combine(legs, { fn: 'rrf', text: 1, graph: 1 })[0]?.id).toBe('both');
    expect(combine(legs, { fn: 'convex', text: 1, graph: 0.5 }).map((f) => f.id)).toEqual(['both', 'v', 'g', 't']);
  });

  it('falls back to the text leg alone, at full weight, when there is no vector leg', () => {
    const down = { vector: undefined, text: legs.text, graph: legs.graph };
    expect(combine(down, { fn: 'rrf', text: 0, graph: 1 }).map((f) => f.id)).toEqual(['both', 't']);
    expect(combine(down, { fn: 'convex', text: 0.25, graph: 1 }).map((f) => f.id)).toEqual(['both', 't']);
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
