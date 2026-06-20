/**
 * In-process calls: `app.call(name, data, opts?)` and `localClient(app, spec)` run
 * an endpoint's full chain + validation without HTTP serialization, with
 * `io.transport === 'local'`. Covers input + no-input endpoints, header-carrying
 * opts (auth-style middleware), multi-status, and unknown-name throw.
 */
import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { spec, endpoint, middleware, ctx, implement, server, localClient } from '../src/index';

describe('in-process call', () => {
  it('calls an endpoint with data, running validation, returning typed data', async () => {
    const api = spec({
      endpoints: {
        getUser: endpoint({ method: 'GET', path: '/users/:id', params: z.object({ id: z.string() }), response: z.object({ id: z.string(), seen: z.string() }) }),
      },
    });
    const app = server(api, [implement(api).handlers({ getUser: ({ data }) => ({ id: data.id, seen: 'local' }) })]);
    const out = await app.call('getUser', { id: 'u1' });
    expect(out).toEqual({ id: 'u1', seen: 'local' });
  });

  it('exposes transport "local" to middleware and carries opts.headers', async () => {
    let sawTransport = '';
    const auth = middleware('auth', { provides: ctx<{ token: string | null }>() });
    const api = spec({ endpoints: { me: auth.endpoint({ method: 'GET', response: z.object({ token: z.string(), transport: z.string() }) }) } });
    const app = server(api, [
      implement(api)
        .middleware(auth, async (io) => {
          sawTransport = io.transport;
          return io.next({ token: io.req.headers.get('authorization') });
        })
        .handlers({ me: ({ token }) => ({ token: token ?? 'none', transport: sawTransport }) }),
    ]);
    const out = (await app.call('me', { headers: { authorization: 'Bearer t' } })) as { token: string; transport: string };
    expect(out).toEqual({ token: 'Bearer t', transport: 'local' });
  });

  it('localClient(app, spec) is a typed in-process caller (multi-status returns { status, data })', async () => {
    const api = spec({
      endpoints: {
        ping: endpoint({ method: 'GET', response: z.object({ ok: z.boolean() }) }),
        create: endpoint({ body: z.object({ name: z.string() }), responses: { 200: z.object({ existing: z.string() }), 201: z.object({ id: z.string() }) } }),
      },
    });
    const app = server(api, [
      implement(api).handlers({
        ping: () => ({ ok: true }),
        create: ({ data }) => (data.name === 'dup' ? ({ status: 200, data: { existing: data.name } } as const) : ({ status: 201, data: { id: `x-${data.name}` } } as const)),
      }),
    ]);
    const lc = localClient(app, api);
    expect(await lc.call('ping')).toEqual({ ok: true });
    expect(await lc.call('create', { name: 'new' })).toEqual({ status: 201, data: { id: 'x-new' } });
    expect(await lc.call('create', { name: 'dup' })).toEqual({ status: 200, data: { existing: 'dup' } });
  });

  it('throws on an unknown endpoint name', () => {
    const api = spec({ endpoints: { a: endpoint({ response: z.object({ ok: z.boolean() }) }) } });
    const app = server(api, [implement(api).handlers({ a: () => ({ ok: true }) })]);
    expect(() => (app.call as (n: string) => unknown)('nope')).toThrow(/unknown endpoint "nope"/);
  });
});
