import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  createSpace,
  type Entity,
  linkEntities,
  neighbors,
  OntologyError,
  type Space,
  upsertEntity,
} from '../../src/core-graph/index.ts';
import { DEVELOPMENT_GRAPH, developmentGraph, registerPresets } from '../../src/presets/index.ts';
import { corpus, loadCorpus } from '../fixtures/development-graph/load.ts';
import { queryRows, truncateAll } from '../setup/db.ts';

const agent = 'agent:test';

const HOLDS = ['holds', 'violated'];
const ECOSYSTEMS = ['language', 'npm', 'pypi', 'composer', 'cargo', 'go', 'maven', 'nuget', 'gem', 'docker'];
/** Metadata per type as the SPEC-presets.md table defines it: 'string', 'url' (http/https) or the enum values. */
const SPEC_SHAPES: Record<string, Record<string, string | string[]>> = {
  repo: {
    host: ['github', 'gitlab', 'other'],
    ref: 'string',
    defaultBranch: 'string',
    visibility: ['public', 'private'],
  },
  component: { path: 'string', criticality: ['low', 'medium', 'high', 'critical'] },
  dependency: { ecosystem: [...ECOSYSTEMS, 'service', 'tool', 'other'], version: 'string' },
  spec: { location: 'string' },
  decision: {},
  principle: { polarity: ['prescribes', 'forbids'] },
  invariant: { state: HOLDS, guardRef: 'string' },
  assumption: { kind: ['compile', 'runtime', 'manual'], state: HOLDS, guardRef: 'string' },
  gap: {
    state: ['narrowing', 'widened', 'closed'],
    upstreamUrl: 'url',
    pinnedVersion: 'string',
    shippedInVersion: 'string',
  },
  learning: { kind: ['gotcha', 'hindsight', 'retro', 'incident_review'] },
};
/** The fields without `?` in the spec table. */
const SPEC_REQUIRED: Record<string, string[]> = {
  dependency: ['ecosystem'],
  spec: ['location'],
  principle: ['polarity'],
  invariant: ['state'],
  assumption: ['kind', 'state'],
  gap: ['state'],
  learning: ['kind'],
};

type PropSchema = { type?: string; format?: string; enum?: string[] };
const schemaOf = (type: string) => {
  const def = Object.entries(developmentGraph.ontology.entityTypes).find(([name]) => name === type)?.[1];
  if (!def) throw new Error(`missing type ${type}`);
  return z.toJSONSchema(def.metadata) as { required?: string[]; properties?: Record<string, PropSchema> };
};

describe('presets edge cases', () => {
  it.each(Object.keys(SPEC_SHAPES))('%s metadata has exactly the fields, types and enum values of the spec', (type) => {
    const schema = schemaOf(type);
    const shapes = Object.fromEntries(
      Object.entries(schema.properties ?? {}).map(([field, prop]) => [
        field,
        prop.enum ? [...prop.enum] : prop.format === 'uri' ? 'url' : prop.type,
      ]),
    );
    expect(shapes).toEqual(SPEC_SHAPES[type]);
    expect([...(schema.required ?? [])].sort()).toEqual([...(SPEC_REQUIRED[type] ?? [])].sort());
  });

  it('only accepts http(s) links as gap upstream URLs', () => {
    const gap = developmentGraph.ontology.entityTypes.gap.metadata;
    expect(gap.safeParse({ state: 'widened', upstreamUrl: 'https://example.com/issues/1' }).success).toBe(true);
    expect(gap.safeParse({ state: 'widened', upstreamUrl: 'javascript:alert(1)' }).success).toBe(false);
  });

  it('keeps every corpus key in the convention the instructions teach', () => {
    const repos = corpus.entities.filter((e) => e.type === 'repo').map((e) => e.key.slice('repo:'.length));
    const wrong = corpus.entities.filter(
      (e) =>
        !e.key.startsWith(`${e.type}:`) ||
        (['component', 'spec'].includes(e.type) && !repos.some((repo) => e.key.startsWith(`${e.type}:${repo}/`))),
    );
    expect(wrong.map((e) => e.key)).toEqual([]);
  });

  describe('through core-graph', () => {
    let space: Space;

    beforeAll(() => registerPresets());
    beforeEach(async () => {
      await truncateAll();
      space = await createSpace({ slug: 'dev', name: 'Dev', preset: DEVELOPMENT_GRAPH });
    });

    it('names the missing required field and writes nothing', async () => {
      const input = { type: 'dependency', key: 'dependency:npm/zod', title: 'Zod', content: '' };
      await expect(upsertEntity(space.id, input, agent)).rejects.toThrow(OntologyError);
      await expect(upsertEntity(space.id, input, agent)).rejects.toThrow(/ecosystem/);
      expect(await queryRows('select id from entities')).toHaveLength(0);
      expect(await queryRows('select id from change_log')).toHaveLength(0);
    });

    it('turns an agent edit of an approved structural entity into a pending proposal', async () => {
      const repo = { type: 'repo', key: 'repo:acme/app', title: 'App', content: 'Billing API.' };
      const { entity: created } = await upsertEntity(space.id, repo, 'human:owner');
      const { entity, proposal } = await upsertEntity(space.id, { ...repo, content: 'Payments API.' }, agent);
      expect(entity).toMatchObject({ id: created.id, content: 'Billing API.', version: created.version });
      expect(proposal).toMatchObject({ status: 'pending', proposedBy: agent });
    });

    it('leaks a stack-specific lesson to other repos when it is anchored to a shared dependency', async () => {
      const byKey = await loadCorpus(space.id);
      const get = (key: string): Entity => {
        const entity = byKey.get(key);
        if (!entity) throw new Error(`missing ${key}`);
        return entity;
      };
      const lesson = get('learning:laravel-config-cache-em-producao');
      const link = { fromId: lesson.id, toId: get('dependency:docker/postgres').id, type: 'about' };
      await linkEntities(space.id, link, agent);
      const near = await neighbors(space.id, get('repo:fictora/pebble-web').id, 2);
      // Separation is only as good as the anchors: the instructions must keep lessons on their own stack.
      expect(near.entities.map((e) => e.key)).toContain(lesson.key);
    });
  });
});
