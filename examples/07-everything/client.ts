/**
 * # 07 · everything — single-file Vue client (the grand-tour dashboard)
 *
 * Five panels, one per package:
 *
 * - **Login** (`@ayepi/auth`)  — get a JWT, see the role; try `blocked` for a typed 403.
 * - **Ping** (`@ayepi/rate`)   — spam it past 5/10s to watch the 429 surface.
 * - **Jobs** (`@ayepi/work`)   — enqueue → live progress bar via the `jobProgress` event.
 * - **Snapshot** (`@ayepi/codec`) — fetch a codec string, `parse` it into a real Date/Map/Set.
 * - **Tools** (`@ayepi/mcp`)   — list this API as agent tools.
 *
 * The spec is imported **type-only** and the manifest is plain data, so no zod ships here.
 * `@ayepi/codec` IS in the bundle on purpose — it's browser-safe and zero-dep.
 */
import { createApp, ref, onMounted } from 'vue';
import { client, wsTransport, ApiError } from '@ayepi/core/client';
import { parse } from '@ayepi/codec';
import manifest from './manifest.gen'; // plain zod-free manifest — tree-shaken; no zod
import type { api } from './shared'; // type-only — erased at build time

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
interface Tool {
  name: string;
  description: string;
}

createApp({
  setup() {
    // --- auth ---
    const userName = ref('demo');
    const token = ref('');
    const role = ref('');
    const authError = ref('');

    // --- rate ---
    const pings = ref<string[]>([]);

    // --- work ---
    const n = ref(5);
    const jobs = ref<JobRow[]>([]);
    const watching = new Set<string>();

    // --- codec ---
    const snapNow = ref('');
    const snapCounts = ref<[string, number][]>([]);
    const snapRoles = ref<string[]>([]);

    // --- mcp ---
    const tools = ref<Tool[]>([]);

    const authOpts = () => ({ headers: { authorization: `Bearer ${token.value}` } });

    const login = async (): Promise<void> => {
      authError.value = '';
      try {
        const res = await sdk.call('login', { user: userName.value });
        token.value = res.token;
        role.value = res.role;
        await Promise.all([refreshJobs(), loadTools(), loadSnapshot()]);
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
      jobs.value.unshift({ id: jobId, title: `compute n=${n.value}`, pct: 0, done: false, result: null });
      watchJob(jobId);
    };

    const loadSnapshot = async (): Promise<void> => {
      const { codec } = await sdk.call('snapshot', authOpts());
      // The plain JSON field is a @ayepi/codec string; parse it into real rich types.
      const value = parse(codec) as { now: Date; counts: Map<string, number>; roles: Set<string> };
      snapNow.value = value.now instanceof Date ? value.now.toISOString() : String(value.now);
      snapCounts.value = [...value.counts.entries()]; // a real Map
      snapRoles.value = [...value.roles]; // a real Set
    };

    const loadTools = async (): Promise<void> => {
      tools.value = await sdk.call('tools', authOpts());
    };

    onMounted(() => void 0);

    return {
      userName, token, role, authError, login,
      pings, ping,
      n, jobs, enqueue,
      snapNow, snapCounts, snapRoles, loadSnapshot,
      tools,
    };
  },
  template: `
    <main>
      <h1>07 · everything</h1>
      <p class="muted">A grand tour: auth · rate-limit · work · codec · mcp · telemetry · updown — every @ayepi package in one dashboard.</p>

      <div class="card">
        <strong>Login</strong> <span class="muted">(@ayepi/auth · JWT)</span>
        <div class="row">
          <label>user <input v-model="userName" @keyup.enter="login" /></label>
          <button @click="login">Log in</button>
          <span class="muted">try <code>blocked</code> for a typed 403</span>
        </div>
        <p v-if="role" class="muted">signed in as <strong>{{ userName }}</strong> — role <code>{{ role }}</code></p>
        <p v-if="token" class="muted">token: <code>{{ token.slice(0, 24) }}…</code></p>
        <p v-if="authError" class="err">{{ authError }}</p>
      </div>

      <template v-if="token">
        <div class="card">
          <strong>Ping</strong> <span class="muted">(@ayepi/rate · 5 per 10s)</span>
          <div class="row">
            <button @click="ping">Ping</button>
            <span class="muted">click fast 6+ times to trip the 429</span>
          </div>
          <div v-for="(p, i) in pings" :key="i" :class="{ err: p.includes('rate limited') }">• {{ p }}</div>
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
          <strong>Snapshot</strong> <span class="muted">(@ayepi/codec · Date + Map + Set over plain JSON)</span>
          <div class="row"><button @click="loadSnapshot">Refresh</button></div>
          <p class="muted">A rich server value travels as a codec string in a JSON field, then is parsed back client-side:</p>
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
