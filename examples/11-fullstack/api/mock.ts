/**
 * # 11 · fullstack — mock API (`@ayepi/mock`)
 *
 * A **fully mocked** server for the same spec — every endpoint returns deterministic,
 * schema-valid fake data (seeded), with no auth, work engine, cache, or files behind it.
 * Point the browser app at this while the real backend is still in flux:
 *
 * ```sh
 * pnpm fullstack:mock   # serves the mock API on the same port
 * ```
 */
import { serve } from '@ayepi/node';
import { mockServer } from '@ayepi/mock';
import { api } from '../shared/spec';
import { PORT } from '../shared/domain';

const app = mockServer(api, { seed: 1, arraySize: 4 });

serve(app, {
  port: PORT,
  path: '/ws',
  onListen: ({ port }) => {
    const base = `http://localhost:${port}`;
    console.log(`\n  11 · fullstack — MOCK API (@ayepi/mock, seeded)`);
    console.log(`  ${base}/   ·   docs at ${base}/docs/swagger`);
    console.log('  (Ctrl-C to stop)\n');
  },
});
