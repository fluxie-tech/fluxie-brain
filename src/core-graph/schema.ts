import { sql } from 'drizzle-orm';
import {
  bigserial,
  check,
  customType,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  real,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';

const createdAt = () => timestamp({ withTimezone: true }).notNull().defaultNow();
const tsvector = customType<{ data: string }>({ dataType: () => 'tsvector' });

export const spaces = pgTable('spaces', {
  id: uuid().primaryKey().defaultRandom(),
  slug: text().notNull().unique(),
  name: text().notNull(),
  preset: text().notNull(),
  createdAt: createdAt(),
});

export const entityStatus = pgEnum('entity_status', ['draft', 'approved', 'deprecated', 'rejected']);

export const entities = pgTable(
  'entities',
  {
    id: uuid().primaryKey().defaultRandom(),
    spaceId: uuid()
      .notNull()
      .references(() => spaces.id),
    type: text().notNull(),
    key: text().notNull(),
    title: text().notNull(),
    content: text().notNull().default(''),
    metadata: jsonb().$type<Record<string, unknown>>().notNull().default({}),
    status: entityStatus().notNull(),
    confidence: real().notNull().default(0.5),
    usageCount: integer().notNull().default(0),
    lastUsedAt: timestamp({ withTimezone: true }),
    // The embeddings module compares this to its stored source hash to know what to re-embed.
    contentHash: text().generatedAlwaysAs(sql`md5("title" || E'\n' || "content")`),
    tsv: tsvector().generatedAlwaysAs(sql`to_tsvector('simple', "title" || ' ' || "content")`),
    version: integer().notNull().default(1),
    createdBy: text().notNull(),
    createdAt: createdAt(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique().on(t.spaceId, t.key),
    index().on(t.spaceId, t.type, t.status),
    check('entities_confidence_range', sql`${t.confidence} between 0 and 1`),
  ],
);

export const targetKind = pgEnum('target_kind', ['entity', 'relation', 'proposal']);
export const changeAction = pgEnum('change_action', [
  'create',
  'update',
  'status',
  'propose',
  'accept',
  'reject',
  'unlink',
  'revert',
]);

export const changeLog = pgTable(
  'change_log',
  {
    id: bigserial({ mode: 'number' }).primaryKey(),
    spaceId: uuid()
      .notNull()
      .references(() => spaces.id),
    targetKind: targetKind().notNull(),
    targetId: uuid().notNull(),
    action: changeAction().notNull(),
    actor: text().notNull(),
    before: jsonb(),
    after: jsonb(),
    createdAt: createdAt(),
  },
  (t) => [index().on(t.targetId, t.createdAt)],
);
