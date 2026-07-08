/**
 * Unit tests: the three algorithms (memoryStore, with controlled time) and the
 * rateLimit middleware's HTTP + ws behavior (429 short-circuit, headers, custom
 * message/status, key isolation, skip, ctx.ratelimit).
 */
import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { middleware, ctx, endpoint, spec, implement, server, client, reject, ApiError, type WsConn } from '@ayepi/core';
import { rateLimit, type RateLimitServerOptions } from '../src/server';
import { limiter, rateLimitResponse, memoryStore, rateLimitedDoer, type RateLimitRule, type RateLimitDef, type RateLimitStore } from '../src/index';

/* ---------- algorithms via memoryStore (controlled `now`) ---------- */
const consume = async (s: ReturnType<typeof memoryStore>, key: string, rule: RateLimitRule, now: number) => s.consume(key, rule, now);

describe('memoryStore algorithms', () => {
  it('fixed-window: allows up to the limit, then blocks, then resets', async () => {
    const s = memoryStore();
    const rule: RateLimitRule = { limit: 3, window: 1000, algorithm: 'fixed-window' };
    const r = (now: number) => consume(s, 'k', rule, now);
    expect((await r(0)).allowed && (await r(10)).allowed && (await r(20)).allowed).toBe(true);
    const blocked = await r(30);
    expect(blocked.allowed).toBe(false);
    expect(blocked.remaining).toBe(0);
    expect(blocked.retryAfter).toBeGreaterThan(0);
    expect((await r(1001)).allowed).toBe(true); // new window
  });

  it('sliding-window: weights the previous window', async () => {
    const s = memoryStore();
    const rule: RateLimitRule = { limit: 10, window: 1000, algorithm: 'sliding-window' };
    for (let i = 0; i < 10; i++) {await consume(s, 'k', rule, 500 + i);} // fill window 0
    // early in window 1, the previous window still counts heavily → blocked
    expect((await consume(s, 'k', rule, 1010)).allowed).toBe(false);
    // late in window 1, previous window's weight has decayed → allowed
    expect((await consume(s, 'k', rule, 1990)).allowed).toBe(true);
  });

  it('token-bucket: bursts to capacity, blocks, then refills over time', async () => {
    const s = memoryStore();
    const rule: RateLimitRule = { limit: 5, window: 1000, algorithm: 'token-bucket' }; // refill 5 tokens/sec
    for (let i = 0; i < 5; i++) {expect((await consume(s, 'k', rule, 0)).allowed).toBe(true);} // burst of 5
    expect((await consume(s, 'k', rule, 0)).allowed).toBe(false); // empty
    expect((await consume(s, 'k', rule, 200)).allowed).toBe(true); // ~1 token refilled after 200ms
  });

  it('isolates keys and supports reset', async () => {
    const s = memoryStore();
    const rule: RateLimitRule = { limit: 1, window: 1000, algorithm: 'fixed-window' };
    expect((await consume(s, 'a', rule, 0)).allowed).toBe(true);
    expect((await consume(s, 'b', rule, 0)).allowed).toBe(true); // different key, own budget
    expect((await consume(s, 'a', rule, 0)).allowed).toBe(false);
    await s.reset?.('a');
    expect((await consume(s, 'a', rule, 0)).allowed).toBe(true);
  });

  it('does not count rejected requests against the limit by default (sliding-window)', async () => {
    const s = memoryStore();
    const rule: RateLimitRule = { limit: 2, window: 1000, algorithm: 'sliding-window' };
    expect((await consume(s, 'k', rule, 0)).allowed).toBe(true);
    expect((await consume(s, 'k', rule, 0)).allowed).toBe(true); // 2 real hits fill window 0
    // hammering while blocked must NOT accumulate into the window
    for (let i = 0; i < 10; i++) {expect((await consume(s, 'k', rule, 0)).allowed).toBe(false);}
    // halfway into the next window only the 2 real hits weigh in (2*0.5 + 1 = 2 ≤ 2) → allowed again
    expect((await consume(s, 'k', rule, 1500)).allowed).toBe(true);
  });

  it('counts rejected requests when countRejected is set (sliding-window blocks longer)', async () => {
    const s = memoryStore();
    const rule: RateLimitRule = { limit: 2, window: 1000, algorithm: 'sliding-window', countRejected: true };
    await consume(s, 'k', rule, 0);
    await consume(s, 'k', rule, 0); // fill window 0
    for (let i = 0; i < 10; i++) {await consume(s, 'k', rule, 0);} // these now accumulate
    // the inflated previous window still weighs over the limit halfway through the next one
    expect((await consume(s, 'k', rule, 1500)).allowed).toBe(false);
  });

  it('fixed-window respects countRejected (rejected hit still blocked either way)', async () => {
    const s = memoryStore();
    const counted: RateLimitRule = { limit: 1, window: 1000, algorithm: 'fixed-window', countRejected: true };
    expect((await consume(s, 'k', counted, 0)).allowed).toBe(true);
    expect((await consume(s, 'k', counted, 0)).allowed).toBe(false); // over limit, recorded
    expect((await consume(s, 'k', counted, 0)).remaining).toBe(0);
  });
});

/* ---------- standalone usage (no middleware) ---------- */
describe('limiter (standalone primitive)', () => {
  it('checks a key and enforces the limit, no middleware involved', async () => {
    const lim = limiter({ limit: 2, window: 60_000 });
    expect((await lim.check('user-1')).allowed).toBe(true);
    expect((await lim.check('user-1')).allowed).toBe(true);
    const blocked = await lim.check('user-1');
    expect(blocked.allowed).toBe(false);
    expect(blocked.remaining).toBe(0);
    expect((await lim.check('user-2')).allowed).toBe(true); // separate key
    await lim.reset('user-1');
    expect((await lim.check('user-1')).allowed).toBe(true);
  });

  it('accepts an explicit `now` and exposes its rule', async () => {
    const lim = limiter({ limit: 1, window: 1000, algorithm: 'token-bucket' });
    expect(lim.rule).toEqual({ limit: 1, window: 1000, algorithm: 'token-bucket', countRejected: false });
    expect((await lim.check('k', 0)).allowed).toBe(true);
    expect((await lim.check('k', 0)).allowed).toBe(false);
    expect((await lim.check('k', 2000)).allowed).toBe(true); // refilled by time
  });

  it('rateLimitResponse builds a 429 from info, standalone', async () => {
    const lim = limiter({ limit: 1, window: 1000 });
    await lim.check('k');
    const result = await lim.check('k');
    expect(result.allowed).toBe(false);
    const res = rateLimitResponse(result, { message: { error: 'nope' } });
    expect(res.status).toBe(429);
    expect(res.headers.get('ratelimit-limit')).toBe('1');
    expect(await res.json()).toEqual({ error: 'nope' });
  });

  it('a handler can rate-limit itself with the primitive (no middleware)', async () => {
    // the limiter primitive used directly inside an endpoint handler
    const lim = limiter({ limit: 1, window: 60_000 });
    const api = spec({ endpoints: { ping: endpoint({ body: z.object({ who: z.string() }), response: z.object({ ok: z.boolean() }) }) } });
    const app = server(api, [
      implement(api).handlers({
        ping: async ({ data }) => {
          const r = await lim.check(data.who);
          if (!r.allowed) {throw reject(429, 'RATE_LIMITED', `retry in ${r.retryAfter}ms`);}
          return { ok: true };
        },
      }),
    ]);
    const hit = () => app.fetch(new Request('http://t/ping', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ who: 'x' }) }));
    expect((await hit()).status).toBe(200);
    expect((await hit()).status).toBe(429);
  });
});

/* ---------- middleware behavior ---------- */
const auth = middleware('auth', { provides: ctx<{ user: { id: string } }>() });

function makeApp(opts: Partial<RateLimitServerOptions<RateLimitDef<readonly [typeof auth]>>> = {}) {
  const limit = rateLimit({ requires: [auth] });
  const api = spec({
    endpoints: { hit: limit.endpoint({ response: z.object({ ok: z.boolean(), remaining: z.number() }) }) },
  });
  return server(api, [
    implement(api)
      .middleware(auth, async (io) => io.next({ user: { id: io.req.headers.get('x-user') ?? 'anon' } }))
      .middleware(rateLimit.server(limit, { key: (io) => io.ctx.user.id, limit: 2, window: 60_000, ...opts }))
      .handlers({ hit: ({ ratelimit }) => ({ ok: true, remaining: ratelimit.remaining }) }),
  ]);
}

const hit = (app: ReturnType<typeof makeApp>, user = 'u1') => app.fetch(new Request('http://t/hit', { method: 'POST', headers: { 'x-user': user } }));

describe('rateLimit middleware', () => {
  it('allows up to the limit then short-circuits with 429 + headers', async () => {
    const app = makeApp();
    expect((await hit(app)).status).toBe(200);
    expect((await hit(app)).status).toBe(200);
    const blocked = await hit(app);
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get('ratelimit-limit')).toBe('2');
    expect(blocked.headers.get('ratelimit-remaining')).toBe('0');
    expect(Number(blocked.headers.get('retry-after'))).toBeGreaterThan(0);
    expect(await blocked.text()).toBe('Too many requests');
  });

  it('exposes ratelimit info to the handler', async () => {
    const app = makeApp();
    expect((await (await hit(app)).json()).remaining).toBe(1);
    expect((await (await hit(app)).json()).remaining).toBe(0);
  });

  it('isolates limits per key', async () => {
    const app = makeApp();
    await hit(app, 'a');
    await hit(app, 'a');
    expect((await hit(app, 'a')).status).toBe(429);
    expect((await hit(app, 'b')).status).toBe(200); // different user, own budget
  });

  it('limit can be derived per request — different callers get different budgets', async () => {
    const app = makeApp({ limit: (io) => (io.ctx.user.id === 'pro' ? 3 : 1) });
    expect((await hit(app, 'reg')).status).toBe(200); // regular: budget of 1
    expect((await hit(app, 'reg')).status).toBe(429);
    expect((await hit(app, 'pro')).status).toBe(200); // pro: budget of 3
    expect((await hit(app, 'pro')).status).toBe(200);
    expect((await hit(app, 'pro')).status).toBe(200);
    expect((await hit(app, 'pro')).status).toBe(429);
  });

  it('the resolved limit surfaces in ctx.ratelimit and the RateLimit-* headers', async () => {
    const app = makeApp({ limit: (io) => (io.ctx.user.id === 'pro' ? 10 : 2), alwaysHeaders: true });
    const res = await hit(app, 'pro');
    expect(res.headers.get('ratelimit-limit')).toBe('10');
    expect((await res.json()).remaining).toBe(9);
  });

  it('window and algorithm can be derived per request', async () => {
    // pro uses token-bucket, everyone else fixed-window; both cap at 1 — exercises both resolution paths
    const app = makeApp({ limit: 1, window: 1000, algorithm: (io) => (io.ctx.user.id === 'pro' ? 'token-bucket' : 'fixed-window') });
    expect((await hit(app, 'pro')).status).toBe(200);
    expect((await hit(app, 'pro')).status).toBe(429);
    expect((await hit(app, 'reg')).status).toBe(200);
    expect((await hit(app, 'reg')).status).toBe(429);
  });

  it('threads a fully-dynamic rule (limit/window/algorithm/countRejected) through to the store per request', async () => {
    const seen: RateLimitRule[] = [];
    const mem = memoryStore();
    const store: RateLimitStore = {
      consume: (k, rule, t) => {
        seen.push(rule);
        return mem.consume(k, rule, t);
      },
    };
    const app = makeApp({
      store,
      limit: (io) => (io.ctx.user.id === 'pro' ? 100 : 5),
      window: () => 30_000,
      algorithm: () => 'token-bucket',
      countRejected: (io) => io.ctx.user.id === 'strict',
    });
    await hit(app, 'pro');
    await hit(app, 'strict');
    expect(seen[0]).toEqual({ limit: 100, window: 30_000, algorithm: 'token-bucket', countRejected: false });
    expect(seen[1]).toEqual({ limit: 5, window: 30_000, algorithm: 'token-bucket', countRejected: true });
  });

  it('honors a custom status, JSON message, and headers', async () => {
    const app = makeApp({
      status: 503,
      message: (info) => ({ error: 'slow down', retryAfter: info.retryAfter }),
      headers: (info) => ({ 'x-ratelimit': String(info.limit) }),
    });
    await hit(app);
    await hit(app);
    const res = await hit(app);
    expect(res.status).toBe(503);
    expect(res.headers.get('x-ratelimit')).toBe('2');
    expect(res.headers.get('ratelimit-limit')).toBeNull(); // custom headers replace the defaults
    expect((await res.json()).error).toBe('slow down');
  });

  it('headers:false emits no RateLimit headers', async () => {
    const app = makeApp({ headers: false });
    await hit(app);
    await hit(app);
    const res = await hit(app);
    expect(res.headers.get('ratelimit-limit')).toBeNull();
    expect(res.headers.get('retry-after')).toBeNull();
  });

  it('alwaysHeaders emits RateLimit-* on allowed responses too (no Retry-After until blocked)', async () => {
    const app = makeApp({ alwaysHeaders: true });
    const ok = await hit(app);
    expect(ok.status).toBe(200);
    expect(ok.headers.get('ratelimit-limit')).toBe('2');
    expect(ok.headers.get('ratelimit-remaining')).toBe('1');
    expect(ok.headers.get('ratelimit-reset')).not.toBeNull();
    expect(ok.headers.get('retry-after')).toBeNull(); // only present when actually rate-limited
    await hit(app); // exhaust the budget
    const blocked = await hit(app);
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers.get('retry-after'))).toBeGreaterThan(0);
  });

  it('alwaysHeaders advertises full budget on a skipped request, using a custom headers fn', async () => {
    const app = makeApp({
      alwaysHeaders: true,
      skip: (io) => io.req.headers.get('x-user') === 'admin',
      headers: (info) => ({ 'x-rl-remaining': String(info.remaining) }),
    });
    const res = await hit(app, 'admin');
    expect(res.status).toBe(200);
    expect(res.headers.get('x-rl-remaining')).toBe('2'); // skip → full budget advertised via the custom fn
  });

  it('skip bypasses the limiter', async () => {
    const app = makeApp({ skip: (io) => io.req.headers.get('x-user') === 'admin' });
    for (let i = 0; i < 5; i++) {expect((await hit(app, 'admin')).status).toBe(200);}
  });

  it('works without a `requires` list (no dependency middleware)', async () => {
    // exercises the `else` branch of the requires ternary (no requires → plain middleware)
    const limit = rateLimit();
    const api = spec({ endpoints: { hit: limit.endpoint({ response: z.object({ ok: z.boolean() }) }) } });
    const app = server(api, [
      implement(api)
        .middleware(rateLimit.server(limit, { key: (io) => io.req.headers.get('x-user') ?? 'anon', limit: 1, window: 60_000 }))
        .handlers({ hit: () => ({ ok: true }) }),
    ]);
    const call = (user: string) => app.fetch(new Request('http://t/hit', { method: 'POST', headers: { 'x-user': user } }));
    expect((await call('z1')).status).toBe(200);
    expect((await call('z1')).status).toBe(429);
  });

  it('short-circuits over ws as a 429 error frame', async () => {
    const app = makeApp();
    let onMsg: (f: string) => void = () => {};
    const conn: WsConn = app.ws.open((f) => onMsg(f), new Request('http://t/ws', { headers: { 'x-user': 'w1' } }));
    const sdk = client<never>({
      baseUrl: 'http://t',
      manifest: app.manifest(),
      fetchImpl: (r) => app.fetch(r),
      ws: { send: (f) => void app.ws.message(conn, f), onMessage: (cb) => (onMsg = cb) },
    });
    const call = sdk.call as unknown as (n: string, a?: unknown, b?: unknown) => Promise<unknown>;
    await call('hit', { transport: 'ws' });
    await call('hit', { transport: 'ws' });
    await call('hit', { transport: 'ws' }).then(
      () => expect.fail('should reject'),
      (err: ApiError) => expect(err.status).toBe(429),
    );
  });
});

describe('rateLimit — store errors (fail-closed by default, fail-open opt-in)', () => {
  const failStore: RateLimitStore = {
    consume: () => {
      throw new Error('store down');
    },
  };

  it('fail-closed by default: a store error propagates (rejects the request) and onError sees it', async () => {
    const errs: unknown[] = [];
    const app = makeApp({ store: failStore, onError: (e) => errs.push(e) });
    const res = await hit(app);
    expect(res.status).toBe(500); // the store error became an error response, not a silent pass-through
    expect((errs[0] as Error).message).toBe('store down');
  });

  it('failOpen serves the request through when the store errors (onError still sees it)', async () => {
    const errs: unknown[] = [];
    const app = makeApp({ store: failStore, failOpen: true, onError: (e) => errs.push(e) });
    const res = await hit(app);
    expect(res.status).toBe(200);
    expect((await res.json()).remaining).toBe(2); // served as full budget
    expect((errs[0] as Error).message).toBe('store down');
  });

  it('swallows a store error with no onError, and a throwing onError never breaks the request', async () => {
    expect((await hit(makeApp({ store: failStore, failOpen: true }))).status).toBe(200); // no onError → silent, served
    const app = makeApp({
      store: failStore,
      failOpen: true,
      onError: () => {
        throw new Error('reporter boom');
      },
    });
    expect((await hit(app)).status).toBe(200); // throwing onError ignored
  });
});

describe('rateLimitedDoer — store errors are not fatal', () => {
  it('reports a store error during admission and retries instead of stranding tasks', async () => {
    const errs: unknown[] = [];
    let fail = true;
    const mem = memoryStore();
    const store: RateLimitStore = {
      consume: (k, rule, t) => {
        if (fail) {throw new Error('store down');}
        return mem.consume(k, rule, t);
      },
    };
    let ran = 0;
    const d = rateLimitedDoer({ limit: 5, window: 1000, store, retryFloor: 5, onError: (e) => errs.push(e) });
    d.do(async () => void ran++);
    await new Promise((r) => setTimeout(r, 15)); // first drain: store throws → reported + re-armed
    expect(errs.length).toBeGreaterThanOrEqual(1);
    expect(ran).toBe(0);
    fail = false;
    await new Promise((r) => setTimeout(r, 25)); // the re-check timer fires → store ok → admitted
    expect(ran).toBe(1);
    await d.done();
  });

  it('a throwing onError — or none at all — does not crash the drain loop', async () => {
    const mkStore = (flag: { fail: boolean }): RateLimitStore => {
      const mem = memoryStore();
      return {
        consume: (k, rule, t) => {
          if (flag.fail) {throw new Error('store down');}
          return mem.consume(k, rule, t);
        },
      };
    };
    const cycle = async (onError?: (err: unknown) => void): Promise<number> => {
      const flag = { fail: true };
      let ran = 0;
      const d = rateLimitedDoer({ limit: 5, window: 1000, store: mkStore(flag), retryFloor: 5, onError });
      d.do(async () => void ran++);
      await new Promise((r) => setTimeout(r, 15)); // store throws → reported/swallowed + re-armed
      flag.fail = false;
      await new Promise((r) => setTimeout(r, 25)); // retry admits the task
      await d.done();
      return ran;
    };
    expect(await cycle()).toBe(1); // no onError → silent, still retries
    expect(
      await cycle(() => {
        throw new Error('reporter boom');
      }),
    ).toBe(1); // throwing onError → ignored, still retries
  });
});
