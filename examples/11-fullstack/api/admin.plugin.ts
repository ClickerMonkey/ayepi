/**
 * # 11 · fullstack — an admin plugin (`@ayepi/plugin`, server-only)
 *
 * Installed into the running server at boot, it hot-mounts a `GET /adminStats` route that
 * reports live job counts. `@ayepi/plugin` is **server-only** — the browser never imports it,
 * and the typed client never sees these routes (they're added at runtime).
 */
import { z } from 'zod';
import { spec, endpoint } from '@ayepi/core';
import { plugin } from '@ayepi/plugin';
import { jobs } from './work';

/** The plugin's own spec — composed onto the host server at install time. */
export const adminSpec = spec({
  endpoints: {
    adminStats: endpoint({ method: 'GET', response: z.object({ jobs: z.number(), running: z.number() }) }),
  },
});

/** The admin plugin: contributes the `/adminStats` route (no dependencies). */
export const admin = plugin({ name: 'admin', requires: [] as const, spec: adminSpec })
  .handlers(() => ({
    adminStats: () => ({ jobs: jobs.size, running: [...jobs.values()].filter((j) => !j.done).length }),
  }))
  .lifecycle(() => ({
    up: () => console.log('  [plugin] admin installed → GET /adminStats live'),
    stop: () => console.log('  [plugin] admin removed'),
  }));
