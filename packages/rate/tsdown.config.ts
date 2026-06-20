import { defineConfig } from 'tsdown';

/** Entries: the def + standalone primitives (`.`), the server binder (`./server`), and the Redis store. */
export default defineConfig({
  entry: ['src/index.ts', 'src/server.ts', 'src/redis.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  clean: true,
  outDir: 'dist',
  treeshake: true,
  hash: false,
  external: ['@ayepi/core', '@ayepi/core/doer', 'ioredis'],
});
