import { defineConfig } from 'tsdown';

/** Entries: the interface + helpers (`.`), the filesystem store (`./fs`), and the presign/serve glue (`./server`). */
export default defineConfig({
  entry: ['src/index.ts', 'src/fs.ts', 'src/server.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  clean: true,
  outDir: 'dist',
  treeshake: true,
  hash: false,
  external: ['@ayepi/core'],
});
