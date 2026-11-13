import { defineConfig } from 'tsdown';

/** The web-standard entry and the Node one (child processes); core (+ its client subpath) and zod stay external (peer deps). */
export default defineConfig({
  entry: ['src/index.ts', 'src/node.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  clean: true,
  outDir: 'dist',
  treeshake: true,
  hash: false,
  external: ['@ayepi/core', '@ayepi/core/client', 'zod'],
});
