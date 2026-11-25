import { readFileSync } from 'node:fs';
import { type Actor, type Entity, linkEntities, upsertEntity } from '../../../src/core-graph/index.ts';

/** `lang` and `project` annotate the fictional corpus for tests and benchmarks; they are not stored. */
export type CorpusEntity = {
  lang: 'pt' | 'en';
  project: 'pebble' | 'quarry' | 'shared';
  type: string;
  key: string;
  title: string;
  content: string;
  metadata: Record<string, unknown>;
};
export type CorpusRelation = { from: string; to: string; type: string };
export type Corpus = { entities: CorpusEntity[]; relations: CorpusRelation[] };

export const corpus = JSON.parse(readFileSync(new URL('./corpus.json', import.meta.url), 'utf8')) as Corpus;

/** Loads the whole corpus into a space through core-graph and returns the stored entities by key. */
export async function loadCorpus(spaceId: string, actor: Actor = 'agent:corpus'): Promise<Map<string, Entity>> {
  const byKey = new Map<string, Entity>();
  for (const { lang: _lang, project: _project, ...input } of corpus.entities) {
    byKey.set(input.key, (await upsertEntity(spaceId, input, actor)).entity);
  }
  const idOf = (key: string): string => {
    const entity = byKey.get(key);
    if (!entity) throw new Error(`Corpus relation points to unknown key "${key}".`);
    return entity.id;
  };
  for (const { from, to, type } of corpus.relations) {
    await linkEntities(spaceId, { fromId: idOf(from), toId: idOf(to), type }, actor);
  }
  return byKey;
}
