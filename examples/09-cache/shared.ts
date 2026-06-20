/**
 * The frontend-safe spec, shared by the server and the typed client.
 *
 * One **expensive, per-user** `GET /report` endpoint guarded by the
 * [`@ayepi/cache`](../../packages/cache) middleware, plus a `bust` mutation that
 * invalidates a user's cached report. The cache **def** lives here (frontend-safe); the
 * policy (`ttl`, `vary`, store) is bound on the server in `server.ts`.
 */
import { z } from 'zod';
import { spec, endpoint, middleware, ctx } from '@ayepi/core';
import { cache } from '@ayepi/cache';

export const Report = z.object({
  user: z.string(),
  value: z.number(),
  /** ISO timestamp of when the report was *built* — unchanged while a response is served from cache. */
  generatedAt: z.string(),
});
export type Report = z.infer<typeof Report>;

/** Identify the caller from an `x-user` header — a stand-in for real auth, so `vary` has a typed user. */
export const userMw = middleware('user', { provides: ctx<{ user: string }>() });

/** The cache def — attached to `report`. `requires: [userMw]` types `io.ctx.user` in the server-side `vary`. */
export const cached = cache({ requires: [userMw] });

export const api = spec({
  endpoints: {
    ...cached.group({
      /** An "expensive" per-user report (the handler sleeps) — cached for a few seconds. */
      report: { method: 'GET', response: Report },
    }),
    /** Invalidate a user's cached report (e.g. after they changed something it depends on). */
    bust: endpoint({ body: z.object({ user: z.string() }), response: z.object({ ok: z.boolean() }) }),
  },
});
