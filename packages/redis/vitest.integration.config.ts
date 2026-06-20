import { defineConfig } from 'vitest/config';

/** Integration suite: spins a real Redis via testcontainers (needs Docker). */
export default defineConfig({
  test: {
    include: ['test/**/*.integration.test.ts'],
    environment: 'node',
    testTimeout: 120000,
    hookTimeout: 120000,
  },
});
