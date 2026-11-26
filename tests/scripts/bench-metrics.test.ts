import { describe, expect, it } from 'vitest';
import { chooseModel, mean, percentile, recall, reciprocalRank } from '../../scripts/bench-metrics.ts';

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

  describe('chooseModel (the spec rule)', () => {
    const run = (model: string, hybridMrr: number, p50: number, p95 = p50 * 1.2) => ({ model, hybridMrr, p50, p95 });

    it('picks the highest hybrid MRR when the gap is at least 0.02', () => {
      expect(chooseModel([run('slow', 0.8, 200), run('fast', 0.7, 90)]).winner).toBe('slow');
    });

    it('picks the faster model when the gap is below 0.02, in either order', () => {
      expect(chooseModel([run('slow', 0.81, 200), run('fast', 0.8, 90)]).winner).toBe('fast');
      expect(chooseModel([run('fast', 0.81, 90), run('slow', 0.8, 200)]).winner).toBe('fast');
    });

    it('excludes a model with p95 above 300 ms, and reports when none is left', () => {
      expect(chooseModel([run('heavy', 0.95, 250, 301), run('light', 0.6, 90)]).winner).toBe('light');
      expect(chooseModel([run('heavy', 0.95, 250, 301)])).toEqual({
        winner: undefined,
        reason: 'every model has p95 above 300 ms',
      });
    });
  });

  it('refuses empty lists and out-of-range percentiles', () => {
    expect(() => mean([])).toThrow(RangeError);
    expect(() => percentile([], 50)).toThrow(RangeError);
    expect(() => percentile([1], 101)).toThrow(RangeError);
  });
});
