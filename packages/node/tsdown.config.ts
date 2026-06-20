import { defineConfig } from 'tsdown';

/** Dual-format build with declarations. `ws` and `ayepi` are left external. */
export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  clean: true,
  outDir: 'dist',
  treeshake: true,
  hash: false,
  external: ['ws', 'ayepi'],
});
