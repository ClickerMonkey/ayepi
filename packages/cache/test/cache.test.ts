/**
 * The cache middleware over a real server: MISS→HIT (the handler runs once), ttl expiry,
 * per-user `vary` + query keying, the `methods` allow-list, response headers, `skip`,
 * request `Cache-Control`, the `io.ctx.cache` handler opt-out, what is *not* cached
 * (short-circuits, multi-status), and ws pass-through.
 */
import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { middleware, ctx as ctxType, endpoint, spec, implement, server, use, client, reject, type WsConn } from '@ayepi/core';
import { cache, type CacheServerOptions } from '../src/server';
import { hashKey, type CacheControl, type CacheDef, type CacheStore } from '../src/index';

/** A store that throws on the chosen operation — to prove the cache fails open. */
const failStore = (on: 'get' | 'set'): CacheStore => ({
  get: () => {
    if (on === 'get') {throw new Error('store down');}
    return undefined;
  },
  set: () => {
    if (on === 'set') {throw new Error('store down');}
  },
  delete: () => false,
  clear: () => {},
  invalidate: () => 0,
});

const auth = middleware('auth', { provides: ctxType<{ user: { id: string } }>() });

interface State {
  calls: number;
  t: number;
}
type ServerOpts = CacheServerOptions<CacheDef<readonly [typeof auth]>>;
type Payload = { user: { id: string }; cache: CacheControl };

/** A server with one cached `GET /report` endpoint; `state.calls` counts handler runs, `state.t` is the clock. */
function makeApp(opts: Partial<ServerOpts> = {}, mkHandler?: (s: State) => (p: Payload) => { n: number; user: string }) {
  const state: State = { calls: 0, t: 0 };
  const cached = cache({ requires: [auth] });
  const api = spec({
    endpoints: {
      report: cached.endpoint({ method: 'GET', query: z.object({ q: z.string().optional() }), response: z.object({ n: z.number(), user: z.string() }) }),
    },
  });
  const handler = (mkHandler ?? ((s) => ({ user }: Payload) => ({ n: ++s.calls, user: user.id })))(state);
  const app = server(api, [
    implement(api)
      .middleware(auth, async (io) => io.next({ user: { id: io.req.headers.get('x-user') ?? 'anon' } }))
      .middleware(cache.server(cached, { ttl: 1000, vary: (io) => io.ctx.user.id, now: () => state.t, ...opts }))
      .handlers({ report: handler }),
  ]);
  return { app, state };
}

const get = (app: ReturnType<typeof makeApp>['app'], o: { user?: string; q?: string; cc?: string } = {}) => {
  const headers: Record<string, string> = { 'x-user': o.user ?? 'u1' };
  if (o.cc) {headers['cache-control'] = o.cc;}
  return app.fetch(new Request(`http://t/report${o.q !== undefined ? `?q=${o.q}` : ''}`, { headers }));
};

describe('cache middleware', () => {
  it('misses then hits — the handler runs once and the body is replayed', async () => {
    const { app, state } = makeApp();
    const first = await get(app);
    expect(first.headers.get('x-cache')).toBe('MISS');
    expect(await first.json()).toEqual({ n: 1, user: 'u1' });

    const second = await get(app);
    expect(second.headers.get('x-cache')).toBe('HIT');
    expect(second.headers.get('age')).not.toBeNull();
    expect(second.headers.get('cache-control')).toBe('max-age=1');
    expect(await second.json()).toEqual({ n: 1, user: 'u1' }); // same body, handler not re-run
    expect(state.calls).toBe(1);
  });

  it('re-runs the handler once the entry expires (ttl)', async () => {
    const { app, state } = makeApp();
    await get(app);
    state.t += 1001; // past ttl
    const res = await get(app);
    expect(res.headers.get('x-cache')).toBe('MISS');
    expect((await res.json()).n).toBe(2);
    expect(state.calls).toBe(2);
  });

  it('keys by user (vary) and by query', async () => {
    const { app, state } = makeApp();
    await get(app, { user: 'a' }); // n1
    await get(app, { user: 'b' }); // n2 — different user, own entry
    expect((await (await get(app, { user: 'a' })).json()).n).toBe(1); // a still cached
    await get(app, { user: 'a', q: 'x' }); // n3 — different query, own entry
    expect((await (await get(app, { user: 'a', q: 'x' })).json()).n).toBe(3);
    expect(state.calls).toBe(3);
  });

  it('a custom key collapses everyone onto one entry', async () => {
    const { app, state } = makeApp({ key: () => 'shared' });
    expect((await (await get(app, { user: 'a' })).json()).user).toBe('a'); // MISS, stores a's response
    const bs = await get(app, { user: 'b' });
    expect(bs.headers.get('x-cache')).toBe('HIT');
    expect((await bs.json()).user).toBe('a'); // b sees a's cached body (shared key)
    expect(state.calls).toBe(1);
  });

  it('does not cache methods outside the allow-list', async () => {
    const create = cache();
    const api = spec({ endpoints: { make: create.endpoint({ method: 'POST', body: z.object({}), response: z.object({ n: z.number() }) }) } });
    let calls = 0;
    const app = server(api, [implement(api).middleware(cache.server(create, { ttl: 1000 })).handlers({ make: () => ({ n: ++calls }) })]);
    const call = () => app.fetch(new Request('http://t/make', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }));
    const r1 = await call();
    expect(r1.headers.get('x-cache')).toBeNull(); // bypassed (POST not in default ['GET'])
    expect((await (await call()).json()).n).toBe(2); // ran again
    expect(calls).toBe(2);
  });

  it('honors a custom methods list', async () => {
    const create = cache();
    const api = spec({ endpoints: { make: create.endpoint({ method: 'POST', body: z.object({}), response: z.object({ n: z.number() }) }) } });
    let calls = 0;
    const app = server(api, [implement(api).middleware(cache.server(create, { ttl: 1000, methods: ['POST'] })).handlers({ make: () => ({ n: ++calls }) })]);
    const call = () => app.fetch(new Request('http://t/make', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }));
    await call();
    expect((await (await call()).json()).n).toBe(1); // POST now cached
    expect(calls).toBe(1);
  });

  it('does not cache a downstream short-circuit Response', async () => {
    const cached = cache();
    const blocker = middleware('blocker', {});
    const api = spec({ endpoints: { ...use(cached, blocker).group({ r: { method: 'GET', response: z.object({ ok: z.boolean() }) } }) } });
    let calls = 0;
    const app = server(api, [
      implement(api)
        .middleware(cache.server(cached, { ttl: 1000 }))
        .middleware(blocker, async () => new Response('nope', { status: 403 }))
        .handlers({ r: () => ({ ok: !!++calls }) }),
    ]);
    const r1 = await app.fetch(new Request('http://t/r'));
    expect(r1.status).toBe(403);
    const r2 = await app.fetch(new Request('http://t/r'));
    expect(r2.status).toBe(403); // not served from cache (a Response result is never stored)
    expect(r2.headers.get('x-cache')).toBeNull();
  });

  it('does not cache a multi-status result', async () => {
    const cached = cache();
    const api = spec({ endpoints: { r: cached.endpoint({ method: 'GET', responses: { 200: z.object({ n: z.number() }) } }) } });
    let calls = 0;
    const app = server(api, [implement(api).middleware(cache.server(cached, { ttl: 1000 })).handlers({ r: () => ({ status: 200, data: { n: ++calls } }) as never })]);
    const r1 = await app.fetch(new Request('http://t/r'));
    expect(r1.headers.get('x-cache')).toBe('MISS');
    expect((await (await app.fetch(new Request('http://t/r'))).json()).n).toBe(2); // ran again — multi-status not cached
    expect(calls).toBe(2);
  });

  it('lets the handler opt out via io.ctx.cache.noStore()', async () => {
    const { app, state } = makeApp({}, (s) => ({ user, cache: c }: Payload) => {
      c.noStore();
      return { n: ++s.calls, user: user.id };
    });
    await get(app);
    const second = await get(app);
    expect(second.headers.get('x-cache')).toBe('MISS'); // never stored
    expect(state.calls).toBe(2);
  });

  it('lets the handler extend the lifetime via io.ctx.cache.ttl()', async () => {
    const { app, state } = makeApp({}, (s) => ({ user, cache: c }: Payload) => {
      c.ttl(5000); // override the 1000ms default
      return { n: ++s.calls, user: user.id };
    });
    await get(app);
    state.t += 2000; // past the default ttl, under the override
    const res = await get(app);
    expect(res.headers.get('x-cache')).toBe('HIT');
    expect(state.calls).toBe(1);
  });

  it('exposes the computed key on io.ctx.cache', async () => {
    let seen = '';
    const { app } = makeApp({}, (s) => ({ user, cache: c }: Payload) => {
      seen = c.key;
      return { n: ++s.calls, user: user.id };
    });
    await get(app, { user: 'zed' });
    expect(seen).toContain('zed');
    expect(seen).toContain('/report');
  });

  it('respects request Cache-Control: no-store (bypass) and no-cache (revalidate)', async () => {
    const { app, state } = makeApp();
    await get(app); // n1 cached
    const bypass = await get(app, { cc: 'no-store' });
    expect(bypass.headers.get('x-cache')).toBeNull(); // neither read nor written
    expect((await bypass.json()).n).toBe(2); // ran fresh, did not serve the cache

    const reval = await get(app, { cc: 'no-cache' });
    expect(reval.headers.get('x-cache')).toBe('MISS'); // skipped the read, refreshed
    expect((await reval.json()).n).toBe(3);
    expect((await (await get(app)).json()).n).toBe(3); // subsequent plain GET hits the refreshed entry
    expect(state.calls).toBe(3);
  });

  it('skip() bypasses the cache entirely', async () => {
    const { app, state } = makeApp({ skip: (io) => io.req.headers.get('x-user') === 'admin' });
    await get(app, { user: 'admin' });
    const res = await get(app, { user: 'admin' });
    expect(res.headers.get('x-cache')).toBeNull();
    expect(state.calls).toBe(2);
  });

  it('shouldCache() can exclude a response', async () => {
    const { app, state } = makeApp({ shouldCache: (_io, result) => (result as { user: string }).user !== 'nope' });
    await get(app, { user: 'nope' });
    expect((await (await get(app, { user: 'nope' })).json()).n).toBe(2); // never cached
    await get(app, { user: 'yep' });
    expect((await (await get(app, { user: 'yep' })).json()).n).toBe(3); // cached → HIT, no new run
    expect(state.calls).toBe(3);
  });

  it('headers:false emits no cache headers', async () => {
    const { app, state } = makeApp({ headers: false });
    const first = await get(app);
    expect(first.headers.get('x-cache')).toBeNull();
    const second = await get(app);
    expect(second.headers.get('x-cache')).toBeNull();
    expect(await second.json()).toEqual({ n: 1, user: 'u1' }); // still served from cache
    expect(state.calls).toBe(1);
  });

  it('caches over ws too — a hit replays as a result frame', async () => {
    const { app, state } = makeApp();
    let onMsg: (f: string) => void = () => {};
    const conn: WsConn = app.ws.open((f) => onMsg(f), new Request('http://t/ws', { headers: { 'x-user': 'w1' } }));
    const sdk = client<never>({
      baseUrl: 'http://t',
      manifest: app.manifest(),
      fetchImpl: (r) => app.fetch(r),
      ws: { send: (f) => void app.ws.message(conn, f), onMessage: (cb) => (onMsg = cb) },
    });
    const call = sdk.call as unknown as (n: string, a?: unknown, b?: unknown) => Promise<{ n: number }>;
    expect((await call('report', {}, { transport: 'ws' })).n).toBe(1); // MISS — keyed off the ws frame args + route
    expect((await call('report', {}, { transport: 'ws' })).n).toBe(1); // HIT — same body, handler not re-run
    expect(state.calls).toBe(1);
  });

  it('keys on the JSON request body — same body hits (any key order), different body misses', async () => {
    const cached = cache();
    const api = spec({ endpoints: { search: cached.endpoint({ body: z.object({ a: z.string(), b: z.string() }), response: z.object({ n: z.number() }) }) } });
    let calls = 0;
    const app = server(api, [implement(api).middleware(cache.server(cached, { ttl: 1000, methods: ['POST'] })).handlers({ search: () => ({ n: ++calls }) })]);
    const post = (raw: string) => app.fetch(new Request('http://t/search', { method: 'POST', headers: { 'content-type': 'application/json' }, body: raw }));
    expect((await post('{"a":"1","b":"2"}')).headers.get('x-cache')).toBe('MISS');
    expect((await post('{"b":"2","a":"1"}')).headers.get('x-cache')).toBe('HIT'); // reordered keys → same key
    expect((await post('{"a":"1","b":"9"}')).headers.get('x-cache')).toBe('MISS'); // different body
    expect(calls).toBe(2);
  });

  it('keys on a urlencoded form body (no files)', async () => {
    const cached = cache();
    const api = spec({ endpoints: { f: cached.endpoint({ body: z.object({ q: z.string() }), bodyEncoding: 'urlencoded', response: z.object({ n: z.number() }) }) } });
    let calls = 0;
    const app = server(api, [implement(api).middleware(cache.server(cached, { ttl: 1000, methods: ['POST'] })).handlers({ f: () => ({ n: ++calls }) })]);
    const post = (q: string) => app.fetch(new Request('http://t/f', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: `q=${q}` }));
    expect((await post('hi')).headers.get('x-cache')).toBe('MISS');
    expect((await post('hi')).headers.get('x-cache')).toBe('HIT');
    expect((await post('yo')).headers.get('x-cache')).toBe('MISS');
    expect(calls).toBe(2);
  });

  it('never caches multipart (file) requests', async () => {
    const cached = cache();
    const api = spec({ endpoints: { up: cached.endpoint({ files: { f: z.file() }, body: z.object({ name: z.string() }), response: z.object({ n: z.number() }) }) } });
    let calls = 0;
    const app = server(api, [implement(api).middleware(cache.server(cached, { ttl: 1000, methods: ['POST'] })).handlers({ up: () => ({ n: ++calls }) })]);
    const send = (): Promise<Response> => {
      const fd = new FormData();
      fd.set('f', new File(['x'], 'x.txt'));
      fd.set('body', JSON.stringify({ name: 'a' }));
      return app.fetch(new Request('http://t/up', { method: 'POST', body: fd }));
    };
    expect((await send()).headers.get('x-cache')).toBeNull(); // multipart bypassed
    await send();
    expect(calls).toBe(2);
  });

  it('hashes the store key and verifies the full key on a hit (collision-safe)', async () => {
    // a deliberately-colliding hash: every key maps to the same store key
    const collide = makeApp({ hash: () => 'X' });
    expect((await get(collide.app, { user: 'a' })).headers.get('x-cache')).toBe('MISS');
    const bs = await get(collide.app, { user: 'b' }); // same store key, different full key → collision → miss
    expect(bs.headers.get('x-cache')).toBe('MISS');
    expect((await bs.json()).user).toBe('b'); // served b's own response, not a's
    expect(collide.state.calls).toBe(2);

    // a real hash still hits for the same request
    const hashed = makeApp({ hash: hashKey });
    await get(hashed.app, { user: 'a' });
    expect((await get(hashed.app, { user: 'a' })).headers.get('x-cache')).toBe('HIT');
    expect(hashed.state.calls).toBe(1);
  });

  it('checkKey:false skips verification (leaner memory, accepts collision risk)', async () => {
    const { app, state } = makeApp({ hash: () => 'X', checkKey: false });
    await get(app, { user: 'a' }); // stored under 'X', entry.key = the hash (no full key kept)
    const bs = await get(app, { user: 'b' }); // store hit on 'X', no verification → serves a's body
    expect(bs.headers.get('x-cache')).toBe('HIT');
    expect((await bs.json()).user).toBe('a'); // the documented collision risk
    expect(state.calls).toBe(1);
  });

  it('falls open when the store read errors — the endpoint serves uncached, onError sees it', async () => {
    const errs: [unknown, string][] = [];
    const { app, state } = makeApp({ store: failStore('get'), onError: (e, p) => errs.push([e, p]) });
    const res = await get(app);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ n: 1, user: 'u1' }); // handler still ran and answered
    expect(res.headers.get('x-cache')).toBeNull(); // behaved as if there were no cache
    await get(app);
    expect(state.calls).toBe(2); // every call runs (nothing cached)
    expect(errs.map(([, p]) => p)).toEqual(['read', 'read']);
    expect((errs[0]![0] as Error).message).toBe('store down');
  });

  it('falls open when key derivation (vary) throws', async () => {
    const errs: string[] = [];
    const { app, state } = makeApp({
      vary: () => {
        throw new Error('boom');
      },
      onError: (_e, p) => errs.push(p),
    });
    const res = await get(app);
    expect(res.status).toBe(200);
    expect((await res.json()).n).toBe(1);
    expect(res.headers.get('x-cache')).toBeNull();
    expect(state.calls).toBe(1);
    expect(errs).toEqual(['read']);
  });

  it('swallows a store write error — the response still returns, onError sees it', async () => {
    const errs: string[] = [];
    const { app, state } = makeApp({ store: failStore('set'), onError: (_e, p) => errs.push(p) });
    const res = await get(app);
    expect(res.status).toBe(200);
    expect((await res.json()).n).toBe(1);
    expect(res.headers.get('x-cache')).toBe('MISS'); // it was a miss; storing it just failed silently
    await get(app); // nothing got cached → runs again
    expect(state.calls).toBe(2);
    expect(errs).toEqual(['write', 'write']);
  });

  it('a throwing onError never breaks the request', async () => {
    const { app, state } = makeApp({
      store: failStore('get'),
      onError: () => {
        throw new Error('logger exploded');
      },
    });
    const res = await get(app);
    expect(res.status).toBe(200); // the throwing onError is itself swallowed
    expect((await res.json()).n).toBe(1);
    expect(state.calls).toBe(1);
  });

  it("still surfaces the handler's own error (the cache doesn't swallow it)", async () => {
    const { app } = makeApp({}, () => () => {
      throw reject(418, 'TEAPOT');
    });
    const res = await get(app);
    expect(res.status).toBe(418);
    expect((await res.json()).error.code).toBe('TEAPOT');
  });
});
