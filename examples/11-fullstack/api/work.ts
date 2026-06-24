/**
 * # 11 · fullstack — the work engine (`@ayepi/work`)
 *
 * A `compute` work type runs a chunked sum, emitting a `jobProgress` event per slice. The
 * engine runs on whichever backend `selectBackends()` chose (memory / redis / sqs). The
 * handler has no request context, so it emits through the server's late-bound `emit`.
 */
import { defineWork, createWork } from '@ayepi/work';
import type { EmitFn } from '@ayepi/core';
import { jobLabel, pctOf } from '../shared/domain';
import type { api, JobRecord } from '../shared/spec';
import { selectBackends } from './backends';

/** The in-memory job store (server-side records, richer than the wire shape). */
export const jobs = new Map<string, JobRecord>();

/** Late-bound server emit — assigned once the server exists, used by the detached handler. */
let emit: EmitFn<typeof api> | undefined;
/** Wire the server's `emit` into the engine (called from `app.ts` after the server is built). */
export const bindEmit = (fn: EmitFn<typeof api>): void => void (emit = fn);

/** A chunked compute job: sum 1..(n·1000) in `n` slices, emitting progress between slices. */
export const compute = defineWork('compute', async (input: { jobId: string; n: number }, ctx) => {
  const rec = jobs.get(input.jobId);
  let sum = 0;
  for (let i = 1; i <= input.n; i++) {
    for (let k = (i - 1) * 1000 + 1; k <= i * 1000; k++) sum += k;
    const pct = pctOf(i, input.n);
    const done = i === input.n;
    if (rec) {
      rec.pct = pct;
      rec.done = done;
      rec.result = done ? sum : null;
    }
    emit?.('jobProgress', { jobId: input.jobId }, { pct, result: done ? sum : null });
    await new Promise((r) => setTimeout(r, 150));
  }
  return ctx.result(sum);
});

const backend = selectBackends();

/** A human label for the chosen backend (logged at startup). */
export const backendLabel = backend.label;
/** The response-cache store (a `@ayepi/redis` cache over the stand-in) — used by `app.ts`. */
export const cacheStore = backend.cacheStore;
/** Build a job title (shared with the client so the label can't drift). */
export const titleFor = jobLabel;

/** The work engine — started/stopped by updown (not on import). */
export const work = createWork({ work: [compute] as const, autoStart: false, ...backend.work });
