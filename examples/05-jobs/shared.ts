/**
 * Shared spec for a "compute jobs" dashboard backed by `@ayepi/work`.
 *
 * The user enqueues a labelled job (`{ label, n }`); the server runs it in the background
 * on `@ayepi/work`'s bundled in-memory backend, emitting progress over ayepi WS events as
 * it works, then stores the result. This file is the single source of truth — the client
 * imports it **type-only**, so neither `@ayepi/work` nor zod reach the browser.
 */
import { z } from 'zod';
import { spec, endpoint } from '@ayepi/core';

/** Wire view of a job (what `listJobs` returns and the UI renders). */
export const Job = z.object({
  id: z.string(),
  label: z.string(),
  pct: z.number(),
  status: z.enum(['running', 'done']),
  result: z.number().nullable(),
});
export type Job = z.infer<typeof Job>;

export const api = spec({
  endpoints: {
    /** Kick off a background compute job; returns its id immediately (does not wait). */
    enqueue: endpoint({
      body: z.object({ label: z.string().min(1), n: z.number().int().min(1).max(40) }),
      response: z.object({ jobId: z.string() }),
      doc: { summary: 'Enqueue a background compute job', tags: ['jobs'] },
    }),

    /** Snapshot of every known job with its live progress + result. */
    listJobs: endpoint({
      method: 'GET',
      response: z.array(Job),
      doc: { summary: 'List jobs with progress + results', tags: ['jobs'] },
    }),
  },

  events: {
    /** Per-job live updates (parameterized channel): subscribers pick a `jobId`. */
    jobProgress: {
      params: z.object({ jobId: z.string() }),
      data: z.object({ pct: z.number(), result: z.number().nullable() }),
      doc: { summary: 'Live progress + (on completion) result for a job' },
    },
  },
});
