import { defineConfig } from 'tsdown';

/** Entries: the def + standalone store/helpers (`.`) and the server binder (`./server`). */
export default defineConfig({
  entry: ['src/index.ts', 'src/server.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  clean: true,
  outDir: 'dist',
  treeshake: true,
  hash: false,
  external: ['@ayepi/core'],
});
