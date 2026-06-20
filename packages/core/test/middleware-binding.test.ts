/**
 * The def/impl binding surface: the unbound placeholder `run`, the chainable
 * `implement().middleware(def, impl)` and `.middleware({ def, impl })` forms, the
 * assembly-time "unbound chain middleware" throws (endpoint + event guard), and a
 * handler split across two builders.
 */
import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { middleware, ctx, endpoint, spec, server, implement, type BoundMiddleware } from '../src/index';

describe('unbound defs', () => {
  it("a def's placeholder run throws a helpful error if executed before binding", () => {
    const lonely = middleware('lonely', { provides: ctx<{ a: number }>() });
    expect(() => lonely.run({ req: new Request('http://t'), ctx: undefined as never, next: async () => ({}) })).toThrow(
      /middleware "lonely" has no implementation/,
    );
  });

  it('server() throws if an endpoint-chain middleware is not bound', () => {
    const auth = middleware('auth', { provides: ctx<{ user: string }>() });
    const api = spec({ endpoints: { me: auth.endpoint({ response: z.object({ u: z.string() }) }) } });
    expect(() => server(api, [implement(api).handlers({ me: () => ({ u: 'x' }) })])).toThrow(
      /middleware "auth" \(endpoint "me"\) has no implementation/,
    );
  });

  it('server() throws if an event-guard middleware is not bound', () => {
    const guard = middleware('eguard');
    const api = spec({
      endpoints: { a: endpoint({ response: z.object({ ok: z.boolean() }) }) },
      events: { ev: { data: z.object({ n: z.number() }), guard: [guard] } },
    });
    expect(() => server(api, [implement(api).handlers({ a: () => ({ ok: true }) })])).toThrow(
      /middleware "eguard" \(event "ev"\) has no implementation/,
    );
  });
});

describe('binding forms', () => {
  const auth = middleware('auth', { provides: ctx<{ user: string }>() });
  const api = spec({ endpoints: { me: auth.endpoint({ response: z.object({ u: z.string() }) }) } });

  it('binds via the two-arg .middleware(def, impl) form', async () => {
    const app = server(api, [
      implement(api)
        .middleware(auth, async (io) => io.next({ user: 'two-arg' }))
        .handlers({ me: ({ user }) => ({ u: user }) }),
    ]);
    expect(await (await app.fetch(new Request('http://t/me', { method: 'POST' }))).json()).toEqual({ u: 'two-arg' });
  });

  it('binds via the one-arg .middleware({ def, impl }) bound form', async () => {
    const bound: BoundMiddleware<typeof auth> = { def: auth, impl: async (io) => io.next({ user: 'bound' }) };
    const app = server(api, [implement(api).middleware(bound).handlers({ me: ({ user }) => ({ u: user }) })]);
    expect(await (await app.fetch(new Request('http://t/me', { method: 'POST' }))).json()).toEqual({ u: 'bound' });
  });
});

describe('multi-builder assembly', () => {
  it('handlers split across two implement() builders are merged', async () => {
    const api = spec({
      endpoints: {
        a: endpoint({ response: z.object({ ok: z.boolean() }) }),
        b: endpoint({ response: z.object({ ok: z.boolean() }) }),
      },
    });
    const app = server(api, [
      implement(api).handlers({ a: () => ({ ok: true }) }),
      implement(api).handlers({ b: () => ({ ok: false }) }),
    ]);
    expect(await (await app.fetch(new Request('http://t/a', { method: 'POST' }))).json()).toEqual({ ok: true });
    expect(await (await app.fetch(new Request('http://t/b', { method: 'POST' }))).json()).toEqual({ ok: false });
  });

  it('throws when the same middleware def is bound twice across builders', () => {
    const mw = middleware('dupmw', { provides: ctx<{ k: number }>() });
    const api = spec({ endpoints: { e: mw.endpoint({ response: z.object({ ok: z.boolean() }) }) } });
    expect(() =>
      server(api, [
        implement(api).middleware(mw, async (io) => io.next({ k: 1 })),
        implement(api).middleware(mw, async (io) => io.next({ k: 2 })).handlers({ e: () => ({ ok: true }) }),
      ]),
    ).toThrow(/duplicate implementation for middleware "dupmw"/);
  });
});
