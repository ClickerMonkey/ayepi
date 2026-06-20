/**
 * Edge-path coverage: itemsIn-only streams (http + ws), short-circuit/declared-
 * error/validation frames over ws, transport guards, full cookie serialization,
 * empty stream bodies, client abort-listener lifecycle, CORS origin matching, and
 * the doc-generator fallback for unrepresentable schemas.
 */
import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { spec, endpoint, middleware, ctx, implement, server, client, ApiError, type WsConn } from '../src/index';

const auth = middleware('auth', { provides: ctx<{ who: string }>() });

const api = spec({
  endpoints: {
    bulkInsert: endpoint({ streamIn: z.object({ name: z.string() }), response: z.object({ count: z.number() }) }),
    flaky: endpoint({ method: 'GET', query: z.object({ n: z.coerce.number().int() }), streamOut: z.object({ i: z.number() }) }),
    risky: endpoint({ body: z.object({ ok: z.boolean() }), response: z.object({ ok: z.boolean() }), errors: { 409: z.object({ why: z.string() }) } }),
    strict: endpoint({ body: z.object({ n: z.number() }), response: z.object({ n: z.number() }) }),
    onlyHttp: endpoint({ httpOnly: true, response: z.object({ ok: z.boolean() }) }),
    sink: endpoint({ streamIn: 'application/octet-stream', response: z.object({ bytes: z.number() }) }),
    setCookie: endpoint({ response: z.object({ ok: z.boolean() }) }),
    upStream: endpoint({ streamIn: z.object({ v: z.number() }), response: z.object({ got: z.number() }) }),
    getUser: endpoint({ params: z.object({ id: z.string() }), response: z.object({ id: z.string() }) }),
  },
  events: { ping: { data: z.object({ n: z.number() }) } },
});

const app = server(api, [
  implement(api).handlers({
    bulkInsert: async ({ stream }) => {
      let count = 0;
      for await (const _ of stream) {count++;}
      return { count };
    },
    flaky: async function* () {
      yield { i: 0 };
      throw new Error('boom'); // errors mid-stream
    },
    risky: ({ data, fail }) => {
      if (!data.ok) {fail(409, { why: 'nope' });}
      return { ok: true };
    },
    strict: ({ data }) => ({ n: data.n }),
    onlyHttp: () => ({ ok: true }),
    sink: async ({ stream }) => {
      let bytes = 0;
      const reader = stream.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) {break;}
        bytes += value.byteLength;
      }
      return { bytes };
    },
    setCookie: ({ cookie }) => {
      cookie('sid', 'v', { domain: 'example.com', maxAge: 60, expires: new Date(0), secure: true, httpOnly: true, sameSite: 'Strict' });
      return { ok: true };
    },
    upStream: async ({ stream }) => {
      let got = 0;
      for await (const _ of stream) {got++;}
      return { got };
    },
    getUser: ({ data }) => ({ id: data.id }),
  }),
]);

function harness(withWs = true) {
  let onMsg: (f: string) => void = () => {};
  const conn: WsConn = app.ws.open((f) => onMsg(f), new Request('http://t/ws'));
  const sdk = client<typeof api>({
    baseUrl: 'http://t',
    manifest: app.manifest(),
    fetchImpl: (r) => app.fetch(r),
    ws: withWs ? { send: (f) => void app.ws.message(conn, f), onMessage: (cb) => (onMsg = cb) } : undefined,
  });
  return { sdk };
}

describe('itemsIn-only streams', () => {
  it('streams items up over http, single result back', async () => {
    const { sdk } = harness();
    const res = await sdk.call('bulkInsert', undefined, {
      stream: async function* () {
        yield { name: 'a' };
        yield { name: 'b' };
      },
    });
    expect(res).toEqual({ count: 2 });
  });
  it('streams items up over ws, single result back', async () => {
    const { sdk } = harness();
    const res = await sdk.call('bulkInsert', undefined, {
      transport: 'ws',
      stream: async function* () {
        yield { name: 'a' };
      },
    });
    expect(res).toEqual({ count: 1 });
  });
  it('swallows a client upload-generator error (sends end)', async () => {
    const { sdk } = harness();
    const res = await sdk.call('upStream', undefined, {
      transport: 'ws',
      stream: async function* () {
        yield { v: 1 };
        throw new Error('client boom');
      },
    });
    expect(res).toEqual({ got: 1 });
  });
});

describe('ws error frames', () => {
  it('an item stream erroring mid-flight fails the client iterator', async () => {
    const { sdk } = harness();
    const got: number[] = [];
    await expect(
      (async () => {
        for await (const r of sdk.call('flaky', { n: 5 }, { transport: 'ws' })) {got.push(r.i);}
      })(),
    ).rejects.toBeDefined();
    expect(got).toEqual([0]);
  });
  it('a declared fail() becomes a $status error frame → ApiError (HTTP-parity code)', async () => {
    const { sdk } = harness();
    await sdk.call('risky', { ok: false }, { transport: 'ws' }).then(
      () => expect.fail('should reject'),
      (err: ApiError) => {
        expect(err.status).toBe(409);
        expect(err.code).toBe('ERROR'); // declared errors carry their typed data; code defaults to ERROR, matching HTTP
        expect((err.data as { why: string }).why).toBe('nope');
      },
    );
  });
  it('a zod failure becomes a VALIDATION frame', async () => {
    const { sdk } = harness();
    await expect(sdk.call('strict', { n: 'x' as unknown as number }, { transport: 'ws' })).rejects.toMatchObject({ code: 'VALIDATION' });
  });
});

type LooseCall = (name: string, a?: unknown, b?: unknown) => Promise<unknown>;
describe('transport guards', () => {
  it('forcing ws on an http-only endpoint rejects', async () => {
    const { sdk } = harness();
    const lc = sdk.call as unknown as LooseCall;
    await expect(lc('onlyHttp', { transport: 'ws' })).rejects.toThrow(/http-only/);
  });
  it('ws stream call without a ws transport rejects (itemsIn) / throws (items)', async () => {
    const { sdk } = harness(false);
    const lc = sdk.call as unknown as LooseCall;
    await expect(lc('bulkInsert', undefined, { transport: 'ws', stream: (async function* () {})() })).rejects.toThrow(/no websocket/);
    expect(() => lc('flaky', { n: 1 }, { transport: 'ws' })).toThrow(/no websocket/);
  });
});

describe('client abort-listener lifecycle', () => {
  it('removes the abort listener when a ws call settles normally', async () => {
    const { sdk } = harness();
    const ac = new AbortController();
    expect((await sdk.call('getUser', { id: 'u1' }, { transport: 'ws', signal: ac.signal })).id).toBe('u1');
    ac.abort(); // nothing to cancel; must not throw
  });
  it('rejects immediately when given an already-aborted signal', async () => {
    const { sdk } = harness();
    const ac = new AbortController();
    ac.abort();
    await expect(sdk.call('getUser', { id: 'u1' }, { transport: 'ws', signal: ac.signal })).rejects.toBeDefined();
  });
});

describe('server edge paths', () => {
  it('serializes every cookie option', async () => {
    const res = await app.fetch(new Request('http://t/setCookie', { method: 'POST' }));
    const c = res.headers.get('set-cookie')!;
    expect(c).toContain('Domain=example.com');
    expect(c).toContain('Max-Age=60');
    expect(c).toContain('Expires=');
    expect(c).toContain('Secure');
    expect(c).toContain('HttpOnly');
    expect(c).toContain('SameSite=Strict');
  });
  it('handles a streamIn endpoint with an empty body', async () => {
    const res = await app.fetch(new Request('http://t/sink', { method: 'POST' }));
    expect(await res.json()).toEqual({ bytes: 0 });
  });
  it('emit of an unknown event throws', () => {
    const emit = app.emit as unknown as (n: string, ...a: unknown[]) => void;
    expect(() => emit('nope', { n: 1 })).toThrow(/unknown event/);
  });
});

describe('CORS origin matching', () => {
  const corsApi = spec({ endpoints: { ping: endpoint({ response: z.object({ ok: z.boolean() }) }) } });
  const mk = (origin: '*' | string) => server(corsApi, [implement(corsApi).handlers({ ping: () => ({ ok: true }) })], { cors: { origin } });

  it("'*' allows any origin", async () => {
    const res = await mk('*').fetch(new Request('http://t/ping', { method: 'POST', headers: { origin: 'https://anywhere.dev' } }));
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
  });
  it('a single string origin matches exactly', async () => {
    const one = mk('https://app.dev');
    const ok = await one.fetch(new Request('http://t/ping', { method: 'POST', headers: { origin: 'https://app.dev' } }));
    expect(ok.headers.get('access-control-allow-origin')).toBe('https://app.dev');
    const no = await one.fetch(new Request('http://t/ping', { method: 'POST', headers: { origin: 'https://evil.dev' } }));
    expect(no.headers.get('access-control-allow-origin')).toBeNull();
  });
});

describe('middleware builder forms', () => {
  it('middleware.group and stack.with compose', async () => {
    const grouped = auth.group({ a: { response: z.object({ ok: z.boolean() }) } });
    const b = middleware('b');
    const stacked = auth.with(b).endpoint({ response: z.object({ ok: z.boolean() }) });
    const api2 = spec({ endpoints: { ...grouped, b: stacked } });
    const app2 = server(api2, [
      implement(api2)
        .middleware(auth, async (io) => io.next({ who: 'x' }))
        .middleware(b, async (io) => io.next())
        .handlers({ a: () => ({ ok: true }), b: () => ({ ok: true }) }),
    ]);
    expect((await (await app2.fetch(new Request('http://t/a', { method: 'POST' }))).json()).ok).toBe(true);
  });
});

describe('doc generator fallback', () => {
  it('degrades unrepresentable schemas instead of throwing', () => {
    const weirdApi = spec({ endpoints: { w: endpoint({ response: z.object({ fn: z.custom<() => void>() }) }) } });
    const weird = server(weirdApi, [implement(weirdApi).handlers({ w: () => ({ fn: () => {} }) })]);
    expect(() => weird.openapi()).not.toThrow();
  });
});
