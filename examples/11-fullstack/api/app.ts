/**
 * # 11 · fullstack — the assembled ayepi server (no listener)
 *
 * Implements every endpoint and wires the server-side stack. Kept **listener-free** so it
 * can be imported by the Node/Bun/Deno entry files *and* by `scripts/gen-manifest.ts`
 * without starting a server. The runtime entries import `app` and call `serve(...)`.
 *
 * - **auth** (`@ayepi/auth/server`) — `login` mints a JWT with `signJwt`; protected routes verify it.
 * - **rate** (`@ayepi/rate/server`) — `ping` reads `ctx.ratelimit` (429s past 5/10s before we run).
 * - **otel/log** (`@ayepi/otel/server` + `@ayepi/log`) — telemetry on the groups; `logger.*` carries the request id.
 * - **cache** (`@ayepi/cache/server`) — `report` is cached per-user; the store is a `@ayepi/redis` cache.
 * - **work** (`@ayepi/work`) — `enqueue` runs a chunked compute job, streaming `jobProgress`.
 * - **codec** (`@ayepi/codec`) — `snapshot` encodes a Date/Map/Set into one string field.
 * - **mcp** (`@ayepi/mcp`) — `tools` returns this API as agent tools.
 * - **files** (`@ayepi/files`) — `presign*` mint signed URLs; bytes stream to `/_files`.
 * - **plugin** (`@ayepi/plugin`) — an admin plugin hot-mounts `GET /adminStats`.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { server, implement } from '@ayepi/core';
import { bearerAuth, signJwt } from '@ayepi/auth/server';
import { telemetry } from '@ayepi/otel/server';
import { rateLimit } from '@ayepi/rate/server';
import { cache } from '@ayepi/cache/server';
import { cacheKey } from '@ayepi/cache';
import { logger } from '@ayepi/log';
import { mcpTools } from '@ayepi/mcp';
import { fsFiles } from '@ayepi/files/fs';
import { mountFiles } from '@ayepi/files/server';
import { createPluginHost } from '@ayepi/plugin';
import type { Presigner } from '@ayepi/files';
import { api, auth, tel, limit, userMw, cached, Claims, type User, type JobRecord } from '../shared/spec';
import { encodeSnapshot } from '../shared/domain';
import { work, compute, jobs, bindEmit, cacheStore, titleFor } from './work';
import { admin } from './admin.plugin';

/* ---- server-side state + secrets (never reach the frontend-safe shared/) ---- */
const SECRET = 'demo-secret-do-not-ship';
const ISSUER = 'ayepi-fullstack';
const EXPIRES_IN = 60 * 60;

/** File store (a temp dir); presigned GET/PUT routes are hot-mounted below. */
const filesDir = mkdtempSync(join(tmpdir(), 'ayepi-11-files-'));
const store = fsFiles({ dir: filesDir });
/** Assigned right after the server is built (mountFiles installs onto it); handlers close over it. */
let presign: Presigner;

let seq = 0;

const impl = implement(api)
  // identify the caller for the per-user cache (a stand-in for real auth on `report`)
  .middleware(userMw, async (io) => io.next({ user: io.req.headers.get('x-user') ?? 'anon' }))
  .middleware(
    cache.server(cached, {
      ttl: 8_000, // fresh for 8s
      staleWhileRevalidate: 8_000, // then serve stale up to 8s more while refreshing
      store: cacheStore, // a @ayepi/redis cache over the in-memory stand-in
      vary: (io) => io.ctx.user, // per-user
    }),
  )
  .middleware(
    bearerAuth.server(auth, {
      secret: SECRET,
      issuer: ISSUER,
      expiresIn: EXPIRES_IN,
      claims: Claims,
      toUser: (claims): User => ({ id: claims.user, role: claims.role }),
    }),
  )
  .middleware(telemetry.server(tel, { echoRequestId: true }))
  .middleware(
    rateLimit.server(limit, {
      key: (io) => io.req.headers.get('x-forwarded-for') ?? 'anon',
      limit: 5,
      window: 10_000,
      algorithm: 'sliding-window',
    }),
  )
  .handlers({
    login: ({ data, fail }) => {
      if (data.user === 'blocked') return fail(403, { reason: 'this account is blocked' });
      const role: Claims['role'] = data.user === 'admin' ? 'admin' : 'user';
      const { token } = signJwt<Claims>({ user: data.user, role }, { secret: SECRET, issuer: ISSUER, expiresIn: EXPIRES_IN });
      logger.info('login', { user: data.user, role });
      return { token, role };
    },

    ping: ({ ratelimit }) => ({ pong: true, remaining: ratelimit.remaining }),

    report: async ({ user }) => {
      await new Promise((r) => setTimeout(r, 400)); // simulate an expensive build
      logger.info('report built', { user });
      return { user, value: Math.round(Math.random() * 1000), generatedAt: new Date().toISOString() };
    },
    bust: async ({ data }) => ({ ok: await cacheStore.delete(cacheKey({ method: 'GET', path: '/report', vary: data.user })) }),

    me: ({ user }) => ({ user: user.id, role: user.role }),

    enqueue: ({ data, user }) => {
      const id = `job-${++seq}`;
      const rec: JobRecord = { id, title: titleFor(data.n), pct: 0, result: null, done: false };
      jobs.set(id, rec);
      work.enqueue(compute({ jobId: id, n: data.n }));
      logger.info('job enqueued', { id, by: user.id });
      return { jobId: id };
    },

    listJobs: () => [...jobs.values()].map((j) => ({ id: j.id, title: j.title, pct: j.pct, done: j.done })),

    snapshot: () => ({
      codec: encodeSnapshot({
        now: new Date(),
        counts: new Map<string, number>([['jobs', jobs.size], ['logins', seq]]),
        roles: new Set<string>(['user', 'admin']),
      }),
    }),

    tools: () => mcpTools(api),

    presignUpload: async ({ data }) => ({ key: data.key, url: await presign.presignUpload(data.key, { contentType: data.contentType, expiresIn: 120 }) }),
    presignDownload: async ({ data }) => ({ url: await presign.presignDownload(data.key, { expiresIn: 120 }) }),
    listFiles: async () => {
      const { files } = await store.list('');
      return { files: files.map((f) => ({ key: f.key, size: f.size, contentType: f.contentType, modifiedAt: f.modifiedAt })) };
    },
    removeFile: async ({ data }) => ({ ok: await store.delete(data.key) }),
  });

/** The assembled server (no listener — an entry file calls `serve(app, …)`). */
export const app = server(api, [impl], {
  cors: { origin: '*' },
  docs: { info: { title: 'ayepi · 11 fullstack', version: '1.0.0' } },
});

// hot-mount the presigned GET/PUT routes (/_files?t=…) and capture the presigner.
({ presign } = mountFiles(app, store, { secret: 'dev-secret-change-me' }));

// the detached work handler emits through the assembled server.
bindEmit(app.emit);

// install the admin plugin onto the running server (adds GET /adminStats).
await createPluginHost(app).install(admin);

export { filesDir };
