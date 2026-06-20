import { defineConfig } from 'tsdown';

/** Single entry. Memory backend is bundled; `@ayepi/core` (doer) is a peer, left external. */
export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  clean: true,
  outDir: 'dist',
  treeshake: true,
  hash: false,
  external: ['@ayepi/core', '@ayepi/core/doer'],
});
