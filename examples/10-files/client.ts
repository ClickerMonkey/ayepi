/**
 * Single-file Vue client. Uploads and downloads go **straight to the presigned URLs** —
 * never through the typed `sdk.call` path. The flow for an upload is: `presignUpload` →
 * `PUT` the bytes to the returned `/_files?t=…` URL → refresh the list. A download mints a
 * presigned `GET` URL and either fetches its text (View) or hands it to the browser (Open).
 *
 * Pick a file to stream its bytes, or just type some text — either way the body is `PUT`
 * directly to disk on the server.
 */
import { createApp, ref } from 'vue';
import { client } from '@ayepi/core/client';
import manifest from './manifest.gen';
import type { api, StoredFile } from './shared';

const sdk = client<typeof api>({ baseUrl: location.origin, manifest });

createApp({
  setup() {
    const key = ref('notes/hello.txt');
    const text = ref('hello from ayepi/files');
    const picked = ref<File | null>(null);
    const files = ref<StoredFile[]>([]);
    const viewing = ref<{ key: string; body: string } | null>(null);
    const log = ref<string[]>([]);
    const note = (m: string): void => void log.value.unshift(m);

    const refresh = async (): Promise<void> => {
      files.value = (await sdk.call('listFiles')).files;
    };

    const onPick = (e: Event): void => {
      const f = (e.target as HTMLInputElement).files?.[0] ?? null;
      picked.value = f;
      if (f) {key.value = f.name;}
    };

    const upload = async (): Promise<void> => {
      const file = picked.value;
      const body: BodyInit = file ?? text.value;
      const contentType = file ? file.type || 'application/octet-stream' : 'text/plain';
      const { url } = await sdk.call('presignUpload', { key: key.value, contentType });
      const res = await fetch(url, { method: 'PUT', body }); // bytes stream straight to the signed PUT
      note(res.ok ? `uploaded ${key.value} (${file ? `${file.size}b file` : 'text'})` : `upload failed: ${res.status}`);
      picked.value = null;
      await refresh();
    };

    const view = async (k: string): Promise<void> => {
      const { url } = await sdk.call('presignDownload', { key: k });
      viewing.value = { key: k, body: await (await fetch(url)).text() };
    };
    const open = async (k: string): Promise<void> => {
      const { url } = await sdk.call('presignDownload', { key: k });
      window.open(url, '_blank'); // the browser streams the download from the signed GET
    };
    const remove = async (k: string): Promise<void> => {
      await sdk.call('removeFile', { key: k });
      note(`deleted ${k}`);
      if (viewing.value?.key === k) {viewing.value = null;}
      await refresh();
    };

    void refresh();
    return { key, text, files, viewing, log, onPick, upload, view, open, remove };
  },
  template: `
    <main>
      <h1>10 · files</h1>
      <p class="muted">A presigned-URL file store on <code>@ayepi/files</code> (filesystem). The server only mints short-lived signed URLs; the bytes <code>PUT</code>/<code>GET</code> straight to <code>/_files?t=…</code>, streaming to and from disk.</p>

      <div class="card">
        <strong>Upload</strong>
        <div class="row"><label>key</label><input v-model="key" style="flex:1" /></div>
        <div class="row"><label>text</label><textarea v-model="text" rows="2" style="flex:1" placeholder="…or pick a file →"></textarea></div>
        <div class="row"><input type="file" @change="onPick" /><button @click="upload">Upload (presigned PUT)</button></div>
      </div>

      <div class="card">
        <strong>Stored files</strong>
        <p v-if="!files.length" class="muted">none yet — upload one above.</p>
        <div v-for="f in files" :key="f.key" class="row">
          <code style="flex:1">{{ f.key }}</code>
          <span class="muted">{{ f.size }}b{{ f.contentType ? ' · ' + f.contentType : '' }}</span>
          <button @click="view(f.key)">View</button>
          <button @click="open(f.key)">Open</button>
          <button @click="remove(f.key)">Delete</button>
        </div>
      </div>

      <div v-if="viewing" class="card">
        <strong>{{ viewing.key }}</strong>
        <pre>{{ viewing.body }}</pre>
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
