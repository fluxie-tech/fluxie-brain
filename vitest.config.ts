import { defineConfig } from 'vitest/config';

try {
  process.loadEnvFile('.env');
} catch {
  // No .env: rely on variables already present in the environment (e.g. CI).
}

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    globalSetup: ['tests/setup/global-setup.ts'],
    // Database tests share one test DB and truncate between tests.
    fileParallelism: false,
    env: { DATABASE_URL: process.env.TEST_DATABASE_URL ?? '' },
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      reporter: ['text-summary', 'lcov'],
      // Ratchet (CONSTRAINTS.md): measured 2026-11-25 minus 0.5 tolerance. Raise when it improves; never lower.
      thresholds: { lines: 96.5, statements: 91.8, functions: 90.8, branches: 85.5 },
    },
  },
});
