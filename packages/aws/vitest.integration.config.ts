import { defineConfig } from 'vitest/config';

/** Integration suite: real S3 + SQS via LocalStack (testcontainers — needs Docker). */
export default defineConfig({
  test: {
    include: ['test/**/*.integration.test.ts'],
    environment: 'node',
    testTimeout: 180000,
    hookTimeout: 180000,
  },
});
