/**
 * Middleware short-circuit (handoff §5): a middleware may return a `Response`
 * directly to skip the rest of the chain + the handler. HTTP sends it as-is; ws
 * maps a JSON body to a result frame and anything else to an error frame.
 */
import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { spec, endpoint, middleware, implement, server, client, ApiError } from '../src/index';

let handlerCalls = 0;

const cacheHit = middleware('cacheHit');
const denied = middleware('denied');
const conditional = middleware('conditional');

const api = spec({
  endpoints: {
    cached: cacheHit.endpoint({ response: z.object({ hit: z.boolean() }) }),
    blocked: denied.endpoint({ response: z.object({ hit: z.boolean() }) }),
    maybe: conditional.endpoint({ method: 'GET', query: z.object({ skip: z.string().optional() }), response: z.object({ hit: z.boolean() }) }),
    download: cacheHit.endpoint({ method: 'GET', streamOut: 'text/plain', download: 'x.txt' }),
  },
});

const app = server(api, [
  implement(api)
    .middleware(cacheHit, async () => Response.json({ hit: true }, { headers: { 'x-cache': 'HIT' } }))
    .middleware(denied, async () => new Response('denied', { status: 403 }))
    .middleware(conditional, async (io) => {
      if (new URL(io.req.url).searchParams.get('skip') === '1') {return Response.json({ hit: true });}
      return io.next();
    })
    .handlers({
    cached: () => {
      handlerCalls++;
      return { hit: false };
    },
    blocked: () => {
      handlerCalls++;
      return { hit: false };
    },
    maybe: () => {
      handlerCalls++;
      return { hit: false };
    },
    download: async ({ out }) => {
      handlerCalls++;
      await new ReadableStream<string>({ start: (c) => (c.enqueue('streamed'), c.close()) }).pipeTo(out);
    },
  }),
]);

function harness() {
  let onMsg: (f: string) => void = () => {};
  const conn = app.ws.open((f) => onMsg(f), new Request('http://t/ws'));
  const sdk = client<typeof api>({
    baseUrl: 'http://t',
    manifest: app.manifest(),
    fetchImpl: (r) => app.fetch(r),
    ws: { send: (f) => void app.ws.message(conn, f), onMessage: (cb) => (onMsg = cb) },
  });
  return { sdk };
}

describe('short-circuit over HTTP', () => {
  it('returns the Response as-is and skips the handler', async () => {
    handlerCalls = 0;
    const res = await app.fetch(new Request('http://t/cached', { method: 'POST' }));
    expect(res.status).toBe(200);
    expect(res.headers.get('x-cache')).toBe('HIT');
    expect(await res.json()).toEqual({ hit: true });
    expect(handlerCalls).toBe(0);
  });
  it('a non-2xx Response short-circuits too', async () => {
    const res = await app.fetch(new Request('http://t/blocked', { method: 'POST' }));
    expect(res.status).toBe(403);
    expect(await res.text()).toBe('denied');
  });
  it('conditional: passes through to the handler when not short-circuited', async () => {
    handlerCalls = 0;
    const hit = await app.fetch(new Request('http://t/maybe?skip=1'));
    expect(await hit.json()).toEqual({ hit: true });
    expect(handlerCalls).toBe(0);
    const miss = await app.fetch(new Request('http://t/maybe'));
    expect(await miss.json()).toEqual({ hit: false });
    expect(handlerCalls).toBe(1);
  });
  it('short-circuits a raw-streamOut endpoint before any byte is written', async () => {
    handlerCalls = 0;
    const res = await app.fetch(new Request('http://t/download'));
    expect(await res.json()).toEqual({ hit: true });
    expect(handlerCalls).toBe(0);
  });
});

describe('short-circuit over ws', () => {
  it('a JSON body becomes a result frame', async () => {
    const { sdk } = harness();
    expect(await sdk.call('cached', { transport: 'ws' })).toEqual({ hit: true });
  });
  it('a non-JSON body becomes an error frame', async () => {
    const { sdk } = harness();
    await sdk.call('blocked', { transport: 'ws' }).then(
      () => expect.fail('should reject'),
      (err: unknown) => {
        expect(err).toBeInstanceOf(ApiError);
        expect((err as ApiError).status).toBe(403);
        expect((err as ApiError).code).toBe('SHORT_CIRCUIT');
      },
    );
  });
});
