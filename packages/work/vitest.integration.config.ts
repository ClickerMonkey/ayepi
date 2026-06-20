import { defineConfig } from 'vitest/config';

/** Integration suite: multi-engine (multi-pod) fan-out over a shared in-memory backend. */
export default defineConfig({
  test: {
    include: ['test/**/*.integration.test.ts'],
    environment: 'node',
    testTimeout: 120000,
    hookTimeout: 120000,
  },
});
