import { defineConfig } from 'tsdown';

/** Pure entry (`.`) + node file-loading entry (`./load`, the only `node:fs` user). zod external. */
export default defineConfig({
  entry: ['src/index.ts', 'src/load.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  clean: true,
  outDir: 'dist',
  treeshake: true,
  hash: false,
  external: ['zod'],
});
