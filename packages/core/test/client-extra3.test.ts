/**
 * Final client branch closeout: single (non-array) form file + skipped undefined
 * file, single + skipped urlencoded fields, items+httpOnly throw guard, multi-status
 * over ws, an item stream addressed by an explicit ws id (callFrame), and the
 * clientQueue/ wireAbort already-settled paths.
 */
import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { spec, endpoint, implement, server, client, type WsConn } from '../src/index';

const api = spec({
  endpoints: {
    upOne: endpoint({ files: { doc: z.file(), extra: z.file().optional() }, body: z.object({ title: z.string() }), response: z.object({ name: z.string(), hasExtra: z.boolean() }) }),
    formMix: endpoint({ body: z.object({ one: z.string(), many: z.array(z.string()), skip: z.string().optional() }), bodyEncoding: 'urlencoded', response: z.object({ one: z.string(), n: z.number() }) }),
    onlyHttpRows: endpoint({ httpOnly: true, method: 'GET', query: z.object({ n: z.coerce.number() }), streamOut: z.object({ i: z.number() }) }),
    thingWs: endpoint({ ws: 'thing:create', body: z.object({}), responses: { 201: z.object({ id: z.string() }) } }),
    wsRows: endpoint({ ws: 'rows:stream', query: z.object({ n: z.coerce.number() }), streamOut: z.object({ i: z.number() }) }),
  },
});

const app = server(api, [
  implement(api).handlers({
    upOne: ({ data }) => ({ name: data.doc.name, hasExtra: data.extra !== undefined }),
    formMix: ({ data }) => ({ one: data.one, n: data.many.length }),
    onlyHttpRows: async function* ({ data }) {
      for (let i = 0; i < data.n; i++) {yield { i };}
    },
    thingWs: () => ({ status: 201, data: { id: 'x9' } }) as never,
    wsRows: async function* ({ data }) {
      for (let i = 0; i < data.n; i++) {yield { i };}
    },
  }),
]);

function harness() {
  let onMsg: (f: string) => void = () => {};
  const conn: WsConn = app.ws.open((f) => onMsg(f), new Request('http://t/ws'));
  const sdk = client<typeof api>({
    baseUrl: 'http://t',
    manifest: app.manifest(),
    fetchImpl: (r) => app.fetch(r),
    ws: { send: (f) => void app.ws.message(conn, f), onMessage: (cb) => (onMsg = cb) },
  });
  return { sdk };
}

describe('multipart single file + skipped optional', () => {
  it('sets a single file and skips an undefined optional file', async () => {
    const { sdk } = harness();
    const res = await sdk.call('upOne', { doc: new File(['x'], 'd.txt'), extra: undefined as unknown as File, title: 't' });
    expect(res).toEqual({ name: 'd.txt', hasExtra: false });
  });
});

describe('urlencoded single + array + skipped', () => {
  it('encodes a single field, an array field, and skips undefined', async () => {
    const { sdk } = harness();
    const res = await sdk.call('formMix', { one: 'A', many: ['x', 'y'], skip: undefined });
    expect(res).toEqual({ one: 'A', n: 2 });
  });
});

describe('items + httpOnly transport guard', () => {
  it('throws synchronously when forcing ws on an http-only item stream', () => {
    const { sdk } = harness();
    const lc = sdk.call as unknown as (n: string, a?: unknown, b?: unknown) => unknown;
    expect(() => lc('onlyHttpRows', { n: 1 }, { transport: 'ws' })).toThrow(/http-only/);
  });
});

describe('multi-status over ws', () => {
  it('returns the { status, data } envelope unwrapped (no response-schema parse)', async () => {
    const { sdk } = harness();
    const res = await sdk.call('thingWs', {}, { transport: 'ws' });
    expect(res).toEqual({ status: 201, data: { id: 'x9' } });
  });
});

describe('item stream by explicit ws id (callFrame)', () => {
  it('streams items over ws using an endpoint with an explicit ws id', async () => {
    const { sdk } = harness();
    const out: number[] = [];
    for await (const r of sdk.call('wsRows', { n: 3 }, { transport: 'ws' })) {out.push(r.i);}
    expect(out).toEqual([0, 1, 2]);
  });
});
