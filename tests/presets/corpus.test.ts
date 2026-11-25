import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createSpace, type Entity, neighbors, type Space } from '../../src/core-graph/index.ts';
import { DEVELOPMENT_GRAPH, developmentGraph, registerPresets } from '../../src/presets/index.ts';
import { corpus, loadCorpus } from '../fixtures/development-graph/load.ts';
import { queryRows, truncateAll } from '../setup/db.ts';

const { entityTypes, relationTypes } = developmentGraph.ontology;
const ANCHOR_TYPES = new Set(['repo', 'component', 'dependency']);
const KNOWLEDGE_TYPES = new Set(['decision', 'principle', 'invariant', 'assumption', 'gap', 'learning']);
const projectOf = new Map(corpus.entities.map((e) => [e.key, e.project]));
const typeOf = new Map(corpus.entities.map((e) => [e.key, e.type]));
const defaultStatus = new Map(Object.entries(entityTypes).map(([type, def]) => [type, def.defaultStatus]));

describe('development graph corpus', () => {
  it('is fictional-sized PT/EN data covering every entity and relation type', () => {
    expect(corpus.entities.length).toBeGreaterThanOrEqual(30);
    expect(corpus.entities.filter((e) => e.lang === 'pt').length).toBeGreaterThanOrEqual(12);
    expect(corpus.entities.filter((e) => e.lang === 'en').length).toBeGreaterThanOrEqual(12);
    expect(new Set(corpus.entities.map((e) => e.type))).toEqual(new Set(Object.keys(entityTypes)));
    expect(new Set(corpus.relations.map((r) => r.type))).toEqual(new Set(Object.keys(relationTypes)));
  });

  it('anchors every knowledge entity to a repo, component or dependency with about or applies_to', () => {
    const anchored = new Set(
      corpus.relations
        .filter(({ to, type }) => ['about', 'applies_to'].includes(type) && ANCHOR_TYPES.has(typeOf.get(to) ?? ''))
        .map(({ from }) => from),
    );
    const orphans = corpus.entities.filter((e) => KNOWLEDGE_TYPES.has(e.type) && !anchored.has(e.key));
    expect(orphans.map((e) => e.key)).toEqual([]);
  });

  describe('loaded through core-graph', () => {
    let space: Space;
    let byKey: Map<string, Entity>;
    const knowledgeNear = async (repoKey: string) => {
      const repo = byKey.get(repoKey);
      if (!repo) throw new Error(`missing ${repoKey}`);
      const slice = await neighbors(space.id, repo.id, 2);
      return slice.entities.filter((e) => KNOWLEDGE_TYPES.has(e.type)).map((e) => e.key);
    };

    beforeAll(() => registerPresets());
    beforeEach(async () => {
      await truncateAll();
      space = await createSpace({ slug: 'dev', name: 'Dev', preset: DEVELOPMENT_GRAPH });
      byKey = await loadCorpus(space.id);
    });

    it('stores every entity and relation with the default status of its type', async () => {
      expect(byKey.size).toBe(corpus.entities.length);
      for (const entity of byKey.values()) expect(entity.status).toBe(defaultStatus.get(entity.type));
      expect(await queryRows('select id from relations')).toHaveLength(corpus.relations.length);
    });

    it.each([
      ['repo:fictora/pebble-web', 'pebble', 'quarry'],
      ['repo:fictora/quarry-api', 'quarry', 'pebble'],
    ])('from %s reaches %s and shared knowledge but none specific to %s', async (repoKey, ownProject, otherProject) => {
      const near = await knowledgeNear(repoKey);
      expect(near.filter((key) => projectOf.get(key) === ownProject).length).toBeGreaterThan(0);
      expect(near).toContain('learning:postgres-advisory-locks-behind-pooler');
      expect(near).toContain('principle:fixar-tag-das-imagens-docker');
      expect(near.filter((key) => projectOf.get(key) === otherProject)).toEqual([]);
    });
  });
});
