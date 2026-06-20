/**
 * Remaining reachable branches: no-param event subscribe/emit/unsub (subKey
 * params ?? {}), a returned AsyncIterable of Uint8Array (toStream byte branch),
 * and the asyncQueue end-with-waiter path.
 */
import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { spec, endpoint, implement, server, type WsConn } from '../src/index';

function harness(theApp: ReturnType<typeof server>) {
  let onMsg: (f: string) => void = () => {};
  const conn: WsConn = theApp.ws.open((f) => onMsg(f), new Request('http://t/ws'));
  return {
    conn,
    setOn: (cb: (f: string) => void) => (onMsg = cb),
    one: (f: Record<string, unknown>) =>
      new Promise<Record<string, unknown>>((resolve) => {
        onMsg = (raw) => {
          const fr = JSON.parse(raw) as Record<string, unknown>;
          if (fr.id === f.id) {resolve(fr);}
        };
        void theApp.ws.message(conn, JSON.stringify(f));
      }),
  };
}

describe('no-param event lifecycle', () => {
  const api = spec({ endpoints: { a: endpoint({ response: z.object({ ok: z.boolean() }) }) }, events: { notice: { data: z.object({ msg: z.string() }) } } });
  const app = server(api, [implement(api).handlers({ a: () => ({ ok: true }) })]);

  it('subscribes, receives, and unsubscribes a no-param channel', async () => {
    const h = harness(app);
    await h.one({ id: 's1', sub: 'notice' }); // no params → subKey(params ?? {})
    const got: string[] = [];
    h.setOn((raw) => {
      const fr = JSON.parse(raw) as Record<string, unknown>;
      if (fr.type === 'notice') {got.push((fr.data as { msg: string }).msg);}
    });
    app.emit('notice', { msg: 'hi' });
    await new Promise((r) => setTimeout(r, 5));
    expect(got).toEqual(['hi']);
    const off = await h.one({ id: 'u1', unsub: 'notice' });
    expect(off.$status).toBe(200);
  });
});

describe('returned AsyncIterable of bytes', () => {
  it('passes raw Uint8Array chunks through toStream', async () => {
    const api = spec({ endpoints: { s: endpoint({ method: 'GET', streamOut: 'application/octet-stream' }) } });
    const app = server(api, [
      implement(api).handlers({
        s: () =>
          (async function* () {
            yield new Uint8Array([1, 2, 3]);
            yield 'tail'; // mix bytes + string to exercise both encode branches
          })(),
      }),
    ]);
    const res = await app.fetch(new Request('http://t/s'));
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect(Array.from(bytes.slice(0, 3))).toEqual([1, 2, 3]);
    expect(new TextDecoder().decode(bytes.slice(3))).toBe('tail');
  });
});

describe('asyncQueue end after the handler is waiting', () => {
  it('completes when chunks then end arrive while the handler awaits', async () => {
    const api = spec({ endpoints: { up: endpoint({ streamIn: z.object({ v: z.number() }), response: z.object({ got: z.number() }) }) } });
    const app = server(api, [
      implement(api).handlers({
        up: async ({ stream }) => {
          let got = 0;
          for await (const _ of stream) {got++;}
          return { got };
        },
      }),
    ]);
    const h = harness(app);
    void app.ws.message(h.conn, JSON.stringify({ id: 'w1', type: '/up', method: 'POST', data: {} }));
    await new Promise((r) => setTimeout(r, 5)); // handler reaches for-await (wake set)
    void app.ws.message(h.conn, JSON.stringify({ id: 'w1', chunk: { v: 1 } }));
    await new Promise((r) => setTimeout(r, 5));
    void app.ws.message(h.conn, JSON.stringify({ id: 'w1', end: true }));
    const reply = await new Promise<Record<string, unknown>>((resolve) => {
      h.setOn((raw) => {
        const fr = JSON.parse(raw) as Record<string, unknown>;
        if (fr.id === 'w1' && 'data' in fr) {resolve(fr);}
      });
    });
    expect(reply.data).toEqual({ got: 1 });
  });
});
