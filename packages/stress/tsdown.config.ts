import { defineConfig } from 'tsdown';

/** Entries: the public API (`.`) and the runnable target `entry` the child-process runner spawns. */
export default defineConfig({
  entry: ['src/index.ts', 'src/entry.ts', 'src/cli.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  clean: true,
  outDir: 'dist',
  treeshake: true,
  hash: false,
  external: ['@ayepi/core', '@ayepi/core/stats', '@ayepi/node', 'zod'],
});
