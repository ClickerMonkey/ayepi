import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      // barrels re-export only; payload/manifest/types are type-only (no runtime)
      exclude: ['src/index.ts', 'src/client/index.ts', 'src/payload.ts', 'src/manifest.ts', 'src/types.ts'],
      reporter: ['text', 'json-summary', 'json', 'html'],
      all: true,
      thresholds: { statements: 100, functions: 100, lines: 100, branches: 98 },
    },
  },
});
