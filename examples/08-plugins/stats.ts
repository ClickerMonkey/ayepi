/**
 * The **stats** plugin — `requires: [notes]` (a two-level chain: stats → notes → auth).
 *
 * It contributes nothing but a `/stats` endpoint that reads the `notes` plugin's
 * `count()` state service. This is the plugin the server hot-uninstalls/reinstalls
 * on a timer to demonstrate live mutation — and uninstalling `notes` while `stats`
 * is live is refused by the host.
 */
import { z } from 'zod';
import { spec, endpoint } from '@ayepi/core';
import { plugin } from '@ayepi/plugin';
import { notes } from './notes';

export const statsSpec = spec({
  endpoints: { stats: endpoint({ method: 'GET', response: z.object({ notes: z.number() }) }) },
});

export const stats = plugin({
  name: 'stats',
  requires: [notes] as const,
  spec: statsSpec,
})
  .handlers((ctx) => ({
    stats: () => ({ notes: ctx.deps.notes.state.count() }),
  }))
  .lifecycle(() => ({
    up: () => console.log('  [stats] up'),
    stop: () => console.log('  [stats] stop'),
  }));
