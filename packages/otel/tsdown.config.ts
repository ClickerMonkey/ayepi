import { defineConfig } from 'tsdown';

/** Frontend-safe def entry (`.`) + node binder entry (`./server`, the only `node:crypto`/`@ayepi/log` user). */
export default defineConfig({
  entry: ['src/index.ts', 'src/server.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  clean: true,
  outDir: 'dist',
  treeshake: true,
  hash: false,
  external: ['@ayepi/core', '@ayepi/log'],
});
