import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { migratorClient } from './db.ts';

/** Applies all migrations to the test DB once per test run. */
export default async function setup(): Promise<void> {
  const client = migratorClient();
  await client.connect();
  try {
    await migrate(drizzle(client), { migrationsFolder: './migrations' });
  } finally {
    await client.end();
  }
}
