import { defineConfig } from 'tsdown';

/** Single entry; zod stays external (a peer dep). */
export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  clean: true,
  outDir: 'dist',
  treeshake: true,
  hash: false,
  external: ['zod'],
});
