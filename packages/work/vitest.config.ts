import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    exclude: ['test/**/*.integration.test.ts', '**/node_modules/**'],
    environment: 'node',
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/ports.ts'], // pure type/interface declarations — no runtime to cover
      reporter: ['text', 'json-summary'],
      all: true,
      thresholds: { statements: 100, functions: 100, lines: 100, branches: 95 },
    },
  },
});
