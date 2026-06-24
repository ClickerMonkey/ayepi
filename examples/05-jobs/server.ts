/**
 * Node server: a "compute jobs" dashboard backed by `@ayepi/work`.
 *
 * `enqueue` records a job and fires a background `compute` work item (it does **not** block
 * the HTTP response on the group result). The work handler does a slow, chunked computation
 * of `n` steps, reporting progress as it goes; a bridge updates a module-scoped `jobs` map
 * and re-emits each tick as an ayepi `jobProgress` WS event. On completion it stores the
 * result and emits a final 100% carrying that result.
 *
 * `@ayepi/work` is **server-only** — the client never imports it.
 */
import { implement, server } from '@ayepi/core';
import { defineWork, createWork } from '@ayepi/work';
import { updown } from '@ayepi/updown';
import { api, type Job } from './shared';
import { runExample } from '../_harness';

/** Server-side job record (the wire `Job` is the same shape here). */
const jobs = new Map<string, Job>();
let seq = 0;

/** Late-bound emitter: the ayepi `server` below supplies its `emit` once assembled. */
type Emit = (event: 'jobProgress', params: { jobId: string }, data: { pct: number; result: number | null }) => void;
let emit: Emit = () => {}; // no-op until wired (work won't fire before boot)

const setProgress = (jobId: string, pct: number, result: number | null): void => {
  const rec = jobs.get(jobId);
  if (rec) {
    rec.pct = pct;
    rec.result = result;
    rec.status = pct >= 100 ? 'done' : 'running';
  }
  emit('jobProgress', { jobId }, { pct, result });
};

/**
 * The background work: sum `1..n` one step at a time with a small delay, reporting progress
 * after each step, and **return** the final total. `input.jobId` ties it back to the record
 * the HTTP handler created so the bridge can emit per-job events.
 */
const compute = defineWork('compute', async (input: { jobId: string; n: number }, ctx) => {
  let total = 0;
  for (let step = 1; step <= input.n; step++) {
    total += step;
    await new Promise((r) => setTimeout(r, 120)); // simulate slow work
    const pct = Math.round((step / input.n) * 100);
    const done = step === input.n;
    setProgress(input.jobId, pct, done ? total : null); // live progress; result only on the final tick
  }
  return ctx.result(total);
});

// Bundled in-memory backend, zero-config. Started/stopped by the `@ayepi/updown` lifecycle below.
const work = createWork({ work: [compute] as const, autoStart: false });

const handlers = implement(api).handlers({
  enqueue: ({ data }) => {
    const jobId = `job-${++seq}`;
    jobs.set(jobId, { id: jobId, label: data.label, pct: 0, status: 'running', result: null });
    // Fire the background work and return immediately — don't await the group result.
    void work.enqueue(compute({ jobId, n: data.n }));
    return { jobId };
  },

  listJobs: () => [...jobs.values()],
});

const app = server(api, [handlers], {
  cors: { origin: '*' },
  docs: { info: { title: 'ayepi · 05 jobs', version: '1.0.0' } },
});

emit = app.emit as Emit; // wire the real emitter now that the server exists

/**
 * Lifecycle (`@ayepi/updown`): start the work engine before serving, and on SIGINT/SIGTERM
 * drain + stop it cleanly — no manual `process.once` signal wiring. The engine starts before
 * the HTTP listener (`http` depends on `work`); shutdown runs in reverse, stopping the engine.
 */
const lc = updown();

lc.register({
  name: 'work',
  up: () => {
    work.start();
  },
  // Request the engine stop on shutdown; don't await — the in-memory poll loop's stop() promise
  // stays pending under tsx, and we don't want it to wedge a graceful shutdown.
  post: () => {
    void work.stop();
  },
});

lc.register({
  name: 'http',
  deps: ['work'],
  up: () => {
    runExample({ app, clientEntry: new URL('./client.ts', import.meta.url), title: '05 · jobs', port: 3005 });
  },
});

await lc.up(); // startup order: work → http; SIGINT/SIGTERM tears the engine down gracefully
