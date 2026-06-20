/**
 * Single-file Vue client. Loads the per-user report through the typed client (the
 * `x-user` header rides the global `headers`, driving the cache's `vary`), times each
 * call, and logs the result. A cache **HIT** comes back near-instantly and keeps the same
 * `generatedAt`; after the `ttl` it's slow again (a fresh build). "Bust" clears the entry.
 *
 * The response also carries an `X-Cache: HIT | STALE | MISS` header — visible in the
 * browser devtools network panel.
 */
import { createApp, ref } from 'vue';
import { client } from '@ayepi/core/client';
import manifest from './manifest.gen';
import type { api, Report } from './shared';

const user = ref('ada');
// the x-user header rides every request → it's what the server's `vary` keys on
const sdk = client<typeof api>({ baseUrl: location.origin, manifest, headers: () => ({ 'x-user': user.value }) });

createApp({
  setup() {
    const report = ref<Report | null>(null);
    const elapsed = ref(0);
    const log = ref<string[]>([]);

    const load = async (): Promise<void> => {
      const t0 = performance.now();
      report.value = await sdk.call('report');
      elapsed.value = Math.round(performance.now() - t0);
      const fast = elapsed.value < 200;
      log.value.unshift(`${user.value}: ${elapsed.value}ms ${fast ? '⚡ cached' : '… built'} — stamp ${report.value.generatedAt.slice(11, 19)}`);
    };
    const bust = async (): Promise<void> => {
      await sdk.call('bust', { user: user.value });
      log.value.unshift(`${user.value}: cache busted — next load rebuilds`);
    };

    return { user, report, elapsed, log, load, bust };
  },
  template: `
    <main>
      <h1>09 · cache</h1>
      <p class="muted">An "expensive" per-user report (the handler sleeps ~600ms). The first load builds it; loads within the TTL (8s) are served from cache — fast, with the same timestamp. After the TTL the next load rebuilds. "Bust" clears that user's entry.</p>

      <div class="card">
        <div class="row">
          <input v-model="user" placeholder="user" />
          <button @click="load">Load report</button>
          <button @click="bust">Bust cache</button>
        </div>
        <div v-if="report" class="row">
          <code>{{ report.user }}</code> · value <code>{{ report.value }}</code> · built <code>{{ report.generatedAt.slice(11, 19) }}</code> · <span :class="{ muted: elapsed >= 200 }">{{ elapsed }}ms</span>
        </div>
        <p class="muted">Tip: switch the user to see a separate cache (vary). Check the <code>X-Cache</code> response header in devtools.</p>
      </div>

      <div class="card">
        <strong>Log</strong>
        <ul><li v-for="(l, i) in log" :key="i"><code>{{ l }}</code></li></ul>
      </div>

      <nav class="muted" style="margin-top:1.5rem">
        <a href="/docs/swagger">Swagger</a><a href="/docs/openapi.json">OpenAPI</a>
      </nav>
    </main>`,
}).mount('#app');
