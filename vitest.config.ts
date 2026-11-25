import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    // Database tests share one test DB and truncate between tests.
    fileParallelism: false,
  },
});
