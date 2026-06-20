import { defineConfig } from 'tsdown';

/**
 * Dual-format (ESM + CJS) build with declaration files for both. Entries: the full
 * surface (`.`), the zod-free client (`./client`), and the runtime-agnostic doer
 * primitive (`./doer`). `zod` is a peer dependency and is left external.
 */
export default defineConfig({
  entry: ['src/index.ts', 'src/client/index.ts', 'src/doer.ts', 'src/retry.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  clean: true,
  outDir: 'dist',
  treeshake: true,
  // keep entry filenames stable (index.d.ts / client/index.d.ts / doer.d.ts) so they match the exports map
  hash: false,
  external: ['zod'],
});
