import { defineConfig } from 'vitest/config';

/** Unit tests only. The long-running load suite (`*.load.test.ts`) runs via `vitest.load.config.ts`. */
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    exclude: ['test/**/*.load.test.ts', '**/node_modules/**'],
    environment: 'node',
  },
});
