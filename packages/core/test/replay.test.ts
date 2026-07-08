/**
 * Replay-on-reconnect + connectivity: a caller on a replay-safe endpoint rides out a
 * transient disconnect (ws drop or HTTP network failure), waits for connectivity to
 * return, and re-issues the request instead of rejecting — while side-effecting
 * endpoints stay opt-in (`force`). Also covers `client.connection` / caller
 * `onOnline`/`onOffline` events. Uses the real in-process server + a controllable
 * fake `WebSocket`, matching `ws-transport.test.ts` conventions (real timers).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { z } from 'zod';
import { spec, endpoint, implement, server, client, wsTransport, ApiError, type WebSocketLike, type WsMessageEvent, type WsConn, type ConnStatus } from '../src/index';

const calls = { read: 0, write: 0, get: 0 };

const api = spec({
  endpoints: {
    // replay-safe by the method default (a GET, no explicit flag)
    getThing: endpoint({ method: 'GET', query: z.object({ id: z.string() }), response: z.object({ n: z.number() }) }),
    // replay-safe via the explicit flag (a POST, so it also travels over ws)
    read: endpoint({ method: 'POST', sideEffects: false, body: z.object({ id: z.string() }), response: z.object({ n: z.number() }) }),
    // default side-effecting (POST, no flag) — must not replay unless forced
    write: endpoint({ method: 'POST', body: z.object({ v: z.string() }), response: z.object({ n: z.number() }) }),
    // replay-safe but the handler throws a non-connection error
    boom: endpoint({ method: 'POST', sideEffects: false, response: z.object({ ok: z.boolean() }) }),
  },
});

const app = server(api, [
  implement(api).handlers({
    getThing: () => ({ n: ++calls.get }),
    read: () => ({ n: ++calls.read }),
    write: () => ({ n: ++calls.write }),
    boom: () => {
      throw new Error('boom');
    },
  }),
]);

/** Fake WebSocket bound to `app.ws`; `drop()` simulates a network close. */
class FakeWS implements WebSocketLike {
  static last: FakeWS | null = null;
  static constructed = 0;
  private readonly listeners = new Map<string, ((ev: WsMessageEvent) => void)[]>();
  private conn: WsConn | null = null;
  constructor(readonly url: string) {
    FakeWS.last = this;
    FakeWS.constructed++;
    setTimeout(() => this.open(), 1);
  }
  private open() {
    this.conn = app.ws.open((frame) => this.fire('message', { data: frame }), new Request('http://test/ws'));
    this.fire('open', {});
  }
  addEventListener(type: 'open' | 'message' | 'close' | 'error', listener: (event: WsMessageEvent) => void) {
    const arr = this.listeners.get(type) ?? [];
    arr.push(listener);
    this.listeners.set(type, arr);
  }
  private fire(type: string, ev: WsMessageEvent) {
    for (const l of this.listeners.get(type) ?? []) {l(ev);}
  }
  send(data: string) {
    if (this.conn) {void app.ws.message(this.conn, data);}
  }
  close() {
    this.drop();
  }
  drop() {
    if (this.conn) {app.ws.close(this.conn);}
    this.conn = null;
    this.fire('close', {});
  }
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

function wsClient(opts: Parameters<typeof wsTransport>[1] = {}) {
  const transport = wsTransport('ws://test/ws', { WebSocket: FakeWS, heartbeat: false, backoff: { initial: 5, jitter: false }, ...opts });
  const sdk = client<typeof api>({ baseUrl: 'http://test', manifest: app.manifest(), fetchImpl: (req) => app.fetch(req), ws: transport, prefer: 'ws' });
  return { transport, sdk };
}

beforeEach(() => {
  calls.read = 0;
  calls.write = 0;
  calls.get = 0;
});

describe('caller — replay on reconnect (ws)', () => {
  it('rides out a disconnect and resends a replay-safe call once', async () => {
    const { transport, sdk } = wsClient();
    const c = sdk.caller('read', { replay: true });
    await c.call({ id: 'warm' }); // open + establish the connection
    const warmed = calls.read;

    FakeWS.last!.drop(); // socket down; next send fails fast, then the transport reconnects
    const p = c.call({ id: 'x' }); // rejects DISCONNECTED internally → replay waits for reconnect
    const res = await p;

    expect(res.n).toBeGreaterThan(0);
    expect(calls.read).toBe(warmed + 1); // handler ran exactly once for the replayed call (first attempt never reached the server)
    transport.close();
  });

  it('does not replay a side-effecting call by default', async () => {
    const { transport, sdk } = wsClient();
    const c = sdk.caller('write'); // default POST → not replay-safe
    await c.call({ v: 'warm' });
    const warmed = calls.write;

    FakeWS.last!.drop();
    await expect(c.call({ v: 'x' })).rejects.toMatchObject({ code: 'DISCONNECTED' });
    expect(calls.write).toBe(warmed); // never resent
    transport.close();
  });

  it('replays a side-effecting call when force is set', async () => {
    const { transport, sdk } = wsClient();
    const c = sdk.caller('write', { replay: { force: true } });
    await c.call({ v: 'warm' });
    const warmed = calls.write;

    FakeWS.last!.drop();
    const res = await c.call({ v: 'x' });
    expect(res.n).toBe(warmed + 1);
    transport.close();
  });

  it('cancel() aborts a call waiting to replay', async () => {
    // HTTP with a never-recovering network + long backoff: the call parks in the replay wait
    // until cancel() aborts it (ws would lazily reconnect on send, resolving too fast to observe).
    const sdk = client<typeof api>({ baseUrl: 'http://test', manifest: app.manifest(), fetchImpl: () => Promise.reject(new TypeError('down')) });
    const c = sdk.caller('read', { replay: { backoff: 10_000 } });

    const p = c.call({ id: 'x' });
    await wait(5); // first attempt fails, call enters the replay wait
    c.cancel();
    await expect(p).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('lastOnly supersedes a call waiting to replay', async () => {
    const { transport, sdk } = wsClient({ backoff: { initial: 30, jitter: false } });
    const c = sdk.caller('read', { replay: true, lastOnly: true });
    await c.call({ id: 'warm' });
    const warmed = calls.read;

    FakeWS.last!.drop();
    const a = c.call({ id: 'a' }).catch((e) => e); // will be superseded while waiting
    const b = c.call({ id: 'b' }); // supersedes a
    const [aRes, bRes] = await Promise.all([a, b]);

    expect((aRes as Error).name).toBe('AbortError');
    expect(bRes.n).toBeGreaterThan(0);
    expect(calls.read).toBe(warmed + 1); // only b reached the server
    transport.close();
  });
});

describe('caller — replay on reconnect (http)', () => {
  it('replays a GET by default with zero config', async () => {
    let attempts = 0;
    const flaky = (req: Request): Promise<Response> => {
      attempts += 1;
      if (attempts === 1) {return Promise.reject(new TypeError('down'));}
      return app.fetch(req);
    };
    const sdk = client<typeof api>({ baseUrl: 'http://test', manifest: app.manifest(), fetchImpl: flaky });
    const c = sdk.caller('getThing'); // no replay option → default-on because GET is replay-safe
    const res = await c.call({ id: 'x' });
    expect(res.n).toBe(1);
    expect(attempts).toBe(2);
    expect(calls.get).toBe(1);
  });

  it('rides out a network failure and resends once', async () => {
    let attempts = 0;
    const flaky = (req: Request): Promise<Response> => {
      attempts += 1;
      if (attempts === 1) {return Promise.reject(new TypeError('Network request failed'));}
      return app.fetch(req);
    };
    const sdk = client<typeof api>({ baseUrl: 'http://test', manifest: app.manifest(), fetchImpl: flaky });
    const c = sdk.caller('read', { replay: { backoff: 10 } }); // no online edge in Node → relies on the bounded fallback

    const res = await c.call({ id: 'x' });
    expect(res.n).toBe(1);
    expect(attempts).toBe(2); // failed once, replayed once
    expect(calls.read).toBe(1); // server saw only the successful attempt
    expect(sdk.connection.status).toBe('online'); // a successful response restored online
  });

  it('gives up after the retry budget and rejects DISCONNECTED', async () => {
    let attempts = 0;
    const dead = (): Promise<Response> => {
      attempts += 1;
      return Promise.reject(new TypeError('Network request failed'));
    };
    const sdk = client<typeof api>({ baseUrl: 'http://test', manifest: app.manifest(), fetchImpl: dead });
    const c = sdk.caller('read', { replay: { maxRetries: 2, backoff: 5 } });

    await expect(c.call({ id: 'x' })).rejects.toMatchObject({ code: 'DISCONNECTED' });
    expect(attempts).toBe(3); // initial + 2 replays
    expect(sdk.connection.status).toBe('offline');
  });

  it('gives up after the time budget and rejects DISCONNECTED', async () => {
    let attempts = 0;
    const dead = (): Promise<Response> => {
      attempts += 1;
      return Promise.reject(new TypeError('down'));
    };
    const sdk = client<typeof api>({ baseUrl: 'http://test', manifest: app.manifest(), fetchImpl: dead });
    const c = sdk.caller('read', { replay: { timeout: 12, backoff: 5 } });
    await expect(c.call({ id: 'x' })).rejects.toMatchObject({ code: 'DISCONNECTED' });
    expect(attempts).toBeGreaterThanOrEqual(2);
  });

  it('surfaces a network failure as an ApiError when replay is disabled', async () => {
    const sdk = client<typeof api>({ baseUrl: 'http://test', manifest: app.manifest(), fetchImpl: () => Promise.reject(new TypeError('boom')) });
    const c = sdk.caller('read', { replay: false });
    const err = await c.call({ id: 'x' }).catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 0, code: 'DISCONNECTED' });
  });

  it('does not replay a non-connection error (real app failure)', async () => {
    const sdk = client<typeof api>({ baseUrl: 'http://test', manifest: app.manifest(), fetchImpl: (req) => app.fetch(req) });
    const c = sdk.caller('boom', { replay: true }); // replay-safe endpoint, but a 500 is not a disconnect
    await expect(c.call()).rejects.toMatchObject({ status: 500 });
  });
});

describe('connectivity events', () => {
  it('emits offline/online across a ws drop + reconnect on both client and caller', async () => {
    const { transport, sdk } = wsClient();
    const clientEvents: ConnStatus[] = [];
    const callerEvents: string[] = [];
    sdk.connection.subscribe((s) => clientEvents.push(s));
    sdk.caller('read', { onOnline: () => callerEvents.push('online'), onOffline: () => callerEvents.push('offline') });

    await sdk.call('read', { id: 'warm' }); // connect → online
    clientEvents.length = 0;
    callerEvents.length = 0;

    FakeWS.last!.drop();
    await wait(25); // reconnect

    expect(clientEvents).toEqual(['offline', 'online']);
    expect(callerEvents).toEqual(['offline', 'online']);
    expect(sdk.connection.status).toBe('online');
    transport.close();
  });

  it('transport.onState unsubscribe stops further notifications', async () => {
    const { transport } = wsClient();
    const seen: string[] = [];
    const off = transport.onState((s) => seen.push(s));
    transport.connect();
    await wait(5); // connecting → open
    const n = seen.length;
    expect(n).toBeGreaterThan(0);
    off();
    FakeWS.last!.drop();
    await wait(25); // reconnect churn — must not reach the unsubscribed listener
    expect(seen.length).toBe(n);
    transport.close();
  });
});
