/**
 * # 11 · fullstack — shared **spec** (the single source of truth)
 *
 * The frontend-safe contract shared by the Node **api** (which *implements* it) and the
 * browser **app** (which only ever imports it **type-only** and talks through the typed
 * client). Every companion package contributes a frontend-safe **def** here; the secrets,
 * policies, and stores are bound on the server in `api/`.
 *
 * - `@ayepi/auth`  — `auth` def: protected routes carry a JWT bearer token.
 * - `@ayepi/rate`  — `limit` def: `ping` is throttled (→ 429 when hammered).
 * - `@ayepi/otel`  — `tel` def: telemetry across the groups (`@ayepi/log` binds inside handlers).
 * - `@ayepi/cache` — `cached` def: `report` is cached per-user (the store is a `@ayepi/redis` cache server-side).
 * - `@ayepi/work`  — `enqueue` runs a chunked compute job, streaming the `jobProgress` event.
 * - `@ayepi/codec` — `snapshot` returns a codec string carrying a `Date`/`Map`/`Set` (see `domain.ts`).
 * - `@ayepi/mcp`   — `tools` projects this very spec as agent tools.
 * - `@ayepi/files` — `presign*` mint short-lived URLs; bytes stream straight to the file routes.
 *
 * Because the client imports this file type-only, none of the middleware — nor zod — reaches
 * the browser bundle.
 */
import { z } from 'zod';
import { spec, use, endpoint, middleware, ctx } from '@ayepi/core';
import { bearerAuth } from '@ayepi/auth';
import { rateLimit } from '@ayepi/rate';
import { telemetry } from '@ayepi/otel';
import { cache } from '@ayepi/cache';

/** Custom JWT claims carried by the token: who you are and your role. */
export const Claims = z.object({ user: z.string(), role: z.enum(['user', 'admin']) });
export type Claims = z.infer<typeof Claims>;

/** The authenticated user the server's `toUser` maps the validated claims to (flows to handlers as `user`). */
export interface User {
  id: string;
  role: 'user' | 'admin';
}

/** Server-side job record (richer than any wire shape) — the store itself lives in `api/`. */
export interface JobRecord {
  id: string;
  title: string;
  pct: number;
  result: number | null;
  done: boolean;
}

/** A per-user report (the value is rebuilt only on a cache miss/refresh). */
export const Report = z.object({
  user: z.string(),
  value: z.number(),
  /** ISO timestamp of when the report was *built* — unchanged while served from cache. */
  generatedAt: z.string(),
});
export type Report = z.infer<typeof Report>;

/** Metadata for one stored object (no body) — mirrors `@ayepi/files`' `FileInfo`. */
export const StoredFile = z.object({
  key: z.string(),
  size: z.number(),
  contentType: z.string().optional(),
  modifiedAt: z.number(),
});
export type StoredFile = z.infer<typeof StoredFile>;

/** Telemetry **def** (no context); request-id echo + logging are bound server-side. */
export const tel = telemetry();

/**
 * Auth **def**: contributes `{ user, jwt, signToken }` and the `bearerAuth` security scheme.
 * The secret, claims schema, and `toUser` mapper are supplied by `bearerAuth.server` in `api/`.
 */
export const auth = bearerAuth<Claims, User>();

/** Rate-limit **def**: contributes `{ ratelimit }`; the 5/10s policy + key are bound server-side. */
export const limit = rateLimit();

/** Identifies the caller from an `x-user` header (a stand-in for real auth) so the cache can `vary` per user. */
export const userMw = middleware('user', { provides: ctx<{ user: string }>() });

/** The cache **def** attached to `report`. `requires: [userMw]` types `io.ctx.user` in the server-side `vary`. */
export const cached = cache({ requires: [userMw] });

export const api = spec({
  endpoints: {
    /** Public: exchange a user for a JWT. `blocked` → typed 403. Telemetry only (no auth). */
    login: tel.endpoint({
      body: z.object({ user: z.string().min(1) }),
      response: z.object({ token: z.string(), role: z.enum(['user', 'admin']) }),
      errors: { 403: z.object({ reason: z.string() }) },
      doc: { summary: 'Log in (returns a signed JWT bearer token)', tags: ['auth'] },
    }),

    /** Rate-limited: telemetry + `rateLimit`. Hammer it past 5/10s → a 429. */
    ping: use(tel, limit).endpoint({
      method: 'GET',
      response: z.object({ pong: z.boolean(), remaining: z.number() }),
      doc: { summary: 'Ping (rate-limited: 5 per 10s)', tags: ['rate'] },
    }),

    /** Per-user report behind the `@ayepi/cache` middleware (store = a `@ayepi/redis` cache server-side). */
    ...cached.group({
      report: {
        method: 'GET',
        response: Report,
        doc: { summary: 'Expensive per-user report (cached)', tags: ['cache'] },
      },
    }),

    /** Invalidate a user's cached report. */
    bust: endpoint({
      body: z.object({ user: z.string() }),
      response: z.object({ ok: z.boolean() }),
      doc: { summary: 'Bust a user’s cached report', tags: ['cache'] },
    }),

    /** Everything behind the bearer token, all wrapped in telemetry. */
    ...use(auth, tel).group({
      /** Who am I (proves the bearer token works) — returns the mapped user fields. */
      me: {
        method: 'GET',
        response: z.object({ user: z.string(), role: z.enum(['user', 'admin']) }),
        doc: { summary: 'Current user', tags: ['auth'] },
      },

      /** Enqueue a chunked compute job on the work engine; emits `jobProgress` as it runs. */
      enqueue: {
        body: z.object({ n: z.number().int().min(1).max(50) }),
        response: z.object({ jobId: z.string() }),
        doc: { summary: 'Enqueue a chunked compute job (@ayepi/work)', tags: ['work'] },
      },

      /** List known jobs (server records, lightly projected for the wire). */
      listJobs: {
        method: 'GET',
        response: z.array(z.object({ id: z.string(), title: z.string(), pct: z.number(), done: z.boolean() })),
        doc: { summary: 'List jobs', tags: ['work'] },
      },

      /**
       * A codec-encoded snapshot. The HTTP wire is plain JSON, so the rich value (a `Date`,
       * a `Map`, a `Set`) travels as a `@ayepi/codec` **string** in a normal string field —
       * the client decodes it back into real `Date`/`Map`/`Set` (see `shared/domain.ts`).
       */
      snapshot: {
        method: 'GET',
        response: z.object({ codec: z.string() }),
        doc: { summary: 'A @ayepi/codec-encoded value (Date + Map + Set)', tags: ['codec'] },
      },

      /** This very spec as Model Context Protocol tools (one per endpoint). */
      tools: {
        method: 'GET',
        response: z.array(z.object({ name: z.string(), description: z.string(), inputSchema: z.unknown() })),
        doc: { summary: 'List this API as MCP agent tools (@ayepi/mcp)', tags: ['mcp'] },
      },

      /** Mint a short-lived presigned `PUT` URL the browser uploads its bytes straight to. */
      presignUpload: {
        body: z.object({ key: z.string().min(1), contentType: z.string().optional() }),
        response: z.object({ key: z.string(), url: z.string() }),
        doc: { summary: 'Presign a file upload (@ayepi/files)', tags: ['files'] },
      },

      /** Mint a short-lived presigned `GET` URL for a stored object (download / view). */
      presignDownload: {
        body: z.object({ key: z.string().min(1) }),
        response: z.object({ url: z.string() }),
        doc: { summary: 'Presign a file download (@ayepi/files)', tags: ['files'] },
      },

      /** List stored objects (metadata only), key-sorted. */
      listFiles: {
        method: 'GET',
        response: z.object({ files: z.array(StoredFile) }),
        doc: { summary: 'List stored files', tags: ['files'] },
      },

      /** Delete a stored object; `ok` is false if it didn't exist. */
      removeFile: {
        body: z.object({ key: z.string().min(1) }),
        response: z.object({ ok: z.boolean() }),
        doc: { summary: 'Delete a stored file', tags: ['files'] },
      },
    }),
  },

  events: {
    /** Per-job progress (parameterized channel). `result` is filled in on the final tick. */
    jobProgress: {
      params: z.object({ jobId: z.string() }).meta({ id: 'JobProgress', title: 'Job progress', description: 'Emitted as a job runs, with progress % and final result' }),
      data: z.object({ pct: z.number(), result: z.number().nullable() }),
      doc: { summary: 'Job progress %' },
    },
  },
});
