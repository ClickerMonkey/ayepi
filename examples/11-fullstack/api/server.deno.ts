/**
 * # 11 · fullstack — Deno entry (`@ayepi/deno`)
 *
 * The same assembled `app`, served with Deno's native HTTP via `@ayepi/deno`. Run under Deno:
 *
 * ```sh
 * deno run -A api/server.deno.ts
 * ```
 *
 * Like the Bun entry, it type-checks and bundles under plain Node (the `Deno` global is only
 * read when `serve` is *called*).
 */
import { serve } from '@ayepi/deno';
import { PORT } from '../shared/domain';
import { app } from './app';
import { work, backendLabel } from './work';

work.start();
serve(app, {
  port: PORT,
  path: '/ws',
  onListen: ({ port }) => console.log(`11 · fullstack on Deno → http://localhost:${port}/  (backend: ${backendLabel})`),
});
