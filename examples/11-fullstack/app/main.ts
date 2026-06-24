/**
 * # 11 · fullstack — browser app (it only ever *uses* the client)
 *
 * A single-file Vue dashboard built by Vite for the **browser** target. It imports:
 *
 * - `@ayepi/core/client` — the typed `client`/`wsTransport`,
 * - `@ayepi/codec` — `parse` (via `shared/domain`), browser-safe, to decode the snapshot,
 * - `./manifest.gen` — the generated **zod-free** routing manifest (plain data),
 * - `../shared/spec` — **type-only**, so zod and every server middleware are erased.
 *
 * Nothing server-side (auth/rate/work/cache/files/node/...) reaches this bundle — which is
 * exactly what the separate Vite browser build verifies.
 */
import { createApp, ref } from 'vue';
import { client, wsTransport, ApiError } from '@ayepi/core/client';
import { decodeSnapshot, jobLabel } from '../shared/domain';
import manifest from './manifest.gen';
import type { api } from '../shared/spec';

const sdk = client<typeof api>({
  baseUrl: location.origin,
  manifest,
  ws: wsTransport(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`),
});

interface JobRow {
  id: string;
  title: string;
  pct: number;
  done: boolean;
  result: number | null;
}

createApp({
  setup() {
    const userName = ref('demo');
    const token = ref('');
    const role = ref('');
    const authError = ref('');
    const pings = ref<string[]>([]);
    const reportLine = ref('');
    const n = ref(5);
    const jobs = ref<JobRow[]>([]);
    const watching = new Set<string>();
    const snapNow = ref('');
    const snapCounts = ref<[string, number][]>([]);
    const snapRoles = ref<string[]>([]);
    const tools = ref<{ name: string; description: string }[]>([]);
    const fileKey = ref('hello.txt');
    const fileText = ref('hello from the browser');
    const files = ref<{ key: string; size: number }[]>([]);

    const authOpts = () => ({ headers: { authorization: `Bearer ${token.value}` } });

    const login = async (): Promise<void> => {
      authError.value = '';
      try {
        const res = await sdk.call('login', { user: userName.value });
        token.value = res.token;
        role.value = res.role;
        await Promise.all([refreshJobs(), loadTools(), loadSnapshot(), listFiles()]);
      } catch (err) {
        authError.value = err instanceof ApiError ? (err.data as { reason: string }).reason : String(err);
      }
    };

    const ping = async (): Promise<void> => {
      try {
        const res = await sdk.call('ping');
        pings.value.unshift(`pong — ${res.remaining} left in window`);
      } catch (err) {
        pings.value.unshift(err instanceof ApiError ? `HTTP ${err.status} — rate limited` : String(err));
      }
      pings.value = pings.value.slice(0, 8);
    };

    const loadReport = async (): Promise<void> => {
      const r = await sdk.call('report', { headers: { 'x-user': userName.value } });
      reportLine.value = `value ${r.value} · built ${r.generatedAt} (cached for a few seconds)`;
    };
    const bust = async (): Promise<void> => {
      await sdk.call('bust', { user: userName.value });
      reportLine.value = 'cache busted — next refresh rebuilds';
    };

    const watchJob = (id: string): void => {
      if (watching.has(id)) return;
      watching.add(id);
      sdk.on('jobProgress', { jobId: id }, ({ pct, result }) => {
        const j = jobs.value.find((x) => x.id === id);
        if (j) {
          j.pct = pct;
          j.done = pct >= 100;
          j.result = result;
        }
      });
    };
    const refreshJobs = async (): Promise<void> => {
      const list = await sdk.call('listJobs', authOpts());
      jobs.value = list.map((j) => ({ ...j, result: null }));
      for (const j of jobs.value) watchJob(j.id);
    };
    const enqueue = async (): Promise<void> => {
      const { jobId } = await sdk.call('enqueue', { n: n.value }, authOpts());
      jobs.value.unshift({ id: jobId, title: jobLabel(n.value), pct: 0, done: false, result: null });
      watchJob(jobId);
    };

    const loadSnapshot = async (): Promise<void> => {
      const { codec } = await sdk.call('snapshot', authOpts());
      const value = decodeSnapshot(codec); // real Date/Map/Set, decoded client-side
      snapNow.value = value.now instanceof Date ? value.now.toISOString() : String(value.now);
      snapCounts.value = [...value.counts.entries()];
      snapRoles.value = [...value.roles];
    };
    const loadTools = async (): Promise<void> => {
      tools.value = await sdk.call('tools', authOpts());
    };

    const listFiles = async (): Promise<void> => {
      const res = await sdk.call('listFiles', authOpts());
      files.value = res.files.map((f) => ({ key: f.key, size: f.size }));
    };
    const upload = async (): Promise<void> => {
      const { url } = await sdk.call('presignUpload', { key: fileKey.value, contentType: 'text/plain' }, authOpts());
      await fetch(url, { method: 'PUT', body: fileText.value }); // bytes stream straight to /_files
      await listFiles();
    };
    const download = async (key: string): Promise<void> => {
      const { url } = await sdk.call('presignDownload', { key }, authOpts());
      window.open(url, '_blank');
    };
    const remove = async (key: string): Promise<void> => {
      await sdk.call('removeFile', { key }, authOpts());
      await listFiles();
    };

    return {
      userName, token, role, authError, login,
      pings, ping,
      reportLine, loadReport, bust,
      n, jobs, enqueue,
      snapNow, snapCounts, snapRoles, loadSnapshot,
      tools,
      fileKey, fileText, files, upload, download, remove,
    };
  },
  template: `
    <main>
      <h1>11 · fullstack</h1>
      <p class="muted">app · shared · api — every @ayepi package, built separately for browser & node by Vite.</p>

      <div class="card">
        <strong>Login</strong> <span class="muted">(@ayepi/auth · JWT)</span>
        <div class="row">
          <label>user <input v-model="userName" @keyup.enter="login" /></label>
          <button @click="login">Log in</button>
          <span class="muted">try <code>blocked</code> for a typed 403</span>
        </div>
        <p v-if="role" class="muted">signed in as <strong>{{ userName }}</strong> — role <code>{{ role }}</code></p>
        <p v-if="authError" class="err">{{ authError }}</p>
      </div>

      <template v-if="token">
        <div class="card">
          <strong>Ping</strong> <span class="muted">(@ayepi/rate · 5 per 10s)</span>
          <div class="row"><button @click="ping">Ping</button><span class="muted">click 6+ times fast to trip the 429</span></div>
          <div v-for="(p, i) in pings" :key="i" :class="{ err: p.includes('rate limited') }">• {{ p }}</div>
        </div>

        <div class="card">
          <strong>Report</strong> <span class="muted">(@ayepi/cache over @ayepi/redis · per-user)</span>
          <div class="row"><button @click="loadReport">Load</button><button @click="bust">Bust</button></div>
          <p class="muted">{{ reportLine || 'load it twice quickly — the timestamp stays put while cached' }}</p>
        </div>

        <div class="card">
          <strong>Jobs</strong> <span class="muted">(@ayepi/work · chunked compute, live events)</span>
          <div class="row">
            <label>n <input type="number" v-model.number="n" min="1" max="50" style="width:5rem" /></label>
            <button @click="enqueue">Enqueue</button>
          </div>
          <div v-for="j in jobs" :key="j.id" style="margin:0.4rem 0">
            <div class="row" style="justify-content:space-between">
              <span><strong>{{ j.title }}</strong> <span class="muted">{{ j.id }}</span></span>
              <span class="muted" v-if="j.done && j.result != null">sum = {{ j.result }}</span>
            </div>
            <progress :value="j.pct" max="100" style="width:100%"></progress> {{ j.pct }}%
          </div>
          <p v-if="!jobs.length" class="muted">no jobs yet — enqueue one</p>
        </div>

        <div class="card">
          <strong>Files</strong> <span class="muted">(@ayepi/files · presigned upload/download)</span>
          <div class="row">
            <label>key <input v-model="fileKey" style="width:9rem" /></label>
            <label>text <input v-model="fileText" style="width:14rem" /></label>
            <button @click="upload">Upload</button>
          </div>
          <div v-for="f in files" :key="f.key" class="row" style="justify-content:space-between">
            <span><code>{{ f.key }}</code> <span class="muted">{{ f.size }} bytes</span></span>
            <span><button @click="download(f.key)">Download</button> <button @click="remove(f.key)">Delete</button></span>
          </div>
          <p v-if="!files.length" class="muted">no files yet — upload one</p>
        </div>

        <div class="card">
          <strong>Snapshot</strong> <span class="muted">(@ayepi/codec · Date + Map + Set over plain JSON)</span>
          <div class="row"><button @click="loadSnapshot">Refresh</button></div>
          <pre>now (Date):  {{ snapNow }}
counts (Map): {{ snapCounts.map(([k, v]) => k + '=' + v).join(', ') }}
roles (Set):  {{ snapRoles.join(', ') }}</pre>
        </div>

        <div class="card">
          <strong>Tools</strong> <span class="muted">(@ayepi/mcp · this API as agent tools)</span>
          <div v-for="t in tools" :key="t.name"><code>{{ t.name }}</code> — <span class="muted">{{ t.description }}</span></div>
          <p v-if="!tools.length" class="muted">none</p>
        </div>
      </template>

      <nav class="muted" style="margin-top:1.5rem">
        <a href="/docs/swagger">Swagger</a><a href="/docs/redoc">ReDoc</a><a href="/docs/asyncapi">AsyncAPI</a>
      </nav>
    </main>`,
}).mount('#app');
