import { defineConfig } from 'drizzle-kit';

try {
  process.loadEnvFile('.env');
} catch {
  // No .env: rely on variables already present in the environment.
}

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/core-graph/schema.ts',
  out: './migrations',
  dbCredentials: { url: process.env.MIGRATOR_DATABASE_URL ?? '' },
});
