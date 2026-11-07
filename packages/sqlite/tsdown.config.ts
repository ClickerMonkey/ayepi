import { defineConfig } from 'tsdown';

/** Dual-format build with declarations. The ayepi packages and zod are external; the database is passed in. */
export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  clean: true,
  outDir: 'dist',
  treeshake: true,
  hash: false,
  external: ['@ayepi/core', '@ayepi/work', '@ayepi/rate', 'zod'],
});
