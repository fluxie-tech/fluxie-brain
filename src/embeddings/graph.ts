import { and, eq, inArray } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { db, type EntityStatus, entities, relations } from '../core-graph/index.ts';

export type Seed = { id: string; weight: number };
type Edge = readonly [string, string];

// 0.5, not the web-search 0.85: at 0.85 the walk drifts to hubs (repo, shared dependencies) and they outrank the
// seeds and their direct neighbours, which is the opposite of what a retrieval leg needs (graph.test.ts).
const DAMPING = 0.5;
const ITERATIONS = 20;

/** Undirected adjacency: every edge counts in both directions; self-loops are ignored. */
function adjacency(edges: Edge[]): Map<string, string[]> {
  const neighbors = new Map<string, string[]>();
  const link = (a: string, b: string) => {
    const list = neighbors.get(a);
    if (list) list.push(b);
    else neighbors.set(a, [b]);
  };
  for (const [a, b] of edges) {
    if (a === b) continue;
    link(a, b);
    link(b, a);
  }
  return neighbors;
}

/** One walk step: follow an edge with probability `damping`; the rest, and mass on dead ends, restarts at the seeds. */
function step(
  rank: Map<string, number>,
  neighbors: Map<string, string[]>,
  restart: Map<string, number>,
  damping: number,
): Map<string, number> {
  const next = new Map<string, number>();
  let restarting = 0;
  for (const [node, mass] of rank) {
    const out = neighbors.get(node);
    if (!out) {
      restarting += mass;
      continue;
    }
    for (const n of out) next.set(n, (next.get(n) ?? 0) + (damping * mass) / out.length);
    restarting += (1 - damping) * mass;
  }
  for (const [node, share] of restart) next.set(node, (next.get(node) ?? 0) + restarting * share);
  return next;
}

/**
 * Personalized PageRank (as in HippoRAG): a random walk that follows an edge with probability `damping` and jumps
 * back to a seed otherwise, seeds picked in proportion to their weight. Edges count in both directions, all with the
 * same weight. The scores keep summing to 1.
 */
export function personalizedPageRank(edges: Edge[], seeds: Seed[], damping = DAMPING, iterations = ITERATIONS) {
  const total = seeds.reduce((sum, s) => sum + Math.max(s.weight, 0), 0);
  if (total <= 0) return new Map<string, number>();
  const restart = new Map(seeds.map((s) => [s.id, Math.max(s.weight, 0) / total]));
  const neighbors = adjacency(edges);
  let rank = new Map(restart);
  for (let i = 0; i < iterations; i++) rank = step(rank, neighbors, restart, damping);
  return rank;
}

/** Which relations the walk may use: both ends in the space, with an allowed status and, if given, in scope. */
export type GraphFilter = { spaceId: string; statuses: EntityStatus[]; ids?: string[] | undefined };

// shortcut: reads every relation of the space (in scope) per query; fine for spaces up to tens of thousands of
// relations, move the walk into SQL if a space ever gets bigger than that.
async function edgesOf(filter: GraphFilter): Promise<Edge[]> {
  const from = alias(entities, 'from_entity');
  const to = alias(entities, 'to_entity');
  const endOk = (e: typeof from | typeof to) =>
    and(
      eq(e.spaceId, filter.spaceId),
      inArray(e.status, filter.statuses),
      filter.ids ? inArray(e.id, filter.ids) : undefined,
    );
  const rows = await db
    .select({ from: relations.fromId, to: relations.toId })
    .from(relations)
    .innerJoin(from, eq(from.id, relations.fromId))
    .innerJoin(to, eq(to.id, relations.toId))
    .where(and(endOk(from), endOk(to)));
  return rows.map((r) => [r.from, r.to] as const);
}

/**
 * Ids ranked by Personalized PageRank from the seeds (the best vector hits), at most `limit`, best first, ties by id.
 * Only the seeds and what the walk reaches over allowed relations can appear.
 */
export async function graphLeg(seeds: Seed[], filter: GraphFilter, limit: number): Promise<string[]> {
  if (seeds.length === 0) return [];
  const rank = personalizedPageRank(await edgesOf(filter), seeds);
  return [...rank]
    .filter(([, score]) => score > 0)
    .sort(([a, x], [b, y]) => y - x || (a < b ? -1 : 1))
    .slice(0, limit)
    .map(([id]) => id);
}
