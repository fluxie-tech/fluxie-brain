import { describe, expect, it } from 'vitest';
import { mean, percentile, recall, reciprocalRank } from '../../scripts/bench-metrics.ts';

describe('bench metrics', () => {
  it('reciprocal rank uses the first expected key within the top k', () => {
    expect(reciprocalRank(['a', 'b', 'c'], ['c'])).toBeCloseTo(1 / 3, 12);
    expect(reciprocalRank(['a', 'b', 'c'], ['b', 'c'])).toBe(0.5);
    expect(reciprocalRank(['a', 'b', 'c'], ['c'], 2)).toBe(0);
    expect(reciprocalRank(['a'], ['z'])).toBe(0);
    expect(reciprocalRank([], ['a'])).toBe(0);
  });

  it('recall counts the expected keys inside the top k', () => {
    expect(recall(['a', 'b', 'c'], ['a', 'c'])).toBe(1);
    expect(recall(['a', 'b', 'c'], ['a', 'c'], 2)).toBe(0.5);
    expect(recall([], ['a'])).toBe(0);
  });

  it('refuses a query without expected keys', () => {
    expect(() => reciprocalRank(['a'], [])).toThrow(RangeError);
    expect(() => recall(['a'], [])).toThrow(RangeError);
  });

  it('computes the mean and nearest-rank percentiles', () => {
    expect(mean([1, 2, 3, 6])).toBe(3);
    const ms = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
    expect(percentile(ms, 50)).toBe(50);
    expect(percentile(ms, 95)).toBe(100);
    expect(percentile([5, 1, 3], 0)).toBe(1);
    expect(percentile([7], 95)).toBe(7);
  });

  it('refuses empty lists and out-of-range percentiles', () => {
    expect(() => mean([])).toThrow(RangeError);
    expect(() => percentile([], 50)).toThrow(RangeError);
    expect(() => percentile([1], 101)).toThrow(RangeError);
  });
});
