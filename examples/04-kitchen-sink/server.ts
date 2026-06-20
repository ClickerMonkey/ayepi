/** Node server: binds the auth/telemetry/loader impls (secrets + store live here), then the handlers. */
import { implement, server, reject } from '@ayepi/core';
import { bearerAuth, signJwt } from '@ayepi/auth/server';
import { telemetry } from '@ayepi/otel/server';
import { logger } from '@ayepi/log';
import { api, auth, tel, jobLoader, Claims, type Job, type JobRecord, type User } from './shared';
import { runExample } from '../_harness';

/* ---- server-side state + secrets (never reach the frontend-safe shared.ts) ---- */
/** Demo HMAC secret — server-side only; the same secret signs (`login`) and verifies (`bearerAuth`). */
const SECRET = 'demo-secret-do-not-ship';
/** Issuer minted into / verified on every token. */
const ISSUER = 'ayepi-kitchen-sink';
/** Token lifetime (seconds). */
const EXPIRES_IN = 60 * 60;
/** The in-memory job store the loader resolves `:jobId` against. */
const jobs = new Map<string, JobRecord>();

const toJob = (j: JobRecord): Job => ({ id: j.id, title: j.title, pct: j.pct });
let seq = 0;

type Emit = (event: 'jobProgress', params: { jobId: string }, data: { pct: number }) => void;
type Notice = (event: 'systemNotice', data: { msg: string }) => void;

/** Fake background worker: bumps progress + appends log lines, emitting events as it goes. */
function startWorker(rec: JobRecord, emit: Emit & Notice): void {
  const timer = setInterval(() => {
    rec.pct = Math.min(100, rec.pct + 20);
    rec.log.push(`[${new Date().toISOString()}] ${rec.title}: ${rec.pct}%`);
    emit('jobProgress', { jobId: rec.id }, { pct: rec.pct });
    if (rec.pct >= 100) {
      clearInterval(timer);
      rec.log.push('done ✓');
      emit('systemNotice', { msg: `job "${rec.title}" finished` });
    }
  }, 500);
  (timer as { unref?: () => void }).unref?.();
}

const impl = implement(api)
  // Bind the auth def: verify HS256 + custom claims, map to a User. Reads User/Claims off the def for alignment.
  .middleware(
    bearerAuth.server(auth, {
      secret: SECRET,
      issuer: ISSUER,
      expiresIn: EXPIRES_IN,
      claims: Claims,
      toUser: (claims): User => ({ id: claims.user, role: claims.role }),
    }),
  )
  // Bind telemetry: request + response logging, request-id echo, enriching the @ayepi/log trace context.
  .middleware(telemetry.server(tel, { echoRequestId: true }))
  // Bind the loader: resolve :jobId against the store, or 404. `ctx.job` then flows to handlers.
  .middleware(jobLoader, async (io) => {
    const job = jobs.get(io.value);
    if (!job) {
      throw reject(404, 'JOB_NOT_FOUND');
    }
    return io.next({ job });
  })
  .handlers({
    login: ({ data, fail }) => {
      if (data.user === 'blocked') {
        return fail(403, { reason: 'this account is blocked' }); // typed, declared error
      }
      // `admin` logs in as an admin; everyone else is a plain user.
      const role: Claims['role'] = data.user === 'admin' ? 'admin' : 'user';
      // Mint the JWT with the standalone primitive — `login` is public (NOT under bearerAuth),
      // so it can't use the context `signToken`. The client never signs; it just carries this token.
      const { token } = signJwt<Claims>({ user: data.user, role }, { secret: SECRET, issuer: ISSUER, expiresIn: EXPIRES_IN });
      logger.info('login', { user: data.user, role });
      return { token };
    },

    me: ({ user }) => ({ user: user.id, role: user.role }), // `user` is the typed object from bearerAuth's toUser

    createJob: ({ data, status, emit }) => {
      const id = `job-${++seq}`;
      const rec: JobRecord = { id, title: data.title, pct: 0, log: [`[${new Date().toISOString()}] created`] };
      jobs.set(id, rec);
      status(201);
      startWorker(rec, emit as Emit & Notice);
      logger.info('job created', { id }); // trace context (requestId, method, path) is enriched by telemetry
      return toJob(rec);
    },

    listJobs: () => [...jobs.values()].map(toJob),

    uploadAttachment: ({ data }) => {
      jobs.get(data.jobId)?.log.push(`attached ${data.file.name} (${data.file.size} bytes)`);
      return { name: data.file.name, size: data.file.size };
    },

    jobStatus: ({ job }) => toJob(job), // `job` came from the loader (already 404'd if missing)

    streamLog: async function* ({ job }) {
      let i = 0;
      for (;;) {
        while (i < job.log.length) {
          yield { line: job.log[i++]! };
        }
        if (job.pct >= 100) {
          break;
        }
        await new Promise((r) => setTimeout(r, 200)); // wait for the worker to append more
      }
    },
  });

const app = server(api, [impl], {
  cors: { origin: '*' },
  docs: { info: { title: 'ayepi · 04 kitchen-sink', version: '1.0.0' } },
});

runExample({ app, clientEntry: new URL('./client.ts', import.meta.url), title: '04 · kitchen-sink', port: 3004 });
