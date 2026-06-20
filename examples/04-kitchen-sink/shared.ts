/**
 * Shared spec for a small "jobs" dashboard that exercises most of ayepi:
 * JWT bearer auth (`@ayepi/auth`) over **both HTTP and WebSocket**, telemetry
 * (`@ayepi/otel` + `@ayepi/log`), a param **loader** (load-or-404), a declared typed
 * error, multipart **file upload**, a typed **item stream**, and **auth-guarded events**.
 *
 * This file is **frontend-safe**: it declares only middleware **defs** (the contract —
 * contributed context, deps, docs) and the spec. No secret, no in-memory store, and no
 * `node:crypto` reach it — the client imports it **type-only**, and the impls (secrets,
 * the store, the JWT crypto) live in `server.ts`, bound via the packages' `.server` /
 * `/server` entries. Auth is the same JWT everywhere: HTTP sends `Authorization: Bearer
 * <jwt>`; the **ws** connection carries the token as an `?access_token=` query param.
 */
import { z } from 'zod';
import { spec, middleware, ctx, use } from '@ayepi/core';
import { bearerAuth } from '@ayepi/auth';
import { telemetry } from '@ayepi/otel';

export const Job = z.object({ id: z.string(), title: z.string(), pct: z.number() });
export type Job = z.infer<typeof Job>;

/** Server-side record (richer than the wire `Job`) — the type the loader's `ctx.job` carries. */
export interface JobRecord {
  id: string;
  title: string;
  pct: number;
  log: string[];
}

/** Custom JWT claims carried by the token: who you are and your role. */
export const Claims = z.object({ user: z.string(), role: z.enum(['user', 'admin']) });
export type Claims = z.infer<typeof Claims>;

/** The authenticated user the server's `toUser` maps the validated claims to (flows to handlers as `user`). */
export interface User {
  id: string;
  role: 'user' | 'admin';
}

/** Telemetry **def**: a no-context middleware; its behaviour (logging, request-id echo) is bound server-side. */
export const tel = telemetry();

/**
 * Auth **def**: contributes `{ user, jwt, signToken }` and the `bearerAuth` security scheme.
 * The secret, claims schema, and `toUser` mapper are supplied by `bearerAuth.server` in `server.ts`.
 */
export const auth = bearerAuth<Claims, User>();

/** Loader **def**: owns `:jobId`, requires auth, contributes `ctx.job: JobRecord` (loaded — or 404 — server-side). */
export const jobLoader = middleware.loader('jobId', z.string(), { provides: ctx<{ job: JobRecord }>(), requires: [auth] });

export const api = spec({
  endpoints: {
    /** Public: exchange a user for a signed JWT bearer token; declares a typed 403. */
    login: tel.endpoint({
      body: z.object({ user: z.string().min(1) }),
      response: z.object({ token: z.string() }),
      errors: { 403: z.object({ reason: z.string() }) },
      doc: { summary: 'Log in (returns a signed JWT bearer token)', tags: ['auth'] },
    }),

    ...use(tel, auth).group({
      /** Who am I (proves the bearer token works) — returns the mapped user fields. */
      me: { method: 'GET', response: z.object({ user: z.string(), role: z.enum(['user', 'admin']) }), doc: { summary: 'Current user', tags: ['auth'] } },

      /** Create a job (201); the server starts a background worker emitting progress + log. */
      createJob: { body: z.object({ title: z.string().min(1) }), response: Job, doc: { summary: 'Start a job', tags: ['jobs'] } },

      listJobs: { method: 'GET', response: z.array(Job), doc: { summary: 'List jobs', tags: ['jobs'] } },

      /** Multipart upload — files force httpOnly; the file + a body field merge into one payload. */
      uploadAttachment: {
        files: { file: z.file() },
        body: z.object({ jobId: z.string() }),
        response: z.object({ name: z.string(), size: z.number() }),
        doc: { summary: 'Attach a file to a job', tags: ['jobs'] },
      },
    }),

    /** Loader-backed routes under /jobs/:jobId — `ctx.job` is pre-loaded (or 404). */
    ...use(tel, jobLoader).path('/jobs/:jobId').group({
      jobStatus: { method: 'GET', path: '/status', response: Job, doc: { summary: 'Job status', tags: ['jobs'] } },
      streamLog: {
        method: 'GET',
        path: '/log',
        streamOut: z.object({ line: z.string() }),
        doc: { summary: 'Stream a job log (NDJSON / WS / SSE)', tags: ['jobs'] },
      },
    }),
  },

  events: {
    /** Per-job progress (parameterized channel) — `guard: [auth]` means the ws connection must authenticate to subscribe. */
    jobProgress: { params: z.object({ jobId: z.string() }), data: z.object({ pct: z.number() }), guard: [auth], doc: { summary: 'Job progress %' } },
    /** Broadcast notice (no params) — also auth-guarded. */
    systemNotice: { data: z.object({ msg: z.string() }), guard: [auth], doc: { summary: 'System-wide notice' } },
  },
});
