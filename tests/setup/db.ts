import pg from 'pg';

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing env var ${name}. Copy .env.example to .env.`);
  return value;
}

/** Connection to the test DB as the restricted application role. */
export function appClient(): pg.Client {
  return new pg.Client({ connectionString: requireEnv('TEST_DATABASE_URL') });
}

/** Connection to the test DB as the schema owner (migrations, truncation). */
export function migratorClient(): pg.Client {
  return new pg.Client({ connectionString: requireEnv('TEST_MIGRATOR_DATABASE_URL') });
}

/** Empties every table in the public schema of the test DB. */
export async function truncateAll(): Promise<void> {
  const client = migratorClient();
  await client.connect();
  try {
    const { rows } = await client.query<{ tablename: string }>(
      `select tablename from pg_tables where schemaname = 'public'`,
    );
    if (rows.length === 0) return;
    const tables = rows.map((r) => `"public"."${r.tablename}"`).join(', ');
    await client.query(`truncate ${tables} restart identity cascade`);
  } finally {
    await client.end();
  }
}
