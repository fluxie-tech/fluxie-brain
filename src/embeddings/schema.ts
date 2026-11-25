import { customType, pgTable, primaryKey, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { entities } from '../core-graph/index.ts';

// Drizzle's vector() always emits vector(N); a dimensionless column lets each model keep its own size.
const vector = customType<{ data: number[]; driverData: string }>({
  dataType: () => 'vector',
  toDriver: (value) => `[${value.join(',')}]`,
  fromDriver: (value) => JSON.parse(value) as number[],
});

/** One vector per entity and model; stale when source_hash differs from entities.content_hash. */
export const entityEmbeddings = pgTable(
  'entity_embeddings',
  {
    entityId: uuid()
      .notNull()
      .references(() => entities.id, { onDelete: 'cascade' }),
    model: text().notNull(),
    sourceHash: text().notNull(),
    embedding: vector().notNull(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.entityId, t.model] })],
);
