/**
 * The plugin system end-to-end: define plugins with state services, dependencies,
 * lifecycle, and events; install them into a running server in dependency order;
 * call across plugins via state + the in-process caller; then uninstall/shutdown.
 * Covers the host's ordering, rollback, and refusal guards.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { z } from 'zod';
import { spec, endpoint, server, localClient, middleware, provide, use, ctx as ctxType } from '@ayepi/core';
import { plugin, createPluginHost } from '../src/index';
import type { PluginHandlers, PluginMiddleware } from '../src/index';

const trace: string[] = [];
beforeEach(() => {
  trace.length = 0;
});

/* ---- auth: a base plugin with a state service + full lifecycle ---- */
const authSpec = spec({ endpoints: { login: endpoint({ body: z.object({ user: z.string() }), response: z.object({ token: z.string() }) }) } });
interface AuthState {
  verify: (token: string) => string | null;
}
const auth = plugin({
  name: 'auth',
  spec: authSpec,
  state: (): AuthState => ({ verify: (t) => (t.startsWith('tok-') ? t.slice(4) : null) }),
})
  .handlers(() => ({ login: ({ data }) => ({ token: `tok-${data.user}` }) }))
  .lifecycle(() => ({
    up: () => void trace.push('auth:up'),
    down: () => void trace.push('auth:down'),
    stop: () => void trace.push('auth:stop'),
  }));

/* ---- users: requires auth; uses its state + in-process call + own events ---- */
const usersSpec = spec({
  endpoints: {
    whoami: endpoint({ body: z.object({ token: z.string() }), response: z.object({ user: z.string() }) }),
    proxyLogin: endpoint({ body: z.object({ user: z.string() }), response: z.object({ token: z.string() }) }),
  },
  events: { userSeen: { data: z.object({ user: z.string() }) } },
});
const users = plugin({
  name: 'users',
  requires: [auth] as const,
  spec: usersSpec,
  state: () => ({ greet: (u: string) => `hi ${u}` }),
})
  .handlers((ctx) => ({
    whoami: ({ data }) => {
      const u = ctx.deps.auth.state.verify(data.token);
      if (u === null) {return { user: 'anon' };}
      ctx.emit('userSeen', { user: u }); // emit this plugin's own event
      return { user: ctx.state.greet(u) }; // use this plugin's own state
    },
    proxyLogin: async ({ data }) => ctx.deps.auth.call('login', { user: data.user }), // call a dep's endpoint in-process
  }))
  .lifecycle(() => ({ up: () => void trace.push('users:up') })); // no down/stop

/* ---- bare: no requires, no state, no lifecycle ---- */
const bareSpec = spec({ endpoints: { ping: endpoint({ method: 'GET', response: z.object({ ok: z.boolean() }) }) } });
const bare = plugin({ name: 'bare', spec: bareSpec }).handlers(() => ({ ping: () => ({ ok: true }) }));

const bootApp = () => server(spec({ endpoints: {} }), []);
const post = (path: string, body: unknown) => new Request(`http://t${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

describe('plugin install / dependency context', () => {
  it('installs in dependency order, wiring deps.state, deps.call, ctx.state, and own events', async () => {
    const app = bootApp();
    const host = createPluginHost(app);

    await expect(host.install(users)).rejects.toThrow(/requires "auth", which is not installed/);

    await host.install(auth);
    await host.install(users);
    await host.install(bare);
    expect(host.installed()).toEqual(['auth', 'users', 'bare']);
    expect(trace).toEqual(['auth:up', 'users:up']); // bare has no lifecycle

    // whoami uses auth's state service + this plugin's own state
    const who = await (await app.fetch(post('/whoami', { token: 'tok-bob' }))).json();
    expect(who).toEqual({ user: 'hi bob' });
    expect(await (await app.fetch(post('/whoami', { token: 'bad' }))).json()).toEqual({ user: 'anon' });

    // proxyLogin calls auth's endpoint in-process via ctx.deps.auth.call
    expect(await (await app.fetch(post('/proxyLogin', { user: 'sue' }))).json()).toEqual({ token: 'tok-sue' });

    // bare endpoint is live
    expect(await (await app.fetch(new Request('http://t/ping', { method: 'GET' }))).json()).toEqual({ ok: true });

    // the in-process caller also reaches a plugin's endpoints by name
    expect(await localClient(app, authSpec).call('login', { user: 'z' })).toEqual({ token: 'tok-z' });
  });

  it('refuses a duplicate install and an uninstall of a depended-on plugin; uninstall runs down→stop', async () => {
    const app = bootApp();
    const host = createPluginHost(app);
    await host.install(auth);
    await host.install(users);

    await expect(host.install(auth)).rejects.toThrow(/already installed/);
    await expect(host.uninstall('nope')).rejects.toThrow(/not installed/);
    await expect(host.uninstall('auth')).rejects.toThrow(/cannot uninstall "auth": still required by "users"/);

    await host.uninstall('users'); // users has no down/stop hooks
    expect((await app.fetch(post('/whoami', { token: 'tok-x' }))).status).toBe(404);
    await host.uninstall('auth');
    expect(trace).toEqual(['auth:up', 'users:up', 'auth:down', 'auth:stop']); // drain then teardown
    expect(host.installed()).toEqual([]);
  });

  it('shutdown() tears every plugin down in dependency-safe order (dependents first)', async () => {
    const app = bootApp();
    const host = createPluginHost(app);
    await host.install(auth);
    await host.install(users);
    await host.shutdown();
    expect(host.installed()).toEqual([]);
    // users (dependent) torn down before auth → auth's down/stop run after users is gone
    expect(trace).toEqual(['auth:up', 'users:up', 'auth:down', 'auth:stop']);
  });

  it('shutdown isolates a failing teardown hook and still tears down the rest (reported via onError)', async () => {
    const errs: string[] = [];
    const app = bootApp();
    const host = createPluginHost(app, { onError: (_e, phase, p) => errs.push(`${p}:${phase}`) });

    const aSpec = spec({ endpoints: { aPing: endpoint({ method: 'GET', response: z.object({ ok: z.boolean() }) }) } });
    const a = plugin({ name: 'a', spec: aSpec })
      .handlers(() => ({ aPing: () => ({ ok: true }) }))
      .lifecycle(() => ({
        stop: () => {
          throw new Error('a stop boom');
        },
      }));
    const bSpec = spec({ endpoints: { bPing: endpoint({ method: 'GET', response: z.object({ ok: z.boolean() }) }) } });
    const b = plugin({ name: 'b', spec: bSpec })
      .handlers(() => ({ bPing: () => ({ ok: true }) }))
      .lifecycle(() => ({ stop: () => void trace.push('b:stop') }));

    await host.install(a);
    await host.install(b);
    await host.shutdown(); // a's stop throws — must not prevent b's teardown
    expect(host.installed()).toEqual([]); // everything still removed
    expect(trace).toContain('b:stop');
    expect(errs).toContain('a:stop'); // the failure was reported, not surfaced
  });

  it('install rollback surfaces the original mount error even when the rollback stop throws', async () => {
    const errs: string[] = [];
    const app = bootApp();
    const host = createPluginHost(app, { onError: (_e, phase) => errs.push(phase) });
    await host.install(auth); // occupies the "login" endpoint
    // collides with auth's "login" (mount fails) AND its rollback stop throws
    const dupSpec = spec({ endpoints: { login: endpoint({ method: 'GET', response: z.object({ ok: z.boolean() }) }) } });
    const dup = plugin({ name: 'dup', spec: dupSpec })
      .handlers(() => ({ login: () => ({ ok: true }) }))
      .lifecycle(() => ({
        stop: () => {
          throw new Error('rollback stop boom');
        },
      }));
    await expect(host.install(dup)).rejects.toThrow(/duplicate handler for endpoint "login"/); // the MOUNT error, not the stop error
    expect(errs).toContain('stop'); // the rollback stop failure was reported
    expect(host.installed()).toEqual(['auth']); // dup not registered
  });

  it('reports a route-removal failure (remove phase) and still completes uninstall', async () => {
    const errs: string[] = [];
    const real = bootApp();
    const badApp = { ...real, uninstall: () => { throw new Error('remove boom'); } } as typeof real; // app.uninstall throws
    const host = createPluginHost(badApp, { onError: (_e, phase) => errs.push(phase) });
    const sSpec = spec({ endpoints: { sp: endpoint({ method: 'GET', response: z.object({ ok: z.boolean() }) }) } });
    const s = plugin({ name: 's', spec: sSpec })
      .handlers(() => ({ sp: () => ({ ok: true }) }))
      .lifecycle(() => ({ stop: () => void trace.push('s:stop') }));
    await host.install(s);
    await host.uninstall('s'); // route removal throws → reported as 'remove'; stop still runs; registry cleared
    expect(errs).toContain('remove');
    expect(trace).toContain('s:stop');
    expect(host.installed()).toEqual([]);
  });

  it('teardown errors are silent with no onError, and a throwing onError is ignored', async () => {
    const app = bootApp();
    const mk = (name: string) =>
      plugin({ name, spec: spec({ endpoints: { [name]: endpoint({ method: 'GET', response: z.object({ ok: z.boolean() }) }) } }) })
        .handlers(() => ({ [name]: () => ({ ok: true }) }))
        .lifecycle(() => ({
          stop: () => {
            throw new Error('stop boom');
          },
        }));

    const h1 = createPluginHost(app); // no onError → swallowed silently
    await h1.install(mk('s1'));
    await expect(h1.shutdown()).resolves.toBeUndefined();
    expect(h1.installed()).toEqual([]);

    const h2 = createPluginHost(app, {
      onError: () => {
        throw new Error('reporter boom'); // a throwing reporter must not break teardown
      },
    });
    await h2.install(mk('s2'));
    await expect(h2.shutdown()).resolves.toBeUndefined();
    expect(h2.installed()).toEqual([]);
  });

  it('out-of-line handlers + middleware impls typed against typeof builder, then chained', async () => {
    const stamp = middleware('stamp', { provides: ctxType<{ stamp: string }>() });
    const tag = provide('tag', 'T'); // a prebuilt bound def+impl (the `.middleware(bound)` form)
    const widgetSpec = spec({
      endpoints: {
        ...use(stamp, tag).group({
          make: { body: z.object({ token: z.string() }), response: z.object({ id: z.string(), who: z.string(), stamp: z.string(), tag: z.string() }) },
        }),
      },
    });

    // the builder fixes name/deps/spec/state → `typeof widgetDef` is non-circular
    const widgetDef = plugin({
      name: 'widget',
      requires: [auth] as const,
      spec: widgetSpec,
      state: () => ({ label: (s: string) => `[${s}]` }),
    });

    // a handler defined OUT-OF-LINE, typed via the builder (full access to deps + own state)
    const make: PluginHandlers<typeof widgetDef>['make'] = (ctx) => ({ data, stamp: st, tag: tg }) => {
      const who = ctx.deps.auth.state.verify(data.token) ?? 'anon';
      return { id: ctx.state.label('w1'), who, stamp: st, tag: tg };
    };
    // a middleware impl defined OUT-OF-LINE, typed via the builder + the middleware def
    const stampImpl: PluginMiddleware<typeof widgetDef, typeof stamp> = (ctx) => async (io) => io.next({ stamp: `by-${ctx.state.label('x')}` });

    // `.middleware(def, impl)` (ctx-aware) and `.middleware(bound)` (a prebuilt pair) both chain
    const widget = widgetDef.middleware(stamp, stampImpl).middleware(tag).handlers((ctx) => ({ make: make(ctx) }));

    const app = bootApp();
    const host = createPluginHost(app);
    await host.install(auth);
    await host.install(widget);
    expect(await (await app.fetch(post('/make', { token: 'tok-bob' }))).json()).toEqual({ id: '[w1]', who: 'bob', stamp: 'by-[x]', tag: 'T' });

    // a builder with no requires, finalized with a lifecycle
    const soloSpec = spec({ endpoints: { hi: endpoint({ method: 'GET', response: z.object({ ok: z.boolean() }) }) } });
    const solo = plugin({ name: 'solo', spec: soloSpec })
      .handlers(() => ({ hi: () => ({ ok: true }) }))
      .lifecycle(() => ({ up: () => void trace.push('solo:up') }));
    await host.install(solo);
    expect(trace).toContain('solo:up');
    expect(await (await app.fetch(new Request('http://t/hi', { method: 'GET' }))).json()).toEqual({ ok: true });
  });

  it("rolls back a plugin's lifecycle when its mount fails (collision) by running stop", async () => {
    const app = bootApp();
    const host = createPluginHost(app);
    await host.install(auth);
    // a plugin whose spec endpoint name collides with auth's already-installed "login" handler
    const dupSpec = spec({ endpoints: { login: endpoint({ method: 'GET', response: z.object({ ok: z.boolean() }) }) } });
    const dup = plugin({ name: 'dup', spec: dupSpec })
      .handlers(() => ({ login: () => ({ ok: true }) }))
      .lifecycle(() => ({ up: () => void trace.push('dup:up'), stop: () => void trace.push('dup:stop') }));
    await expect(host.install(dup)).rejects.toThrow(/duplicate handler for endpoint "login"/);
    expect(trace).toEqual(['auth:up', 'dup:up', 'dup:stop']); // up ran, mount failed, stop rolled it back
    expect(host.installed()).toEqual(['auth']); // dup not registered
  });
});
