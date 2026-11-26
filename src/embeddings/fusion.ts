/** Reciprocal Rank Fusion: each list contributes 1/(k + rank); ties break by id for stable output. */
export function fuse(lists: string[][], k = 60): { id: string; score: number }[] {
  const scores = new Map<string, number>();
  for (const list of lists) {
    for (const [i, id] of list.entries()) scores.set(id, (scores.get(id) ?? 0) + 1 / (k + i + 1));
  }
  return [...scores]
    .map(([id, score]) => ({ id, score }))
    .sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/**
 * The query's words joined with OR, in to_tsquery syntax; undefined when it has no word at all.
 * plainto_tsquery would AND every word, and a natural-language question almost never matches all of them.
 * Only letters, marks and digits survive, so no tsquery operator from the user ever reaches Postgres.
 */
export function orQuery(text: string): string | undefined {
  const words = new Set(text.toLowerCase().match(/[\p{L}\p{M}\p{N}]+/gu));
  return words.size > 0 ? [...words].join(' | ') : undefined;
}
