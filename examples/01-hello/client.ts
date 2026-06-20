/** Single-file Vue client. Fetches the manifest, builds a typed sdk, calls the API. */
import { createApp, ref } from 'vue';
import { client } from '@ayepi/core/client';
import manifest from './manifest.gen'; // plain zod-free manifest — a normal import the bundler tree-shakes; no fetch, no zod
import type { api } from './shared'; // type-only — erased at build time

const sdk = client<typeof api>({ baseUrl: location.origin, manifest });

createApp({
  setup() {
    const name = ref('world');
    const message = ref('');
    const serverTime = ref('');

    const greet = async (): Promise<void> => {
      message.value = (await sdk.call('greet', { name: name.value })).message; // fully typed call
    };
    const getTime = async (): Promise<void> => {
      serverTime.value = (await sdk.call('time')).iso;
    };

    return { name, message, serverTime, greet, getTime };
  },
  template: `
    <main>
      <h1>01 · hello</h1>
      <p class="muted">The smallest ayepi app — a typed HTTP call from a Vue client.</p>

      <div class="row">
        <input v-model="name" placeholder="your name" @keyup.enter="greet" />
        <button @click="greet">Greet</button>
      </div>
      <p v-if="message" class="card">{{ message }}</p>

      <div class="row">
        <button @click="getTime">Get server time</button>
        <span v-if="serverTime" class="muted">{{ serverTime }}</span>
      </div>

      <nav class="muted" style="margin-top:1.5rem">
        <a href="/docs/swagger">Swagger</a><a href="/docs/redoc">ReDoc</a><a href="/docs/openapi.json">OpenAPI</a>
      </nav>
    </main>`,
}).mount('#app');
