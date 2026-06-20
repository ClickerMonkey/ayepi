import { defineConfig } from 'tsdown';

/** Dual-format build with declarations. `@ayepi/core` and `ioredis` are external. */
export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  clean: true,
  outDir: 'dist',
  treeshake: true,
  hash: false,
  external: ['@ayepi/core', '@ayepi/work', '@ayepi/cache', 'ioredis'],
});
