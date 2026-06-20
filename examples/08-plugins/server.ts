/**
 * Node server: a plugin host. Boots an (almost) empty server, then installs three
 * plugins **into the running server** in dependency order (auth → notes → stats),
 * and demonstrates **hot** uninstall/reinstall of `stats` on a timer — the `/stats`
 * route disappears and reappears while everything else keeps serving.
 *
 * `@ayepi/plugin` is **server-only** — the client never imports it.
 */
import { spec, server } from '@ayepi/core';
import { createPluginHost } from '@ayepi/plugin';
import { auth } from './auth';
import { notes } from './notes';
import { stats } from './stats';
import { runExample } from '../_harness';

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

// boot an empty server; plugins mount their endpoints/events onto it live
const app = server(spec({ endpoints: {} }), [], {
  cors: { origin: '*' },
  docs: { info: { title: 'ayepi · 08 plugins', version: '1.0.0' } },
});

const host = createPluginHost(app);

console.log('installing plugins (auth → notes → stats):');
await host.install(auth);
await host.install(notes); // requires auth
await host.install(stats); // requires notes (→ auth)
console.log('  installed:', host.installed().join(', '));

// the host refuses to remove a plugin that others still depend on
await host.uninstall('auth').catch((e: Error) => console.log(`  (refused) ${e.message}`));

// hot uninstall + reinstall `stats` forever — watch /stats blink while the rest stays up
void (async () => {
  for (;;) {
    await delay(8000);
    await host.uninstall('stats');
    console.log('  [hot] uninstalled stats — GET /stats now 404s');
    await delay(4000);
    await host.install(stats);
    console.log('  [hot] reinstalled stats — GET /stats live again');
  }
})();

runExample({ app, clientEntry: new URL('./client.ts', import.meta.url), title: '08 · plugins', port: 3008 });
