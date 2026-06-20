import { defineConfig } from 'tsdown';

/** Entries: core logger, file transport (node:fs), the frontend-safe middleware def, and its node binder. */
export default defineConfig({
  entry: ['src/index.ts', 'src/file.ts', 'src/middleware.ts', 'src/server.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  clean: true,
  outDir: 'dist',
  treeshake: true,
  hash: false,
  external: ['@ayepi/core', 'node:fs', 'node:path', 'node:async_hooks'],
});
