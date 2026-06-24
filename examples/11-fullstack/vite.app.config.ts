/**
 * Vite build for the **browser** app. Root is `app/` (its `index.html` is the entry); the
 * output is a static bundle in `app/dist`. The Vue ESM-bundler alias ships the runtime
 * template compiler (the client uses string templates). If anything Node-only ever leaked
 * into the browser graph (a server package, zod, `node:*`), this build would fail — which
 * is the point.
 */
import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  root: fileURLToPath(new URL('./app', import.meta.url)),
  resolve: {
    alias: { vue: 'vue/dist/vue.esm-bundler.js' }, // the build that ships the template compiler
  },
  define: {
    __VUE_OPTIONS_API__: 'false',
    __VUE_PROD_DEVTOOLS__: 'false',
    __VUE_PROD_HYDRATION_MISMATCH_DETAILS__: 'false',
  },
  build: {
    outDir: fileURLToPath(new URL('./app/dist', import.meta.url)),
    emptyOutDir: true,
    target: 'es2022',
  },
});
