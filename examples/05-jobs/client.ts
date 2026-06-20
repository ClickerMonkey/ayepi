/** Single-file Vue client: a compute-jobs dashboard with live progress bars over WS events. */
import { createApp, ref, onMounted } from 'vue';
import { client, wsTransport } from '@ayepi/core/client';
import manifest from './manifest.gen'; // plain zod-free manifest — a normal import the bundler tree-shakes; no fetch, no zod
import type { api, Job } from './shared'; // type-only

const sdk = client<typeof api>({
  baseUrl: location.origin,
  manifest,
  ws: wsTransport(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`),
});

createApp({
  setup() {
    const label = ref('demo');
    const n = ref(20);
    const jobs = ref<Job[]>([]);
    const watching = new Set<string>();

    // Subscribe to a job's live progress (idempotent per id).
    const watchJob = (id: string): void => {
      if (watching.has(id)) {
        return;
      }
      watching.add(id);
      sdk.on('jobProgress', { jobId: id }, ({ pct, result }) => {
        const j = jobs.value.find((x) => x.id === id);
        if (j) {
          j.pct = pct;
          j.result = result;
          j.status = pct >= 100 ? 'done' : 'running';
        }
      });
    };

    const refresh = async (): Promise<void> => {
      jobs.value = await sdk.call('listJobs');
      for (const j of jobs.value) {
        watchJob(j.id); // re-subscribe to anything already in flight
      }
    };

    const enqueue = async (): Promise<void> => {
      if (!label.value.trim()) {
        return;
      }
      const { jobId } = await sdk.call('enqueue', { label: label.value.trim(), n: n.value });
      await refresh();
      watchJob(jobId); // start watching the new job immediately
    };

    onMounted(refresh);

    return { label, n, jobs, enqueue };
  },
  template: `
    <main>
      <h1>05 · jobs</h1>
      <p class="muted">Background jobs on <code>@ayepi/work</code> (bundled in-memory backend) with live progress over WS events.</p>

      <div class="row">
        <label>label <input v-model="label" @keyup.enter="enqueue" /></label>
        <label>n <input type="number" v-model.number="n" min="1" max="40" style="width:5rem" /></label>
        <button @click="enqueue">Enqueue</button>
      </div>

      <div v-for="j in jobs" :key="j.id" class="card">
        <div class="row" style="justify-content:space-between">
          <strong>{{ j.label }}</strong><span class="muted">{{ j.id }}</span>
        </div>
        <progress :value="j.pct" max="100" style="width:100%"></progress> {{ j.pct }}%
        <div class="muted" v-if="j.status === 'done'">done ✓ — result: <code>{{ j.result }}</code></div>
        <div class="muted" v-else>running…</div>
      </div>
      <p v-if="!jobs.length" class="muted">no jobs yet — enqueue one above</p>

      <nav class="muted" style="margin-top:1rem"><a href="/docs/swagger">Swagger</a><a href="/docs/asyncapi">AsyncAPI</a></nav>
    </main>`,
}).mount('#app');
