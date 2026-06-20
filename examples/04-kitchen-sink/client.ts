/** Single-file Vue client: JWT auth over **HTTP and ws**, live events, streaming, upload. */
import { createApp, ref } from 'vue';
import { client, wsTransport, ApiError } from '@ayepi/core/client';
import manifest from './manifest.gen'; // plain zod-free manifest — a normal import the bundler tree-shakes; no fetch, no zod
import type { api, Job } from './shared'; // type-only

/** The bearer token, set on login. Module-scope so the sdk's `headers` + ws URL can read it. */
const token = ref('');

const sdk = client<typeof api>({
  baseUrl: location.origin,
  manifest,
  // every HTTP request carries the token once we have one (computed per request)
  headers: (): Record<string, string> => (token.value ? { authorization: `Bearer ${token.value}` } : {}),
  // the ws connection carries the token as a query param, resolved at each (re)connect —
  // browsers can't set headers on a ws handshake, so it rides the URL. We only connect
  // (lazily, on the first `sdk.on(...)`) after login, so the token is always present.
  ws: wsTransport(() => {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const q = token.value ? `?access_token=${encodeURIComponent(token.value)}` : '';
    return `${proto}://${location.host}/ws${q}`;
  }),
});

createApp({
  setup() {
    const user = ref('demo');
    const role = ref('');
    const error = ref('');
    const jobs = ref<Job[]>([]);
    const notices = ref<string[]>([]);
    const newTitle = ref('');
    const logFor = ref('');
    const logLines = ref<string[]>([]);
    const file = ref<File | null>(null);
    const watching = new Set<string>();

    const watchJob = (id: string): void => {
      if (watching.has(id)) {
        return;
      }
      watching.add(id);
      sdk.on('jobProgress', { jobId: id }, ({ pct }) => {
        const j = jobs.value.find((x) => x.id === id);
        if (j) {
          j.pct = pct;
        }
      });
    };

    const refresh = async (): Promise<void> => {
      jobs.value = await sdk.call('listJobs'); // token rides the global `headers`
      for (const j of jobs.value) {
        watchJob(j.id);
      }
    };

    const login = async (): Promise<void> => {
      error.value = '';
      try {
        token.value = (await sdk.call('login', { user: user.value })).token; // REST login → JWT
        const who = await sdk.call('me'); // proves the bearer token works over HTTP + surfaces the role
        role.value = who.role;
        // now authenticated: the guarded ws subscriptions connect with the token (query param)
        sdk.on('systemNotice', ({ msg }) => notices.value.unshift(msg));
        await refresh();
      } catch (err) {
        error.value = err instanceof ApiError ? (err.data as { reason: string }).reason : String(err);
      }
    };

    const createJob = async (): Promise<void> => {
      if (!newTitle.value.trim()) {
        return;
      }
      await sdk.call('createJob', { title: newTitle.value.trim() });
      newTitle.value = '';
      await refresh();
    };

    const streamLog = async (id: string): Promise<void> => {
      logFor.value = id;
      logLines.value = [];
      for await (const { line } of sdk.call('streamLog', { jobId: id })) {
        logLines.value.push(line); // arrives live as the worker appends
      }
    };

    const onFile = (e: Event): void => {
      file.value = (e.target as HTMLInputElement).files?.[0] ?? null;
    };
    const upload = async (id: string): Promise<void> => {
      if (!file.value) {
        return;
      }
      const res = await sdk.call('uploadAttachment', { file: file.value, jobId: id });
      notices.value.unshift(`uploaded ${res.name} (${res.size} bytes)`);
      file.value = null;
    };

    return { user, token, role, error, jobs, notices, newTitle, logFor, logLines, login, createJob, streamLog, onFile, upload };
  },
  template: `
    <main>
      <h1>04 · kitchen-sink</h1>
      <p class="muted">JWT auth (@ayepi/auth) over HTTP + ws + telemetry (@ayepi/otel + @ayepi/log) + loader + declared errors + upload + item streaming + auth-guarded live events.</p>

      <div v-if="!token" class="card">
        <div class="row">
          <label>user <input v-model="user" @keyup.enter="login" /></label>
          <button @click="login">Log in</button>
          <span class="muted">(try <code>admin</code> for the admin role, or <code>blocked</code> for a typed 403)</span>
        </div>
        <p v-if="error" class="err">{{ error }}</p>
      </div>

      <template v-else>
        <div class="row">
          <input v-model="newTitle" placeholder="new job title" @keyup.enter="createJob" />
          <button @click="createJob">Start job</button>
          <span class="muted">signed in as <code>{{ user }}</code> (role <code>{{ role }}</code>) · token + ws both authenticated</span>
        </div>

        <div v-for="j in jobs" :key="j.id" class="card">
          <div class="row" style="justify-content:space-between">
            <strong>{{ j.title }}</strong><span class="muted">{{ j.id }}</span>
          </div>
          <progress :value="j.pct" max="100" style="width:100%"></progress> {{ j.pct }}%
          <div class="row">
            <button @click="streamLog(j.id)">Stream log</button>
            <input type="file" @change="onFile" />
            <button @click="upload(j.id)">Upload</button>
          </div>
          <pre v-if="logFor === j.id && logLines.length">{{ logLines.join('\\n') }}</pre>
        </div>
        <p v-if="!jobs.length" class="muted">no jobs yet — start one above</p>

        <div class="card">
          <strong>Notices</strong> <span class="muted">(auth-guarded broadcast events over ws)</span>
          <div v-for="(n, i) in notices" :key="i">• {{ n }}</div>
          <p v-if="!notices.length" class="muted">none yet</p>
        </div>
      </template>

      <nav class="muted" style="margin-top:1rem"><a href="/docs/swagger">Swagger</a><a href="/docs/redoc">ReDoc</a><a href="/docs/asyncapi">AsyncAPI</a></nav>
    </main>`,
}).mount('#app');
