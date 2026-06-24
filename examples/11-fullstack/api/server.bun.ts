/**
 * # 11 · fullstack — Bun entry (`@ayepi/bun`)
 *
 * The same assembled `app`, served with Bun's native HTTP via `@ayepi/bun`. Run under Bun:
 *
 * ```sh
 * bun run api/server.bun.ts
 * ```
 *
 * It type-checks and bundles under plain Node (the `Bun` global is only read when `serve`
 * is *called*), so it's part of the build surface even where Bun isn't installed.
 */
import { serve } from '@ayepi/bun';
import { PORT } from '../shared/domain';
import { app } from './app';
import { work, backendLabel } from './work';

work.start();
serve(app, {
  port: PORT,
  path: '/ws',
  onListen: ({ port }) => console.log(`11 · fullstack on Bun → http://localhost:${port}/  (backend: ${backendLabel})`),
});
