import { pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

const createdAt = () => timestamp({ withTimezone: true }).notNull().defaultNow();

export const spaces = pgTable('spaces', {
  id: uuid().primaryKey().defaultRandom(),
  slug: text().notNull().unique(),
  name: text().notNull(),
  preset: text().notNull(),
  createdAt: createdAt(),
});
