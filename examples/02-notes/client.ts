/** Single-file Vue client: list / create / edit / delete / search, with typed errors. */
import { createApp, ref, onMounted } from 'vue';
import { client, ApiError } from '@ayepi/core/client';
import manifest from './manifest.gen'; // plain zod-free manifest — a normal import the bundler tree-shakes; no fetch, no zod
import type { api, Note } from './shared'; // type-only

const sdk = client<typeof api>({ baseUrl: location.origin, manifest });

createApp({
  setup() {
    const notes = ref<Note[]>([]);
    const q = ref('');
    const title = ref('');
    const body = ref('');
    const error = ref('');

    const refresh = async (): Promise<void> => {
      notes.value = q.value.trim() ? await sdk.call('searchNotes', { q: q.value.trim() }) : await sdk.call('listNotes');
    };

    const create = async (): Promise<void> => {
      error.value = '';
      if (!title.value.trim()) {
        error.value = 'title is required';
        return;
      }
      await sdk.call('createNote', { title: title.value.trim(), body: body.value });
      title.value = '';
      body.value = '';
      await refresh();
    };

    const remove = async (id: string): Promise<void> => {
      try {
        await sdk.call('deleteNote', { id });
        await refresh();
      } catch (err) {
        error.value = err instanceof ApiError ? (err.data as { reason: string }).reason : String(err);
      }
    };

    onMounted(refresh);
    return { notes, q, title, body, error, refresh, create, remove };
  },
  template: `
    <main>
      <h1>02 · notes</h1>
      <p class="muted">CRUD over typed endpoints — path params, query search, validation, and a declared 404.</p>

      <div class="row">
        <input v-model="q" placeholder="search…" @input="refresh" style="flex:1" />
      </div>

      <div class="card">
        <div class="row"><input v-model="title" placeholder="title" style="flex:1" /></div>
        <div class="row"><textarea v-model="body" placeholder="body" rows="2" style="flex:1"></textarea></div>
        <div class="row"><button @click="create">Add note</button><span v-if="error" class="err">{{ error }}</span></div>
      </div>

      <div v-for="n in notes" :key="n.id" class="card">
        <div class="row" style="justify-content:space-between">
          <strong>{{ n.title }}</strong>
          <button @click="remove(n.id)">delete</button>
        </div>
        <div v-if="n.body" style="white-space:pre-wrap">{{ n.body }}</div>
        <small class="muted">{{ n.id }} · {{ new Date(n.createdAt).toLocaleString() }}</small>
      </div>
      <p v-if="!notes.length" class="muted">no notes</p>

      <nav class="muted" style="margin-top:1rem"><a href="/docs/swagger">Swagger</a><a href="/docs/redoc">ReDoc</a></nav>
    </main>`,
}).mount('#app');
