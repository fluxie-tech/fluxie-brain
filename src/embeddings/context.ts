import { type EntityStatus, type GraphSlice, neighbors, type Relation } from '../core-graph/index.ts';

type Neighbor = GraphSlice['entities'][number];

/**
 * Neighbors of the hits up to `depth` (core-graph `neighbors`), each once at its shortest depth, never a hit itself,
 * only with the requested statuses and, with an anchor, only inside its scope. Relations are kept only when both
 * ends are in the result (hits or context), so nothing outside the scope leaks through an edge.
 */
export async function contextOf(
  spaceId: string,
  hitIds: string[],
  depth: 0 | 1 | 2,
  filter: { statuses: EntityStatus[]; ids?: string[] | undefined },
): Promise<GraphSlice> {
  if (depth === 0 || hitIds.length === 0) return { entities: [], relations: [] };
  const hits = new Set(hitIds);
  const scope = filter.ids ? new Set(filter.ids) : undefined;
  const slices = await Promise.all(hitIds.map((id) => neighbors(spaceId, id, depth, { statuses: filter.statuses })));
  const nearest = new Map<string, Neighbor>();
  const edges = new Map<string, Relation>();
  for (const slice of slices) {
    for (const e of slice.entities) {
      const keep = !hits.has(e.id) && (scope?.has(e.id) ?? true) && e.depth < (nearest.get(e.id)?.depth ?? 3);
      if (keep) nearest.set(e.id, e);
    }
    for (const r of slice.relations) edges.set(r.id, r);
  }
  const result = new Set([...hits, ...nearest.keys()]);
  const byDepthThenId = (a: Neighbor, b: Neighbor) => a.depth - b.depth || (a.id < b.id ? -1 : 1);
  return {
    entities: [...nearest.values()].sort(byDepthThenId),
    relations: [...edges.values()].filter((r) => result.has(r.fromId) && result.has(r.toId)),
  };
}
