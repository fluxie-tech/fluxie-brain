import { getTableConfig } from 'drizzle-orm/pg-core';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createSpace, db, registerOntology, upsertEntity } from '../../src/core-graph/index.ts';
import { entityEmbeddings } from '../../src/embeddings/schema.ts';
import { TEST_PRESET, testOntology } from '../fixtures/ontology.ts';
import { appClient, migratorClient, queryRows, truncateAll } from '../setup/db.ts';

describe('entity_embeddings table', () => {
  const app = appClient();
  let entityId: string;

  beforeAll(async () => {
    registerOntology(TEST_PRESET, testOntology);
    await app.connect();
  });
  afterAll(() => app.end());
  beforeEach(async () => {
    await truncateAll();
    const space = await createSpace({ slug: 'emb', name: 'Emb', preset: TEST_PRESET });
    const { entity } = await upsertEntity(space.id, { type: 'project', key: 'p', title: 'P', content: 'c' }, 'agent:t');
    entityId = entity.id;
  });

  const insert = (model: string, vector: string) =>
    app.query(
      `insert into entity_embeddings (entity_id, model, source_hash, embedding) values ($1, $2, 'h', $3::vector)`,
      [entityId, model, vector],
    );

  it('lets the app role insert, read, update and delete rows', async () => {
    await insert('m1', '[1,0,0]');
    await app.query(`update entity_embeddings set source_hash = 'h2' where entity_id = $1`, [entityId]);
    const rows = await queryRows<{ source_hash: string; dims: number }>(
      'select source_hash, vector_dims(embedding) as dims from entity_embeddings',
    );
    expect(rows).toEqual([{ source_hash: 'h2', dims: 3 }]);
    await app.query('delete from entity_embeddings where entity_id = $1', [entityId]);
    expect(await queryRows('select 1 from entity_embeddings')).toHaveLength(0);
  });

  it('round-trips vectors through the Drizzle table as number arrays', async () => {
    await db.insert(entityEmbeddings).values({ entityId, model: 'm1', sourceHash: 'h', embedding: [0.5, -0.25, 1] });
    const rows = await db.select().from(entityEmbeddings);
    expect(rows).toEqual([
      { entityId, model: 'm1', sourceHash: 'h', embedding: [0.5, -0.25, 1], updatedAt: expect.any(Date) },
    ]);
  });

  it('declares the primary key and the cascading foreign key in the Drizzle schema too', () => {
    const config = getTableConfig(entityEmbeddings);
    expect(config.primaryKeys.map((pk) => pk.columns.map((c) => c.name))).toEqual([['entityId', 'model']]);
    const [fk] = config.foreignKeys;
    expect(fk?.onDelete).toBe('cascade');
    expect(getTableConfig(fk?.reference().foreignTable ?? entityEmbeddings).name).toBe('entities');
  });

  it('keeps one row per entity and model, with any dimension per model', async () => {
    await insert('m1', '[1,0,0]');
    await insert('m2', '[1,0,0,0]');
    await expect(insert('m1', '[0,1,0]')).rejects.toThrow(/duplicate key/);
  });

  it('drops the vectors when their entity is removed', async () => {
    await insert('m1', '[1,0,0]');
    // v1 has no hard delete; the cascade exists so a future erasure path cannot leave vectors behind.
    const owner = migratorClient();
    await owner.connect();
    try {
      await owner.query('delete from entities where id = $1', [entityId]);
    } finally {
      await owner.end();
    }
    expect(await queryRows('select 1 from entity_embeddings')).toHaveLength(0);
  });

  it('indexes title and content with BM25 in Portuguese and English, and no longer keeps the tsv GIN', async () => {
    const rows = await queryRows<{ indexname: string; indexdef: string }>(
      `select indexname, indexdef from pg_indexes where tablename = 'entities' and indexdef ilike '%using bm25%' order by 1`,
    );
    expect(rows.map((r) => r.indexname)).toEqual(['entities_bm25_en', 'entities_bm25_pt']);
    const gin = await queryRows(
      `select 1 from pg_indexes where tablename = 'entities' and indexdef ilike '%using gin (tsv)%'`,
    );
    expect(gin).toHaveLength(0);
  });
});
