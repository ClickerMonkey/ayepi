import { defineConfig } from 'tsdown';

/** Single entry; core (+ its client subpath) and zod stay external (peer deps). */
export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  clean: true,
  outDir: 'dist',
  treeshake: true,
  hash: false,
  external: ['@ayepi/core', '@ayepi/core/client', 'zod'],
});
