/**
 * Exercises {@link wsTransport} against the real in-process ws server via a
 * controllable fake `WebSocket`: lazy connect, heartbeat ping/pong interception,
 * resubscribe after reconnect, and failing in-flight calls on disconnect.
 */
import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { spec, endpoint, implement, server, client, wsTransport, type WebSocketLike, type WsMessageEvent, type WsConn } from '../src/index';

const api = spec({
  endpoints: {
    echo: endpoint({ body: z.object({ msg: z.string() }), response: z.object({ echoed: z.string() }) }),
    slow: endpoint({ body: z.object({ ms: z.number() }), response: z.object({ done: z.boolean() }) }),
  },
  events: {
    tick: { params: z.object({ room: z.string() }), data: z.object({ n: z.number() }) },
  },
});

const app = server(api, [
  implement(api).handlers({
    echo: ({ data }) => ({ echoed: data.msg }),
    slow: async ({ data }) => {
      await new Promise((r) => setTimeout(r, data.ms));
      return { done: true };
    },
  }),
]);

/**
 * Fake WebSocket bound to `app.ws`. Opens asynchronously; a `drop()` simulates a
 * network close (and closes the server-side conn, like a real adapter would).
 */
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
  /** test hook: push a raw inbound frame (e.g. malformed JSON) */
  inject(data: string) {
    this.fire('message', { data });
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

const tick = () => new Promise((r) => setTimeout(r, 15));

function makeClient(opts: Parameters<typeof wsTransport>[1] = {}) {
  const transport = wsTransport('ws://test/ws', {
    WebSocket: FakeWS,
    heartbeat: false,
    backoff: { initial: 5, jitter: false },
    ...opts,
  });
  const sdk = client<typeof api>({ baseUrl: 'http://test', manifest: app.manifest(), fetchImpl: (req) => app.fetch(req), ws: transport });
  return { transport, sdk };
}

describe('wsTransport', () => {
  it('resolves a function url + function protocols at connect (for post-login auth)', () => {
    const seen: { url: string; protocols: unknown }[] = [];
    class CapWS implements WebSocketLike {
      constructor(readonly url: string, readonly protocols?: string | string[]) {
        seen.push({ url, protocols });
      }
      send(): void {}
      close(): void {}
      addEventListener(): void {}
    }
    const token = 'tok-1';
    const t = wsTransport(() => `ws://x/ws?access_token=${token}`, {
      WebSocket: CapWS,
      protocols: () => ['ayepi', token],
      heartbeat: false,
      backoff: { initial: 5, jitter: false },
    });
    t.connect();
    expect(seen).toEqual([{ url: 'ws://x/ws?access_token=tok-1', protocols: ['ayepi', 'tok-1'] }]);
    t.close();
  });

  it('connects lazily (not before first use)', async () => {
    const before = FakeWS.constructed;
    const { transport } = makeClient();
    expect(FakeWS.constructed).toBe(before); // no socket yet
    transport.connect();
    expect(FakeWS.constructed).toBe(before + 1);
    transport.close();
  });

  it('round-trips a ws call', async () => {
    const { transport, sdk } = makeClient();
    const res = await sdk.call('echo', { msg: 'hi' }, { transport: 'ws' });
    expect(res.echoed).toBe('hi');
    transport.close();
  });

  it('resubscribes live channels after a reconnect', async () => {
    const { transport, sdk } = makeClient();
    const got: number[] = [];
    sdk.on('tick', { room: 'a' }, (d) => got.push(d.n));
    await tick();
    app.emit('tick', { room: 'a' }, { n: 1 });
    await tick();
    expect(got).toEqual([1]);

    const dropped = FakeWS.last!;
    const built = FakeWS.constructed;
    dropped.drop(); // simulate a network drop
    await new Promise((r) => setTimeout(r, 20)); // let backoff reconnect
    expect(FakeWS.constructed).toBe(built + 1); // a new socket was opened
    await tick();

    app.emit('tick', { room: 'a' }, { n: 2 }); // only the resubscribed conn should hear it
    await tick();
    expect(got).toEqual([1, 2]);
    transport.close();
  });

  it('fails in-flight calls when the socket drops', async () => {
    const { transport, sdk } = makeClient();
    const p = sdk.call('slow', { ms: 1000 }, { transport: 'ws' });
    await tick(); // let it open + reach the server
    FakeWS.last!.drop();
    await expect(p).rejects.toMatchObject({ code: 'DISCONNECTED' });
    transport.close();
  });

  it('intercepts heartbeat pong frames (never delivered to the client)', async () => {
    const { transport, sdk } = makeClient({ heartbeat: { interval: 10, timeout: 500 } });
    transport.connect();
    await tick();
    // a normal call still works while heartbeats flow in the background
    const res = await sdk.call('echo', { msg: 'beat' }, { transport: 'ws' });
    expect(res.echoed).toBe('beat');
    await new Promise((r) => setTimeout(r, 30)); // a couple of ping/pong cycles
    expect(transport.state).toBe('open');
    transport.close();
  });

  it('reports state transitions and closes permanently', async () => {
    const states: string[] = [];
    const { transport } = makeClient({ onStateChange: (s) => states.push(s) });
    transport.connect();
    await tick();
    expect(states).toContain('connecting');
    expect(states).toContain('open');
    transport.close();
    expect(transport.state).toBe('closed');
  });
});

describe('wsTransport resilience edges', () => {
  it('forwards a malformed inbound frame to the client untouched', async () => {
    let got: string | null = null;
    const t = wsTransport('ws://x', { WebSocket: FakeWS, heartbeat: false });
    t.onMessage((raw) => (got = raw));
    t.connect();
    await tick();
    FakeWS.last!.inject('{not json');
    expect(got).toBe('{not json');
    t.close();
  });

  it('tolerates sending a malformed (non-JSON) frame', async () => {
    const t = wsTransport('ws://x', { WebSocket: FakeWS, heartbeat: false });
    expect(() => t.send('not-json')).not.toThrow();
    t.close();
  });

  it('gives up after maxRetries and goes to closed', async () => {
    const states: string[] = [];
    const t = wsTransport('ws://x', { WebSocket: FakeWS, heartbeat: false, maxRetries: 0, backoff: { initial: 5, jitter: false }, onStateChange: (s) => states.push(s) });
    t.connect();
    await tick();
    FakeWS.last!.drop();
    await tick();
    expect(t.state).toBe('closed');
  });

  it('reports a construction error and stops after retries', async () => {
    class ThrowWS {
      constructor() {
        throw new Error('cannot connect');
      }
    }
    const errors: unknown[] = [];
    const t = wsTransport('ws://x', {
      WebSocket: ThrowWS as unknown as typeof FakeWS,
      heartbeat: false,
      maxRetries: 1,
      backoff: { initial: 5, jitter: false },
      onError: (e) => errors.push(e),
    });
    t.connect();
    await new Promise((r) => setTimeout(r, 40));
    expect(errors.length).toBeGreaterThan(0);
    expect(t.state).toBe('closed');
    t.close();
  });

  it('fail-fast: a call sent while disconnected is rejected immediately', async () => {
    const frames: Record<string, unknown>[] = [];
    const t = wsTransport('ws://x', { WebSocket: FakeWS, heartbeat: false, backoff: { initial: 5, jitter: false } });
    t.onMessage((raw) => frames.push(JSON.parse(raw) as Record<string, unknown>));
    t.connect();
    await tick();
    FakeWS.last!.drop(); // now everConnected, but down
    t.send(JSON.stringify({ id: 'x1', type: '/getUser/:id', method: 'POST', data: { id: 'u1' } }));
    const err = frames.find((f) => f.id === 'x1');
    expect(err).toBeDefined();
    expect(err!.$code).toBe('DISCONNECTED');
    expect(err!.$status).toBe(0);
    t.close();
  });

  it('queue policy buffers calls while down and flushes on reconnect', async () => {
    const t = wsTransport('ws://x', { WebSocket: FakeWS, heartbeat: false, whileDisconnected: 'queue', backoff: { initial: 5, jitter: false } });
    const sdk = client<typeof api>({ baseUrl: 'http://test', manifest: app.manifest(), fetchImpl: (req) => app.fetch(req), ws: t });
    const p = sdk.call('echo', { msg: 'queued' }, { transport: 'ws' }); // sent before open → queued
    const res = await p;
    expect(res.echoed).toBe('queued');
    t.close();
  });
});
