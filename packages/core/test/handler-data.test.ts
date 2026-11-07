/**
 * A handler's `data` is there whenever its endpoint declares input, as
 * `HandlerPayload` types it — also when every field is optional and the
 * request sends none of them (`{}`), over HTTP, WebSocket-less in-process
 * calls, and query-only endpoints. An endpoint with no input has no `data`.
 */
import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { spec, endpoint, implement, server } from '../src/index';

const api = spec({
  endpoints: {
    search: endpoint({ method: 'POST', path: '/search', body: z.object({ q: z.string().optional(), limit: z.number().optional() }), response: z.object({ keys: z.array(z.string()), has: z.boolean() }) }),
    list: endpoint({ method: 'GET', path: '/list', query: z.object({ cursor: z.string().optional() }), response: z.object({ keys: z.array(z.string()), has: z.boolean() }) }),
    ping: endpoint({ method: 'GET', path: '/ping', response: z.object({ has: z.boolean() }) }),
  },
});

const app = server(api, [
  implement(api).handlers({
    search: (io) => ({ keys: Object.keys(io.data), has: 'data' in io }),
    list: (io) => ({ keys: Object.keys(io.data), has: 'data' in io }),
    ping: (io) => ({ has: 'data' in io }),
  }),
]);

describe('handler data', () => {
  it('is an empty object for an all-optional body sent empty, over HTTP', async () => {
    const res = await app.fetch(new Request('http://x/search', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }));
    expect(await res.json()).toEqual({ keys: [], has: true });
  });

  it('holds the fields that were sent', async () => {
    const res = await app.fetch(new Request('http://x/search', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ q: 'a' }) }));
    expect(await res.json()).toEqual({ keys: ['q'], has: true });
  });

  it('is an empty object for an all-optional query with nothing given, over HTTP and in-process', async () => {
    const res = await app.fetch(new Request('http://x/list'));
    expect(await res.json()).toEqual({ keys: [], has: true });
    expect(await app.call('list', {})).toEqual({ keys: [], has: true });
    expect(await app.call('search', {})).toEqual({ keys: [], has: true });
  });

  it('is absent for an endpoint with no input', async () => {
    const res = await app.fetch(new Request('http://x/ping'));
    expect(await res.json()).toEqual({ has: false });
  });
});
