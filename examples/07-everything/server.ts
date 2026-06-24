/**
 * # 07 · everything — Node server
 *
 * Implements the handlers and wires the whole stack together:
 *
 * - **auth** — `login` mints a JWT with the standalone `signJwt`; protected routes verify it.
 * - **rate** — `ping` reads `ctx.ratelimit` (the middleware 429s past 5/10s before we run).
 * - **otel/log** — `telemetry()` is on every group; `logger.*` calls carry the request id.
 * - **work** — a `compute` work type runs a chunked sum on the bundled in-memory backend,
 *   emitting `jobProgress` via the server's late-bound `emit` (the engine has no request ctx).
 * - **codec** — `snapshot` returns `stringify({ Date, Map, Set })`; the client `parse`s it.
 * - **mcp** — `tools` returns `mcpTools(api)`.
 * - **updown** — the work engine (and the HTTP listener) are registered as lifecycle
 *   components; `up()` starts the engine before serving, SIGTERM drains then stops it.
 */
import { implement, server, type EmitFn } from '@ayepi/core';
import { bearerAuth, signJwt } from '@ayepi/auth/server';
import { telemetry } from '@ayepi/otel/server';
import { rateLimit } from '@ayepi/rate/server';
import { logger } from '@ayepi/log';
import { defineWork, createWork } from '@ayepi/work';
import { updown } from '@ayepi/updown';
import { mcpTools } from '@ayepi/mcp';
import { stringify } from '@ayepi/codec';
import { api, auth, tel, limit, Claims, type JobRecord, type User } from './shared';
import { runExample } from '../_harness';

/* ---- server-side state + secrets (never reach the frontend-safe shared.ts) ---- */
/** Demo HMAC secret — server-side only; signs (`login`) and verifies (`bearerAuth`). */
const SECRET = 'demo-secret-do-not-ship';
/** Issuer minted into / verified on every token. */
const ISSUER = 'ayepi-everything';
/** Token lifetime (seconds). */
const EXPIRES_IN = 60 * 60;
/** The in-memory job store. */
const jobs = new Map<string, JobRecord>();

let seq = 0;

/** Late-bound server emit — assigned once `app` exists, used by the detached work handler. */
let emit: EmitFn<typeof api> | undefined;

/**
 * A chunked compute job: sum 1..(n·1000) in `n` slices, sleeping between slices so the
 * progress is visible. Each slice emits a `jobProgress` event for the job's id. The work
 * handler runs on the engine (no request context), so it emits through the server directly.
 */
const compute = defineWork('compute', async (input: { jobId: string; n: number }, ctx) => {
  const rec = jobs.get(input.jobId);
  let sum = 0;
  for (let i = 1; i <= input.n; i++) {
    for (let k = (i - 1) * 1000 + 1; k <= i * 1000; k++) {
      sum += k;
    }
    const pct = Math.round((i / input.n) * 100);
    const done = i === input.n;
    if (rec) {
      rec.pct = pct;
      rec.done = done;
      rec.result = done ? sum : null;
    }
    emit?.('jobProgress', { jobId: input.jobId }, { pct, result: done ? sum : null });
    await new Promise((r) => setTimeout(r, 250));
  }
  return ctx.result(sum);
});

/** The work engine — bundled in-memory backend, started/stopped by updown (not on import). */
const work = createWork({ work: [compute] as const, autoStart: false });

const impl = implement(api)
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
      key: (io) => io.req.headers.get('x-forwarded-for') ?? io.req.headers.get('x-real-ip') ?? 'anon',
      limit: 5,
      window: 10_000,
      algorithm: 'sliding-window',
    }),
  )
  .handlers({
  login: ({ data, fail }) => {
    if (data.user === 'blocked') {
      return fail(403, { reason: 'this account is blocked' }); // typed, declared error
    }
    const role: Claims['role'] = data.user === 'admin' ? 'admin' : 'user';
    // Mint the JWT with the standalone primitive (this endpoint is NOT under bearerAuth).
    const { token } = signJwt<Claims>({ user: data.user, role }, { secret: SECRET, issuer: ISSUER, expiresIn: EXPIRES_IN });
    logger.info('login', { user: data.user, role });
    return { token, role };
  },

  // The middleware already short-circuited a 429 if over the limit; we just report headroom.
  ping: ({ ratelimit }) => ({ pong: true, remaining: ratelimit.remaining }),

  me: ({ user }) => ({ user: user.id, role: user.role }), // `user` is the typed object from bearerAuth

  enqueue: ({ data, user }) => {
    const id = `job-${++seq}`;
    const rec: JobRecord = { id, title: `compute n=${data.n}`, pct: 0, result: null, done: false };
    jobs.set(id, rec);
    work.enqueue(compute({ jobId: id, n: data.n })); // runs on the engine; emits jobProgress as it goes
    logger.info('job enqueued', { id, by: user.id }); // trace context (requestId, method, path) added by telemetry
    return { jobId: id };
  },

  listJobs: () => [...jobs.values()].map((j) => ({ id: j.id, title: j.title, pct: j.pct, done: j.done })),

  // Rich value → a @ayepi/codec string in a plain JSON field. The client parses it back.
  snapshot: () => ({
    codec: stringify({
      now: new Date(),
      counts: new Map<string, number>([['jobs', jobs.size], ['logins', seq]]),
      roles: new Set<string>(['user', 'admin']),
    }),
  }),

  tools: () => mcpTools(api),
});

const app = server(api, [impl], {
  cors: { origin: '*' },
  docs: { info: { title: 'ayepi · 07 everything', version: '1.0.0' } },
});

// Close the loop: the detached work handler emits through the assembled server.
emit = app.emit;

/**
 * Lifecycle (`@ayepi/updown`). The work engine starts before we serve and drains/stops
 * cleanly on SIGTERM. `runExample` owns the actual Node listener, so the `http` component
 * here is a logging/ordering node that depends on `work` — the real, logged lifecycle is the
 * engine's start/stop. (Signals on by default; `exit(0)` after a signal-driven shutdown.)
 */
const lc = updown({
  timeout: 5_000, // bound down() so a hung hook can't wedge shutdown
  onError: (err, phase, name) => logger.error('lifecycle hook failed', { phase, name, err }),
});

lc.register({
  name: 'work',
  up: () => {
    work.start();
    logger.info('updown: work engine started');
  },
  pre: () => logger.info('updown: draining (stop accepting new jobs)'),
  post: () => {
    // Request the engine stop; don't await — the in-memory poll loop's stop() promise
    // stays pending under tsx, and we don't want it to wedge a graceful shutdown.
    void work.stop();
    logger.info('updown: work engine stopped');
  },
});

lc.register({
  name: 'http',
  deps: ['work'],
  up: () => {
    // The Node listener is started by runExample below; this just records readiness ordering.
    runExample({ app, clientEntry: new URL('./client.ts', import.meta.url), title: '07 · everything', port: 3007 });
    logger.info('updown: http listener serving (after work engine is up)');
  },
  pre: () => logger.info('updown: http draining'),
  post: () => logger.info('updown: http stopped'),
});

await lc.up(); // startup order: work → http; SIGTERM tears down in reverse with logs
