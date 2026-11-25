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

/** Metadata fields per type, as the SPEC-presets.md table lists them (optional ones carry `?` there). */
const SPEC_FIELDS: Record<string, { required: string[]; optional: string[] }> = {
  repo: { required: [], optional: ['host', 'ref', 'defaultBranch', 'visibility'] },
  component: { required: [], optional: ['path', 'criticality'] },
  dependency: { required: ['ecosystem'], optional: ['version'] },
  spec: { required: ['location'], optional: [] },
  decision: { required: [], optional: [] },
  principle: { required: ['polarity'], optional: [] },
  invariant: { required: ['state'], optional: ['guardRef'] },
  assumption: { required: ['kind', 'state'], optional: ['guardRef'] },
  gap: { required: ['state'], optional: ['upstreamUrl', 'pinnedVersion', 'shippedInVersion'] },
  learning: { required: ['kind'], optional: [] },
};

describe('presets edge cases', () => {
  it('exports JSON Schemas with exactly the required and optional fields of the spec', () => {
    const fields = Object.fromEntries(
      Object.entries(developmentGraph.ontology.entityTypes).map(([type, def]) => {
        const schema = z.toJSONSchema(def.metadata) as { required?: string[]; properties?: object };
        const required = [...(schema.required ?? [])].sort();
        const optional = Object.keys(schema.properties ?? {})
          .filter((field) => !required.includes(field))
          .sort();
        return [type, { required, optional }];
      }),
    );
    const sorted = Object.fromEntries(
      Object.entries(SPEC_FIELDS).map(([type, f]) => [
        type,
        { required: [...f.required].sort(), optional: [...f.optional].sort() },
      ]),
    );
    expect(fields).toEqual(sorted);
  });

  it('keeps every corpus key in the <type>: convention the instructions teach', () => {
    expect(corpus.entities.filter((e) => !e.key.startsWith(`${e.type}:`)).map((e) => e.key)).toEqual([]);
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
