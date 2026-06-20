/**
 * Hot install/uninstall on a running server: routes/events/handlers/middleware go
 * live and the manifest + docs caches refresh; uninstall removes exactly them and
 * clears subscriptions. Plus collision guards (name/route/ws/event), shared-middleware
 * reuse across mounts, and the in-process caller seeing installed endpoints.
 */
import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { spec, endpoint, middleware, ctx, implement, server, localClient, type WsConn } from '../src/index';

const base = spec({ endpoints: { ping: endpoint({ method: 'GET', response: z.object({ ok: z.boolean() }) }) } });
const boot = () => server(base, [implement(base).handlers({ ping: () => ({ ok: true }) })]);

describe('install / uninstall', () => {
  it('mounts a spec at runtime (routes + manifest + openapi), then removes it; reinstall works', async () => {
    const app = boot();
    expect((await app.fetch(new Request('http://t/extra', { method: 'GET' }))).status).toBe(404);

    const extra = spec({ endpoints: { extra: endpoint({ method: 'GET', response: z.object({ v: z.number() }) }) } });
    const handle = app.install(extra, [implement(extra).handlers({ extra: () => ({ v: 42 }) })]);

    expect(await (await app.fetch(new Request('http://t/extra', { method: 'GET' }))).json()).toEqual({ v: 42 });
    expect(app.manifest().endpoints.extra).toBeDefined();
    expect(JSON.stringify(app.openapi())).toContain('/extra');

    app.uninstall(handle);
    expect((await app.fetch(new Request('http://t/extra', { method: 'GET' }))).status).toBe(404);
    expect(app.manifest().endpoints.extra).toBeUndefined();
    expect(JSON.stringify(app.openapi())).not.toContain('/extra');

    app.install(extra, [implement(extra).handlers({ extra: () => ({ v: 7 }) })]);
    expect(await (await app.fetch(new Request('http://t/extra', { method: 'GET' }))).json()).toEqual({ v: 7 });
  });

  it('installed middleware runs, the in-process caller sees the endpoint, and the spec doc patch composes', async () => {
    const app = boot();
    const tag = middleware('tag', { provides: ctx<{ who: string }>() });
    const mod = spec({
      endpoints: { whoami: tag.endpoint({ method: 'GET', response: z.object({ who: z.string() }) }) },
      doc: { openapi: (d) => ({ ...d, 'x-module': 'mod' }) },
    });
    app.install(mod, [implement(mod).middleware(tag, async (io) => io.next({ who: 'mod' })).handlers({ whoami: ({ who }) => ({ who }) })]);

    expect(await (await app.fetch(new Request('http://t/whoami', { method: 'GET' }))).json()).toEqual({ who: 'mod' });
    expect(await localClient(app, mod).call('whoami')).toEqual({ who: 'mod' });
    expect((app.openapi() as Record<string, unknown>)['x-module']).toBe('mod');
  });

  it('a shared middleware def bound at boot is reused by a later mount (not re-bound)', async () => {
    const auth = middleware('auth', { provides: ctx<{ user: string }>() });
    const root = spec({ endpoints: { me: auth.endpoint({ method: 'GET', response: z.object({ user: z.string() }) }) } });
    const app = server(root, [implement(root).middleware(auth, async (io) => io.next({ user: 'u1' })).handlers({ me: ({ user }) => ({ user }) })]);

    // a second module uses the SAME auth def but does not re-bind it — boot's binding is reused
    const mod = spec({ endpoints: { profile: auth.endpoint({ method: 'GET', response: z.object({ user: z.string() }) }) } });
    app.install(mod, [implement(mod).handlers({ profile: ({ user }) => ({ user }) })]);
    expect(await (await app.fetch(new Request('http://t/profile', { method: 'GET' }))).json()).toEqual({ user: 'u1' });
  });

  it('events: an installed channel delivers, and uninstall removes it (and is a safe no-op if repeated)', async () => {
    const app = boot();
    const mod = spec({
      endpoints: { noop: endpoint({ response: z.object({ ok: z.boolean() }) }) },
      events: { tick: { data: z.object({ n: z.number() }) } },
      doc: { openapi: (d) => ({ ...d, 'x-events': true }) },
    });
    const handle = app.install(mod, [implement(mod).handlers({ noop: () => ({ ok: true }) })]);

    const got: number[] = [];
    let onMsg: (f: string) => void = () => {};
    const conn: WsConn = app.ws.open((f) => onMsg(f), new Request('http://t/ws'));
    const sub = await new Promise<Record<string, unknown>>((resolve) => {
      onMsg = (raw) => {
        const fr = JSON.parse(raw) as Record<string, unknown>;
        if (fr.id === 's1') {resolve(fr);}
        else if (fr.type === 'tick') {got.push((fr.data as { n: number }).n);}
      };
      void app.ws.message(conn, JSON.stringify({ id: 's1', sub: 'tick' }));
    });
    expect(sub.$status).toBe(200);
    (app.emit as unknown as (e: string, d: unknown) => void)('tick', { n: 5 });
    await new Promise((r) => setTimeout(r, 5));
    expect(got).toEqual([5]);

    app.uninstall(handle);
    expect(JSON.stringify(app.openapi())).not.toContain('x-events'); // doc patch removed too
    const reply = await new Promise<Record<string, unknown>>((resolve) => {
      onMsg = (raw) => {
        const fr = JSON.parse(raw) as Record<string, unknown>;
        if (fr.id === 's2') {resolve(fr);}
      };
      void app.ws.message(conn, JSON.stringify({ id: 's2', sub: 'tick' }));
    });
    expect(reply.$status).toBe(404); // channel gone after uninstall
    expect(() => app.uninstall(handle)).not.toThrow(); // repeated uninstall is a safe no-op
  });
});

describe('install collisions', () => {
  const dup = <T>(make: () => T) => make();
  it('throws on a duplicate endpoint name, route, ws id, and event', () => {
    const app = boot();
    // duplicate name 'ping' (caught by the handler-dup guard — every endpoint has a handler)
    const sameName = spec({ endpoints: { ping: endpoint({ method: 'GET', path: '/ping2', response: z.object({ ok: z.boolean() }) }) } });
    expect(() => app.install(sameName, [implement(sameName).handlers({ ping: () => ({ ok: true }) })])).toThrow(/duplicate handler for endpoint "ping"/);

    // duplicate route 'GET /ping'
    const sameRoute = spec({ endpoints: { other: endpoint({ method: 'GET', path: '/ping', response: z.object({ ok: z.boolean() }) }) } });
    expect(() => app.install(sameRoute, [implement(sameRoute).handlers({ other: () => ({ ok: true }) })])).toThrow(/route "GET \/ping" is already installed/);

    // duplicate ws id
    const withWs = spec({ endpoints: { a: endpoint({ ws: 'chan', response: z.object({ ok: z.boolean() }) }) } });
    dup(() => app.install(withWs, [implement(withWs).handlers({ a: () => ({ ok: true }) })]));
    const withWs2 = spec({ endpoints: { b: endpoint({ ws: 'chan', response: z.object({ ok: z.boolean() }) }) } });
    expect(() => app.install(withWs2, [implement(withWs2).handlers({ b: () => ({ ok: true }) })])).toThrow(/ws id "chan" is already installed/);

    // duplicate event
    const ev = spec({ endpoints: { c: endpoint({ response: z.object({ ok: z.boolean() }) }) }, events: { e1: { data: z.object({ n: z.number() }) } } });
    dup(() => app.install(ev, [implement(ev).handlers({ c: () => ({ ok: true }) })]));
    const ev2 = spec({ endpoints: { d: endpoint({ response: z.object({ ok: z.boolean() }) }) }, events: { e1: { data: z.object({ n: z.number() }) } } });
    expect(() => app.install(ev2, [implement(ev2).handlers({ d: () => ({ ok: true }) })])).toThrow(/event "e1" is already installed/);
  });

  it('throws on event-ws colliding with an endpoint ws (existing and same-mount)', () => {
    const app = boot();
    const epWs = spec({ endpoints: { live: endpoint({ ws: 'shared', response: z.object({ ok: z.boolean() }) }) } });
    app.install(epWs, [implement(epWs).handlers({ live: () => ({ ok: true }) })]);
    // an event whose channel id equals an existing endpoint's ws id
    const evWs = spec({ endpoints: { z2: endpoint({ response: z.object({ ok: z.boolean() }) }) }, events: { shared: { data: z.object({ n: z.number() }) } } });
    expect(() => app.install(evWs, [implement(evWs).handlers({ z2: () => ({ ok: true }) })])).toThrow(/event channel "shared" collides/);
    // an endpoint + event sharing a ws id within the SAME mount
    const both = spec({ endpoints: { e1: endpoint({ ws: 'dup', response: z.object({ ok: z.boolean() }) }) }, events: { dup: { data: z.object({ n: z.number() }) } } });
    expect(() => app.install(both, [implement(both).handlers({ e1: () => ({ ok: true }) })])).toThrow(/event channel "dup" collides/);
  });

  it('throws on a duplicate handler or middleware impl across the install builders', () => {
    const app = boot();
    const m = spec({ endpoints: { a: endpoint({ response: z.object({ ok: z.boolean() }) }) } });
    expect(() => app.install(m, [implement(m).handlers({ a: () => ({ ok: true }) }), implement(m).handlers({ a: () => ({ ok: false }) })])).toThrow(
      /duplicate handler for endpoint "a"/,
    );
    const mw = middleware('m', { provides: ctx<{ x: number }>() });
    const m2 = spec({ endpoints: { b: mw.endpoint({ response: z.object({ ok: z.boolean() }) }) } });
    expect(() =>
      app.install(m2, [implement(m2).middleware(mw, async (io) => io.next({ x: 1 })), implement(m2).middleware(mw, async (io) => io.next({ x: 2 })).handlers({ b: () => ({ ok: true }) })]),
    ).toThrow(/duplicate implementation for middleware "m"/);
  });

  it('detects event-ws collisions against existing events/endpoints and composes asyncapi patches', () => {
    const app = boot();
    const ok = z.object({ ok: z.boolean() });
    const num = z.object({ n: z.number() });
    // install an event on explicit channel 'c1'
    const e1 = spec({ endpoints: { n1: endpoint({ response: ok }) }, events: { evA: { ws: 'c1', data: num } } });
    app.install(e1, [implement(e1).handlers({ n1: () => ({ ok: true }) })]);
    // another event reusing channel 'c1' (different name) → collides with the live event channel
    const e2 = spec({ endpoints: { n2: endpoint({ response: ok }) }, events: { evB: { ws: 'c1', data: num } } });
    expect(() => app.install(e2, [implement(e2).handlers({ n2: () => ({ ok: true }) })])).toThrow(/event channel "c1" collides/);
    // an endpoint whose ws id equals an existing event channel
    const epc = spec({ endpoints: { n3: endpoint({ ws: 'c1', response: ok }) } });
    expect(() => app.install(epc, [implement(epc).handlers({ n3: () => ({ ok: true }) })])).toThrow(/ws id "c1" is already installed/);
    // a spec-doc with only an asyncapi patch composes into app.asyncapi(); app.openapi() still builds (skips this doc)
    const dmod = spec({ endpoints: { n4: endpoint({ response: ok }) }, doc: { asyncapi: (d) => ({ ...d, 'x-aa': true }) } });
    app.install(dmod, [implement(dmod).handlers({ n4: () => ({ ok: true }) })]);
    expect((app.asyncapi() as Record<string, unknown>)['x-aa']).toBe(true);
    expect(app.openapi()).toBeDefined();
  });

  it('uninstall removes an explicit-ws endpoint + bound middleware, and unbinds the def', () => {
    const app = boot();
    const tag = middleware('tag', { provides: ctx<{ t: number }>() });
    const mod = spec({
      endpoints: { live: tag.endpoint({ ws: 'live-chan', response: z.object({ t: z.number() }) }) },
      doc: { openapi: (d) => ({ ...d, 'x-mod': 1 }) }, // openapi-only doc (asyncapi compose skips it)
    });
    const handle = app.install(mod, [implement(mod).middleware(tag, async (io) => io.next({ t: 1 })).handlers({ live: ({ t }) => ({ t }) })]);
    expect(app.asyncapi()).toBeDefined();
    app.uninstall(handle); // deletes the explicit-ws endpoint, the bound `tag` impl, and the doc

    // `tag` is now unbound: reinstalling an endpoint that uses it without re-binding throws at assembly
    const again = spec({ endpoints: { live2: tag.endpoint({ response: z.object({ t: z.number() }) }) } });
    expect(() => app.install(again, [implement(again).handlers({ live2: ({ t }) => ({ t }) })])).toThrow(/middleware "tag" .* has no implementation/);
  });

  it('re-binding a shared middleware def across mounts throws', () => {
    const auth = middleware('auth', { provides: ctx<{ user: string }>() });
    const root = spec({ endpoints: { me: auth.endpoint({ response: z.object({ user: z.string() }) }) } });
    const app = server(root, [implement(root).middleware(auth, async (io) => io.next({ user: 'u1' })).handlers({ me: ({ user }) => ({ user }) })]);
    const mod = spec({ endpoints: { x: auth.endpoint({ response: z.object({ user: z.string() }) }) } });
    expect(() => app.install(mod, [implement(mod).middleware(auth, async (io) => io.next({ user: 'u2' })).handlers({ x: ({ user }) => ({ user }) })])).toThrow(
      /duplicate implementation for middleware "auth"/,
    );
  });
});
