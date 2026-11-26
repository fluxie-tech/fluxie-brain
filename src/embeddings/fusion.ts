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
 * The query's words, lowercased and once each. Only letters, marks and digits survive, so no query syntax from the
 * user reaches the text search.
 */
export function queryWords(text: string): string[] {
  return [...new Set(text.toLowerCase().match(/[\p{L}\p{M}\p{N}]+/gu))];
}
