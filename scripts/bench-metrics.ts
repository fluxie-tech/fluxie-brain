// Retrieval and latency metrics for scripts/bench-embeddings.ts, kept apart so they are unit-tested.

/** 1/rank of the first expected key within the top k, or 0 when none is there. */
export function reciprocalRank(ranked: string[], expected: string[], k = 10): number {
  requireExpected(expected);
  const i = ranked.slice(0, k).findIndex((key) => expected.includes(key));
  return i < 0 ? 0 : 1 / (i + 1);
}

/** Share of the expected keys that appear in the top k. */
export function recall(ranked: string[], expected: string[], k = 5): number {
  requireExpected(expected);
  const top = new Set(ranked.slice(0, k));
  return expected.filter((key) => top.has(key)).length / expected.length;
}

export function mean(values: number[]): number {
  if (values.length === 0) throw new RangeError('mean of an empty list');
  return values.reduce((a, b) => a + b, 0) / values.length;
}

/** Nearest-rank percentile (p in 0–100): the smallest value with at least p% of the values at or below it. */
export function percentile(values: number[], p: number): number {
  if (values.length === 0) throw new RangeError('percentile of an empty list');
  if (p < 0 || p > 100) throw new RangeError(`percentile must be between 0 and 100, got ${p}`);
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)] ?? Number.NaN;
}

export type ModelRun = { model: string; hybridMrr: number; p50: number; p95: number };

/**
 * The SPEC-embeddings.md rule: a model with CPU p95 above `maxP95` ms is out; the highest hybrid MRR@10 wins;
 * if the runner-up is within `tie`, the faster one (lower p50) wins instead.
 */
export function chooseModel(
  runs: ModelRun[],
  maxP95 = 300,
  tie = 0.02,
): { winner: string | undefined; reason: string } {
  const eligible = runs.filter((r) => r.p95 <= maxP95).sort((a, b) => b.hybridMrr - a.hybridMrr);
  const [best, second] = eligible;
  if (!best) return { winner: undefined, reason: `every model has p95 above ${maxP95} ms` };
  if (second && best.hybridMrr - second.hybridMrr < tie) {
    const faster = second.p50 < best.p50 ? second : best;
    return { winner: faster.model, reason: `MRR gap below ${tie}: the faster model on CPU (p50) wins` };
  }
  return { winner: best.model, reason: 'highest hybrid MRR@10' };
}

function requireExpected(expected: string[]): void {
  // A query without expected keys would silently count as a miss and drag the average down.
  if (expected.length === 0) throw new RangeError('a query needs at least one expected key');
}
