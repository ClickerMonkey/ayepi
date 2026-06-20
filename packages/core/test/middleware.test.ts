import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { middleware, ctx, use, endpoint, spec, server, implement, reject } from '../src/index';

const order: string[] = [];
// defs (the contract); their impls are bound in build()
const auth = middleware('auth', { provides: ctx<{ user: { id: string } }>() });
const org = middleware('org', { provides: ctx<{ org: { id: string; owner: string } }>(), requires: [auth] });
const cache = middleware('cache', { provides: ctx<{ cached: boolean }>(), optional: [auth] });

function build() {
  const api = spec({
    endpoints: {
      // org requires auth (auto-included); cache is optional and ordered after auth
      thing: use(org, cache).endpoint({ response: z.object({ owner: z.string(), cached: z.boolean() }) }),
      open: endpoint({ response: z.object({ ok: z.boolean() }) }),
    },
  });
  const app = server(api, [
    implement(api)
      .middleware(auth, async (io) => {
        order.push('auth');
        if (io.req.headers.get('authorization') !== 'Bearer ok') {throw reject(401, 'UNAUTHORIZED');}
        return io.next({ user: { id: 'u1' } });
      })
      .middleware(org, async (io) => {
        order.push('org');
        return io.next({ org: { id: 'o1', owner: io.ctx.user.id } });
      })
      .middleware(cache, async (io) => {
        order.push('cache');
        return io.next({ cached: false });
      })
      .handlers({
        thing: ({ org, cached }) => ({ owner: org.owner, cached }),
        open: () => ({ ok: true }),
      }),
  ]);
  return app;
}

describe('chain resolution', () => {
  it('requires auto-includes auth (ctx.user is guaranteed in org)', async () => {
    order.length = 0;
    const app = build();
    const res = await app.fetch(new Request('http://t/thing', { method: 'POST', headers: { authorization: 'Bearer ok' } }));
    expect(await res.json()).toEqual({ owner: 'u1', cached: false });
  });
  it('orders auth before its dependents and before optional cache', async () => {
    order.length = 0;
    const app = build();
    await app.fetch(new Request('http://t/thing', { method: 'POST', headers: { authorization: 'Bearer ok' } }));
    expect(order.indexOf('auth')).toBeLessThan(order.indexOf('org'));
    expect(order.indexOf('auth')).toBeLessThan(order.indexOf('cache'));
  });
  it('a rejecting middleware → 401 envelope', async () => {
    const app = build();
    const res = await app.fetch(new Request('http://t/thing', { method: 'POST' }));
    expect(res.status).toBe(401);
    expect((await res.json()).error.code).toBe('UNAUTHORIZED');
  });
});

describe('io.body', () => {
  it('exposes the raw pre-validation body to middleware (and undefined when there is none)', async () => {
    const seen: unknown[] = [];
    const probe = middleware('probe', {});
    const api = spec({
      endpoints: {
        save: probe.endpoint({ body: z.object({ name: z.string() }), response: z.object({ ok: z.boolean() }) }),
        ping: probe.endpoint({ method: 'GET', response: z.object({ ok: z.boolean() }) }),
      },
    });
    const app = server(api, [
      implement(api)
        .middleware(probe, async (io) => {
          seen.push(io.body);
          return io.next();
        })
        .handlers({ save: () => ({ ok: true }), ping: () => ({ ok: true }) }),
    ]);
    await app.fetch(new Request('http://t/save', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'ada' }) }));
    await app.fetch(new Request('http://t/ping', { method: 'GET' }));
    expect(seen[0]).toEqual({ name: 'ada' }); // the parsed body, before validation
    expect(seen[1]).toBeUndefined(); // a bodyless GET
  });
});

describe('loader middleware', () => {
  it('parses the param and exposes a typed value as context', async () => {
    const loadProject = middleware.loader('projectId', z.uuid(), { provides: ctx<{ project: { id: string } }>() });
    const api = spec({
      endpoints: {
        task: loadProject.path('/projects/:projectId').endpoint({ method: 'GET', path: '/task', response: z.object({ pid: z.string() }) }),
      },
    });
    const app = server(api, [
      implement(api)
        .middleware(loadProject, async (io) => io.next({ project: { id: io.value } }))
        .handlers({ task: ({ project }) => ({ pid: project.id }) }),
    ]);
    const pid = '7f1e9f6a-2b1c-4e8d-9a3b-5c6d7e8f9a0b';
    const res = await app.fetch(new Request(`http://t/projects/${pid}/task`, { method: 'GET' }));
    expect(await res.json()).toEqual({ pid });
  });
  it('a bad param value → 400', async () => {
    const loadProject = middleware.loader('projectId', z.uuid(), { provides: ctx<{ project: { id: string } }>() });
    const api = spec({ endpoints: { task: loadProject.path('/projects/:projectId').endpoint({ method: 'GET', path: '/task', response: z.object({ pid: z.string() }) }) } });
    const app = server(api, [
      implement(api)
        .middleware(loadProject, async (io) => io.next({ project: { id: io.value } }))
        .handlers({ task: ({ project }) => ({ pid: project.id }) }),
    ]);
    const res = await app.fetch(new Request('http://t/projects/not-a-uuid/task', { method: 'GET' }));
    expect(res.status).toBe(400);
  });
});

describe('reserved-name collision', () => {
  it('a ctx key colliding with a reserved payload name throws at request time', async () => {
    const evil = middleware('evil', { provides: ctx<{ data: string }>() });
    const api = spec({ endpoints: { e: evil.endpoint({ response: z.object({ ok: z.boolean() }) }) } });
    const app = server(api, [implement(api).middleware(evil, async (io) => io.next({ data: 'boom' })).handlers({ e: () => ({ ok: true }) })]);
    const res = await app.fetch(new Request('http://t/e', { method: 'POST' }));
    expect(res.status).toBe(500);
    expect((await res.json()).error.message).toMatch(/reserved payload name/);
  });
});

describe('use() — free-function composition', () => {
  const auth = middleware('auth', { provides: ctx<{ user: { id: string } }>() });
  const tel = middleware('tel');
  const loadProject = middleware.loader('projectId', z.uuid(), { provides: ctx<{ project: { id: string } }>(), requires: [auth] });

  it('use(auth, tel).group(...) merges context like auth.with(tel)', async () => {
    const api = spec({ endpoints: { ...use(auth, tel).group({ me: { method: 'GET', response: z.object({ id: z.string() }) } }) } });
    const app = server(api, [
      implement(api)
        .middleware(auth, async (io) => io.next({ user: { id: 'u1' } }))
        .middleware(tel, async (io) => io.next())
        .handlers({ me: ({ user }) => ({ id: user.id }) }),
    ]);
    const res = await app.fetch(new Request('http://t/me', { method: 'GET' }));
    expect(await res.json()).toEqual({ id: 'u1' });
  });

  it('use(single).endpoint(...) works with one middleware, and use() composes a loader + path', async () => {
    const api = spec({
      endpoints: {
        whoami: use(auth).endpoint({ response: z.object({ id: z.string() }) }),
        task: use(auth, loadProject).path('/projects/:projectId').endpoint({ method: 'GET', path: '/task', response: z.object({ pid: z.string() }) }),
      },
    });
    const app = server(api, [
      implement(api)
        .middleware(auth, async (io) => io.next({ user: { id: 'u9' } }))
        .middleware(loadProject, async (io) => io.next({ project: { id: io.value } }))
        .handlers({ whoami: ({ user }) => ({ id: user.id }), task: ({ project }) => ({ pid: project.id }) }),
    ]);
    expect(await (await app.fetch(new Request('http://t/whoami', { method: 'POST' }))).json()).toEqual({ id: 'u9' });
    const pid = '7f1e9f6a-2b1c-4e8d-9a3b-5c6d7e8f9a0b';
    expect(await (await app.fetch(new Request(`http://t/projects/${pid}/task`, { method: 'GET' }))).json()).toEqual({ pid });
  });
});
