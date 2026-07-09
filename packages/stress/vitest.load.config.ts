import { defineConfig } from 'vitest/config';

/**
 * The load/stress suite: long-running, spawns child processes, and generates real traffic.
 * Serial (one file at a time, no in-file parallelism) so runs don't contend for CPU/sockets,
 * with generous timeouts and no coverage gate.
 */
export default defineConfig({
  test: {
    include: ['test/**/*.load.test.ts'],
    environment: 'node',
    testTimeout: 300_000,
    hookTimeout: 120_000,
    fileParallelism: false,
    pool: 'forks',
  },
});
