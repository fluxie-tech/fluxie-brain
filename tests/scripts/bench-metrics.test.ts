import { describe, expect, it } from 'vitest';
import {
  chooseFusion,
  chooseModel,
  isLocalProvider,
  mean,
  percentile,
  recall,
  reciprocalRank,
} from '../../scripts/bench-metrics.ts';

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

  describe('chooseFusion (the Emenda 1 rule)', () => {
    const groups = (v: number) => ({ 'en->en': v, 'pt->pt': v });
    const run = (
      text: number,
      graph: number,
      mrr: number,
      more: { multihop?: number; g?: Record<string, number> } = {},
    ) => ({
      fusion: { fn: 'rrf' as const, text, graph },
      mrr,
      groups: more.g ?? groups(mrr),
      multihop: more.multihop ?? mrr,
    });
    const vectorOnly = run(0, 0, 0.7, { multihop: 0.5 });

    it('keeps the calibrated fusion when it beats vector alone by 0.02 and the graph helps multihop', () => {
      const calibrated = run(0.5, 0.25, 0.75, { multihop: 0.6 });
      const calibratedNoGraph = run(0.5, 0, 0.74, { multihop: 0.55 });
      const { chosen } = chooseFusion({ vectorOnly, calibrated, calibratedNoGraph }, 150);
      expect(chosen).toBe(calibrated);
    });

    it('drops the graph leg when it does not lift multihop by 0.02', () => {
      const calibrated = run(0.5, 0.25, 0.75, { multihop: 0.51 });
      const calibratedNoGraph = run(0.5, 0, 0.74, { multihop: 0.5 });
      const { chosen, reason } = chooseFusion({ vectorOnly, calibrated, calibratedNoGraph }, 150);
      expect(chosen).toBe(calibratedNoGraph);
      expect(reason).toMatch(/graph leg dropped/);
    });

    it('falls back to vector alone on a small gain, a group drop or a slow search', () => {
      const small = run(0.5, 0, 0.715);
      expect(chooseFusion({ vectorOnly, calibrated: small, calibratedNoGraph: small }, 150).chosen).toBe(vectorOnly);
      const dropsPt = run(0.5, 0, 0.8, { g: { 'en->en': 0.9, 'pt->pt': 0.67 } });
      const result = chooseFusion({ vectorOnly, calibrated: dropsPt, calibratedNoGraph: dropsPt }, 150);
      expect(result).toEqual({ chosen: vectorOnly, reason: 'fusion drops group(s) pt->pt' });
      const good = run(0.5, 0, 0.8);
      expect(chooseFusion({ vectorOnly, calibrated: good, calibratedNoGraph: good }, 301).chosen).toBe(vectorOnly);
    });
  });

  it('refuses empty lists and out-of-range percentiles', () => {
    expect(() => mean([])).toThrow(RangeError);
    expect(() => percentile([], 50)).toThrow(RangeError);
    expect(() => percentile([1], 101)).toThrow(RangeError);
  });

  it('decides local or remote by the real hostname, not by text in the URL', () => {
    for (const url of ['http://127.0.0.1:11434/v1', 'http://localhost/v1', 'http://[::1]:11434/v1']) {
      expect(isLocalProvider(url), url).toBe(true);
    }
    for (const url of ['http://localhost:1@host-remoto/v1', 'https://openrouter.ai/localhost/', 'nonsense']) {
      expect(isLocalProvider(url), url).toBe(false);
    }
  });
});
