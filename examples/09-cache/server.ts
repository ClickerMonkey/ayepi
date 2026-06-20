/**
 * Node server: a cached, per-user report.
 *
 * `GET /report` runs an "expensive" handler (it sleeps and stamps a timestamp); the
 * {@link cache} middleware stores the JSON response, keyed per user (`vary`), and replays
 * it for `ttl` — and a further `staleWhileRevalidate` window where the stale report is
 * served instantly while it refreshes in the background. `POST /bust` deletes a user's
 * entry. Watch the console: `[report] built …` logs **only** on a miss or a refresh.
 */
import { server, implement } from '@ayepi/core';
import { cache } from '@ayepi/cache/server';
import { memoryCache, cacheKey } from '@ayepi/cache';
import { api, cached, userMw } from './shared';
import { runExample } from '../_harness';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// the store is held here so `bust` can invalidate specific keys
const store = memoryCache({ maxBytes: 8 * 1024 * 1024 });
let builds = 0;

const builder = implement(api)
  .middleware(userMw, async (io) => io.next({ user: io.req.headers.get('x-user') ?? 'anon' }))
  .middleware(
    cache.server(cached, {
      ttl: 8000, // fresh for 8s
      staleWhileRevalidate: 8000, // then serve stale up to 8s more while refreshing
      store,
      vary: (io) => io.ctx.user, // a per-user cache
    }),
  )
  .handlers({
    report: async ({ user }) => {
      await sleep(600); // simulate an expensive build
      const value = Math.round(Math.random() * 1000);
      console.log(`  [report] built #${++builds} for ${user} (value ${value})`);
      return { user, value, generatedAt: new Date().toISOString() };
    },
    bust: ({ data }) => {
      const removed = store.delete(cacheKey({ method: 'GET', path: '/report', vary: data.user }));
      console.log(`  [bust] ${data.user}: ${removed ? 'cleared' : 'nothing cached'}`);
      return { ok: true };
    },
  });

const app = server(api, [builder], {
  cors: { origin: '*' },
  docs: { info: { title: 'ayepi · 09 cache', version: '1.0.0' } },
});

runExample({ app, clientEntry: new URL('./client.ts', import.meta.url), title: '09 · cache', port: 3009 });
