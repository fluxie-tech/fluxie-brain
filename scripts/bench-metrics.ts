// Retrieval and latency metrics for scripts/bench-embeddings.ts, kept apart so they are unit-tested.

/** True only when the provider's real host (not text in its userinfo or path) is this machine. */
export function isLocalProvider(baseUrl: string): boolean {
  const host = URL.parse(baseUrl)?.hostname;
  return host === '127.0.0.1' || host === 'localhost' || host === '[::1]';
}

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

/** One fusion configuration measured on the test split: MRR@10 overall, per language group and on multihop queries. */
export type FusionEval = {
  fusion: { fn: 'rrf' | 'convex'; text: number; graph: number };
  mrr: number;
  groups: Record<string, number>;
  multihop: number;
};

const MARGIN = 0.02;

/**
 * The Emenda 1 rule, on the test split (SPEC-embeddings.md):
 * - the graph leg stays only if it lifts multihop MRR by MARGIN without lowering the total (else the best graph-free
 *   configuration is the candidate);
 * - the candidate fusion enters only if it beats vector alone by MARGIN and no language group drops by more than MARGIN;
 * - if the full search p95 is above `maxP95` ms, vector alone is used.
 */
export function chooseFusion(
  runs: { vectorOnly: FusionEval; calibrated: FusionEval; calibratedNoGraph: FusionEval },
  p95: number,
  maxP95 = 300,
): { chosen: FusionEval; reason: string } {
  const { vectorOnly, calibrated, calibratedNoGraph } = runs;
  if (p95 > maxP95) return { chosen: vectorOnly, reason: `search p95 ${p95.toFixed(0)} ms above ${maxP95} ms` };
  const graphHelps =
    calibrated.multihop - calibratedNoGraph.multihop >= MARGIN && calibrated.mrr >= calibratedNoGraph.mrr;
  const candidate = calibrated.fusion.graph > 0 && !graphHelps ? calibratedNoGraph : calibrated;
  const graphNote = candidate === calibratedNoGraph && calibrated.fusion.graph > 0 ? 'graph leg dropped; ' : '';
  const drops = Object.keys(vectorOnly.groups).filter(
    (g) => (vectorOnly.groups[g] ?? 0) - (candidate.groups[g] ?? 0) > MARGIN,
  );
  if (candidate.mrr - vectorOnly.mrr < MARGIN) {
    return { chosen: vectorOnly, reason: `${graphNote}fusion gains less than ${MARGIN} MRR over vector alone` };
  }
  if (drops.length > 0) return { chosen: vectorOnly, reason: `${graphNote}fusion drops group(s) ${drops.join(', ')}` };
  return { chosen: candidate, reason: `${graphNote}fusion beats vector alone by at least ${MARGIN}` };
}

function requireExpected(expected: string[]): void {
  // A query without expected keys would silently count as a miss and drag the average down.
  if (expected.length === 0) throw new RangeError('a query needs at least one expected key');
}
