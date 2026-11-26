/** A leg's candidate: higher score is better (cosine similarity, negated BM25, PageRank mass). */
export type Scored = { id: string; score: number };

/** How the legs are fused (SPEC-embeddings.md, Emenda 1). Weights are relative to the vector leg, which is 1. */
export type Fusion = { fn: 'rrf' | 'convex'; text: number; graph: number };

/** The three legs of one query; `vector` is undefined when the embeddings provider is down. */
export type Legs = { vector: Scored[] | undefined; text: Scored[]; graph: Scored[] };

const byScoreThenId = (a: Scored, b: Scored) => b.score - a.score || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/**
 * Reciprocal Rank Fusion: each list contributes weight/(k + rank); ties break by id for stable output.
 * A list with weight 0 (or less) is left out entirely. Weights default to 1.
 */
export function fuse(lists: string[][], k = 60, weights: number[] = []): Scored[] {
  const scores = new Map<string, number>();
  lists.forEach((list, l) => {
    const weight = weights[l] ?? 1;
    if (weight <= 0) return;
    for (const [i, id] of list.entries()) scores.set(id, (scores.get(id) ?? 0) + weight / (k + i + 1));
  });
  return [...scores].map(([id, score]) => ({ id, score })).sort(byScoreThenId);
}

/**
 * Convex combination of min-max normalized scores (Bruch et al.): each list is scaled to [0, 1] per query (all-equal
 * scores count as 1), then weighted and summed. A list with weight 0 (or less) is left out entirely.
 */
export function convex(lists: Scored[][], weights: number[]): Scored[] {
  const scores = new Map<string, number>();
  lists.forEach((list, l) => {
    const weight = weights[l] ?? 1;
    if (weight <= 0 || list.length === 0) return;
    const values = list.map((s) => s.score);
    const min = Math.min(...values);
    const span = Math.max(...values) - min;
    for (const { id, score } of list) {
      const normalized = span > 0 ? (score - min) / span : 1;
      scores.set(id, (scores.get(id) ?? 0) + weight * normalized);
    }
  });
  return [...scores].map(([id, score]) => ({ id, score })).sort(byScoreThenId);
}

/** Fuses the legs of one query. Without the vector leg (provider down) the text leg alone decides, at full weight. */
export function combine(legs: Legs, fusion: Fusion): Scored[] {
  const lists = [legs.vector ?? [], legs.text, legs.graph];
  const weights = [1, legs.vector ? fusion.text : 1, legs.vector ? fusion.graph : 0];
  if (fusion.fn === 'convex') return convex(lists, weights);
  return fuse(
    lists.map((list) => list.map((s) => s.id)),
    60,
    weights,
  );
}

/** Query formats that get their own fusion weights (SPEC-embeddings.md, Emenda 3). */
export type QueryShape = 'identifier' | 'short' | 'natural';
export type AdaptiveFusion = Record<QueryShape, Fusion>;

/** A code-like term: a separator between letters or digits, camelCase, or letters next to digits. */
const IDENTIFIER = /[\p{L}\p{N}][_:./\\-]+[\p{L}\p{N}]|\p{Ll}\p{Lu}|\p{L}\p{N}|\p{N}\p{L}/u;

/**
 * Classifies a query by its form alone (never by labels): `identifier` if any term looks like code (config keys,
 * class names, paths, error codes), else `short` for 1 or 2 words, else `natural`.
 */
export function queryShape(query: string): QueryShape {
  if (query.split(/\s+/).some((term) => IDENTIFIER.test(term))) return 'identifier';
  return queryWords(query).length <= 2 ? 'short' : 'natural';
}

/**
 * The query's words, in Unicode NFC (as stored), lowercased and once each. Only letters, marks and digits survive, so no query syntax from the
 * user reaches the text search.
 */
export function queryWords(text: string): string[] {
  return [
    ...new Set(
      text
        .normalize('NFC')
        .toLowerCase()
        .match(/[\p{L}\p{M}\p{N}]+/gu),
    ),
  ];
}
