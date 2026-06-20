/**
 * Single-file Vue client. Each plugin has its own typed client, all sharing one
 * base URL + the app's manifest + a single login **token** (the seed of the
 * "plugin clients linked to a core client" idea). The `stats` plugin's endpoint is
 * hot-removed/re-added server-side, so its call blinks between a count and a
 * "(plugin uninstalled)" message — live, with no client reload.
 */
import { createApp, ref } from 'vue';
import { client } from '@ayepi/core/client';
import { ApiError } from '@ayepi/core';
import manifest from './manifest.gen'; // plain zod-free manifest of the whole running app
import type { authSpec } from './auth';
import type { notesSpec, Note } from './notes';
import type { statsSpec } from './stats';

// one shared token — log in once on the auth client, the notes client carries it
const token = ref('');

const authSdk = client<typeof authSpec>({ baseUrl: location.origin, manifest });
const notesSdk = client<typeof notesSpec>({ baseUrl: location.origin, manifest });
const statsSdk = client<typeof statsSpec>({ baseUrl: location.origin, manifest });

createApp({
  setup() {
    const user = ref('ada');
    const text = ref('');
    const list = ref<Note[]>([]);
    const statLine = ref('');
    const err = ref('');

    const login = async (): Promise<void> => {
      token.value = (await authSdk.call('login', { user: user.value })).token;
    };
    const refresh = async (): Promise<void> => {
      list.value = await notesSdk.call('listNotes');
    };
    const add = async (): Promise<void> => {
      err.value = '';
      try {
        await notesSdk.call('addNote', { token: token.value, text: text.value });
        text.value = '';
        await refresh();
      } catch (e) {
        err.value = e instanceof ApiError ? `${e.status} ${e.code}` : String(e);
      }
    };
    const getStats = async (): Promise<void> => {
      try {
        statLine.value = `${(await statsSdk.call('stats')).notes} notes`;
      } catch (e) {
        statLine.value = e instanceof ApiError && e.status === 404 ? '(stats plugin uninstalled — try again in a few seconds)' : String(e);
      }
    };

    void refresh();
    return { user, text, list, statLine, err, login, add, refresh, getStats, token };
  },
  template: `
    <main>
      <h1>08 · plugins</h1>
      <p class="muted">Three plugins (auth → notes → stats) installed into a running server. The <code>stats</code> plugin is hot-removed/re-added every ~12s — watch its call blink.</p>

      <div class="card">
        <div class="row">
          <input v-model="user" placeholder="user" @keyup.enter="login" />
          <button @click="login">Log in</button>
          <span v-if="token" class="muted">token: {{ token }}</span>
        </div>
      </div>

      <div class="card">
        <div class="row">
          <input v-model="text" placeholder="a note" @keyup.enter="add" :disabled="!token" />
          <button @click="add" :disabled="!token">Add note</button>
          <button @click="refresh">Refresh</button>
        </div>
        <p v-if="err" class="err">{{ err }}</p>
        <ul><li v-for="n in list" :key="n.id">{{ n.text }} <span class="muted">— {{ n.author }}</span></li></ul>
      </div>

      <div class="card">
        <div class="row"><button @click="getStats">Get stats (the hot plugin)</button><span class="muted">{{ statLine }}</span></div>
      </div>

      <nav class="muted" style="margin-top:1.5rem">
        <a href="/docs/swagger">Swagger</a><a href="/docs/openapi.json">OpenAPI</a>
      </nav>
    </main>`,
}).mount('#app');
