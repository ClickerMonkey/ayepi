/**
 * Vite **SSR** build for the **Node** api. Bundles the whole server graph
 * (`api/server.ts` → app → handlers → work → backends → every server package) for the
 * Node target, externalizing `node_modules` and `node:*` builtins. If a browser-only
 * assumption leaked into the server graph it would fail here — the mirror of the app build.
 */
import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
import { builtinModules } from 'node:module';

export default defineConfig({
  build: {
    ssr: fileURLToPath(new URL('./api/server.ts', import.meta.url)),
    outDir: fileURLToPath(new URL('./api/dist', import.meta.url)),
    emptyOutDir: true,
    target: 'node20',
    rollupOptions: {
      external: [...builtinModules, ...builtinModules.map((m) => `node:${m}`)],
      output: { format: 'esm', entryFileNames: 'server.js' },
    },
  },
});
