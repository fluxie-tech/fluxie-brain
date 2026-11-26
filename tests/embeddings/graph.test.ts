import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createSpace, type Entity, type Space } from '../../src/core-graph/index.ts';
import { graphLeg, personalizedPageRank } from '../../src/embeddings/graph.ts';
import { scopeIds } from '../../src/embeddings/scope.ts';
import { DEVELOPMENT_GRAPH, developmentGraph, registerPresets } from '../../src/presets/index.ts';
import { corpus, loadCorpus } from '../fixtures/development-graph/load.ts';
import { truncateAll } from '../setup/db.ts';

const order = (rank: Map<string, number>) => [...rank].sort(([, x], [, y]) => y - x).map(([id]) => id);
const sum = (rank: Map<string, number>) => [...rank.values()].reduce((a, b) => a + b, 0);

describe('personalizedPageRank', () => {
  const line = [
    ['a', 'b'],
    ['b', 'c'],
    ['c', 'd'],
  ] as const;

  it('ranks the seed first, then direct neighbours before farther nodes, and keeps the mass at 1', () => {
    const rank = personalizedPageRank([...line], [{ id: 'a', weight: 1 }]);
    expect(order(rank)).toEqual(['a', 'b', 'c', 'd']);
    expect(sum(rank)).toBeCloseTo(1, 9);
  });

  it('follows edges in both directions and weights the seeds', () => {
    const rank = personalizedPageRank(
      [...line],
      [
        { id: 'd', weight: 3 },
        { id: 'a', weight: 1 },
      ],
    );
    expect(order(rank)[0]).toBe('d');
    expect(rank.get('c') ?? 0).toBeGreaterThan(rank.get('b') ?? 0);
  });

  it('terminates on cycles and ignores self-loops', () => {
    const rank = personalizedPageRank(
      [
        ['a', 'b'],
        ['b', 'c'],
        ['c', 'a'],
        ['a', 'a'],
      ],
      [{ id: 'a', weight: 1 }],
    );
    expect(sum(rank)).toBeCloseTo(1, 9);
    expect(rank.get('b')).toBeCloseTo(rank.get('c') ?? 0, 9);
  });

  it('ignores self-loops: the ranks equal those of the same graph without them', () => {
    const seeds = [{ id: 'a', weight: 1 }];
    const clean = personalizedPageRank([...line], seeds);
    const looped = personalizedPageRank([['a', 'a'], ...line, ['b', 'b']], seeds);
    expect(looped.size).toBe(clean.size);
    for (const [id, score] of clean) expect(looped.get(id)).toBeCloseTo(score, 12);
  });

  it('keeps all the mass on an isolated seed, and gives nothing without positive weights', () => {
    expect([...personalizedPageRank([...line], [{ id: 'z', weight: 1 }])]).toEqual([['z', 1]]);
    expect(personalizedPageRank([...line], [{ id: 'a', weight: 0 }]).size).toBe(0);
    expect(personalizedPageRank([...line], []).size).toBe(0);
  });
});

describe('graphLeg on the presets corpus', () => {
  let space: Space;
  let byKey: Map<string, Entity>;
  const id = (key: string) => byKey.get(key)?.id ?? '';
  const keyOf = (hits: { id: string }[]) => {
    const keys = new Map([...byKey].map(([k, e]) => [e.id, k]));
    return hits.map((h) => keys.get(h.id));
  };
  const statuses = ['approved' as const, 'draft' as const];

  beforeAll(() => registerPresets());
  beforeEach(async () => {
    await truncateAll();
    space = await createSpace({ slug: 'dev', name: 'Dev', preset: DEVELOPMENT_GRAPH });
    byKey = await loadCorpus(space.id);
  });

  it('ranks the seed, then every entity linked to it, before anything two hops away', async () => {
    const seed = 'component:fictora/pebble-web/sync';
    const direct = new Set(corpus.relations.flatMap((r) => (r.from === seed ? [r.to] : r.to === seed ? [r.from] : [])));
    const top = keyOf(await graphLeg([{ id: id(seed), weight: 1 }], { spaceId: space.id, statuses }, 20));
    expect(top[0]).toBe(seed);
    expect(new Set(top.slice(1, 1 + direct.size))).toEqual(direct);
    expect(direct).toContain('learning:pebble-crdt-migration-hindsight');
  });

  it('never leaves the anchor scope, even from a shared dependency', async () => {
    const ids = await scopeIds(space.id, { key: 'repo:fictora/pebble-web', scope: developmentGraph.scope });
    const seeds = [{ id: id('dependency:docker/postgres'), weight: 1 }];
    const keys = keyOf(await graphLeg(seeds, { spaceId: space.id, statuses, ids }, 60));
    const quarry = new Set(corpus.entities.filter((e) => e.project === 'quarry').map((e) => e.key));
    expect(keys.length).toBeGreaterThan(1);
    expect(keys.filter((k) => quarry.has(k ?? ''))).toEqual([]);
  });

  it('returns nothing without seeds', async () => {
    expect(await graphLeg([], { spaceId: space.id, statuses }, 10)).toEqual([]);
  });
});
