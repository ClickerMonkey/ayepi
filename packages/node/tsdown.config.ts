import { defineConfig } from 'tsdown';

/** Dual-format build with declarations. `ws` and `@ayepi/core` are left external — the
 *  latter so the bundled `.d.ts` *imports* core's branded middleware types (`MiddlewareResult`
 *  and its `MW_PROVIDES` symbol) rather than inlining a private copy, which would make a
 *  caller's `Server<Spec>` brand-incompatible with `serve`'s `Server<AnySpec>` parameter. */
export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  clean: true,
  outDir: 'dist',
  treeshake: true,
  hash: false,
  external: ['ws', '@ayepi/core'],
});
