import { defineConfig } from 'vitest/config';

/** Default suite: unit tests only (no Docker). Integration runs via test:integration. */
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    exclude: ['test/**/*.integration.test.ts', '**/node_modules/**'],
    environment: 'node',
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      reporter: ['text', 'json-summary'],
      all: true,
      thresholds: { statements: 100, functions: 100, lines: 100, branches: 100 },
    },
  },
});
