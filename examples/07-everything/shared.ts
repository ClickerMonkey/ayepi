/**
 * # 07 · everything — shared spec (the single source of truth)
 *
 * A grand-tour dashboard wiring **core** together with every companion package:
 *
 * - `@ayepi/auth`  — `login` mints a JWT (`signJwt`); protected routes use `bearerAuth`.
 * - `@ayepi/rate`  — `ping` is throttled (5 / 10s) → a 429 when hammered.
 * - `@ayepi/otel` + `@ayepi/log` — `telemetry()` across the groups; `logger` inside handlers.
 * - `@ayepi/work`  — `enqueue` runs a chunked compute job, emitting `jobProgress`.
 * - `@ayepi/codec` — `snapshot` returns a codec-encoded string carrying a Date/Map/Set.
 * - `@ayepi/mcp`   — `tools` returns `mcpTools(api)` (this API as agent tools).
 * - `@ayepi/updown`— wires the work engine + HTTP listener into graceful start/stop (server.ts).
 *
 * The client imports this file **type-only**, so none of the middleware — nor zod — reaches
 * the browser. The generated `manifest.gen.ts` is plain data.
 */
import { z } from 'zod';
import { spec, use } from '@ayepi/core';
import { bearerAuth } from '@ayepi/auth';
import { rateLimit } from '@ayepi/rate';
import { telemetry } from '@ayepi/otel';

/** Custom JWT claims carried by the token: who you are and your role. */
export const Claims = z.object({ user: z.string(), role: z.enum(['user', 'admin']) });
export type Claims = z.infer<typeof Claims>;

/** The authenticated user the server's `toUser` maps the validated claims to (flows to handlers as `user`). */
export interface User {
  id: string;
  role: 'user' | 'admin';
}

/** Server-side job record (richer than any wire shape) — the store itself lives in `server.ts`. */
export interface JobRecord {
  id: string;
  title: string;
  pct: number;
  result: number | null;
  done: boolean;
}

/** Telemetry **def** (no context); request-id echo + logging are bound server-side. */
export const tel = telemetry();

/**
 * Auth **def**: contributes `{ user, jwt, signToken }` and the `bearerAuth` security scheme.
 * The secret, claims schema, and `toUser` mapper are supplied by `bearerAuth.server` in `server.ts`.
 */
export const auth = bearerAuth<Claims, User>();

/** Rate-limit **def**: contributes `{ ratelimit }`; the 5/10s policy + key are bound server-side. */
export const limit = rateLimit();

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
       * A codec-encoded snapshot. Core's HTTP wire is plain JSON, so the rich value (a Date,
       * a Map, a Set) travels as a `@ayepi/codec` **string** in a normal string field — the
       * client decodes it back into real Date/Map/Set. That's the whole point of the demo.
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
