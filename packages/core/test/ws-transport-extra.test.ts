/**
 * Extra {@link wsTransport} branch coverage: missing-WebSocket guard, default
 * heartbeat tuning via an empty options object, the heartbeat interval guard +
 * deadline re-arm, terminal-frame openCalls bookkeeping (ok/end), jitter backoff,
 * manual-close during a scheduled reconnect, lazy-connect short-circuit, and the
 * unsub replay-map cleanup.
 */
import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import { spec, endpoint, implement, server, client, wsTransport, type WebSocketLike, type WsMessageEvent, type WsConn } from '../src/index';

const api = spec({
  endpoints: {
    echo: endpoint({ body: z.object({ msg: z.string() }), response: z.object({ echoed: z.string() }) }),
    nothing: endpoint({ response: z.object({ ok: z.boolean() }) }),
  },
  events: {
    tick: { params: z.object({ room: z.string() }), data: z.object({ n: z.number() }) },
  },
});

const app = server(api, [
  implement(api).handlers({
    echo: ({ data }) => ({ echoed: data.msg }),
    nothing: () => ({ ok: true }),
  }),
]);

class FakeWS implements WebSocketLike {
  static last: FakeWS | null = null;
  static constructed = 0;
  private readonly listeners = new Map<string, ((ev: WsMessageEvent) => void)[]>();
  private conn: WsConn | null = null;
  sent: string[] = [];
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
  inject(data: string) {
    this.fire('message', { data });
  }
  send(data: string) {
    this.sent.push(data);
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

describe('wsTransport guards & defaults', () => {
  it('throws when no WebSocket implementation is available', () => {
    const g = globalThis as unknown as { WebSocket?: unknown };
    const had = 'WebSocket' in g;
    const prev = g.WebSocket;
    delete g.WebSocket; // neither opts.WebSocket nor the global is present
    try {
      expect(() => wsTransport('ws://x', { WebSocket: undefined as unknown as typeof FakeWS })).toThrow(/no WebSocket implementation/);
    } finally {
      if (had) {g.WebSocket = prev;}
    }
  });

  it('falls back to the ambient global WebSocket when none is passed', () => {
    const g = globalThis as unknown as { WebSocket?: unknown };
    const had = 'WebSocket' in g;
    const prev = g.WebSocket;
    g.WebSocket = FakeWS;
    try {
      const t = wsTransport('ws://x'); // reads the global
      expect(t.state).toBe('closed');
      t.close();
    } finally {
      if (had) {g.WebSocket = prev;}
      else {delete g.WebSocket;}
    }
  });

  it('accepts an empty heartbeat object and uses the defaults', async () => {
    // heartbeat: {} is truthy → DEFAULT_HEARTBEAT merge branch (interval 30s, won't fire in-test)
    const t = wsTransport('ws://x', { WebSocket: FakeWS, heartbeat: {}, backoff: { initial: 5, jitter: false } });
    t.connect();
    await tick();
    expect(t.state).toBe('open');
    t.close();
  });
});

describe('wsTransport heartbeat internals', () => {
  it('re-arms the deadline on each interval (clears the still-pending one)', async () => {
    // A socket that never pongs: each ping leaves a pending deadline, so the next
    // ping hits the `if (hbDeadline) clearTimeout` re-arm branch (line 159).
    class NoPongWS extends FakeWS {
      send(data: string) {
        if (data.includes('"ping"')) {return;} // swallow pings (no pong)
        super.send(data);
      }
    }
    const pinged: number[] = [];
    class CountWS extends NoPongWS {
      send(data: string) {
        if (data.includes('"ping"')) {pinged.push(1); return;}
        super.send(data);
      }
    }
    // interval 5ms, timeout 1000ms: deadline stays pending across pings
    const t = wsTransport('ws://x', { WebSocket: CountWS, heartbeat: { interval: 5, timeout: 1000 } });
    t.connect();
    await tick();
    await new Promise((r) => setTimeout(r, 30)); // several ping intervals
    expect(pinged.length).toBeGreaterThanOrEqual(2);
    t.close();
  });

  it('a missed pong forces the socket closed (heartbeat-timeout reconnect)', async () => {
    let closed = 0;
    class NoPongWS extends FakeWS {
      send(data: string) {
        // swallow pings (never auto-pong); forward real calls
        if (data.includes('"ping"')) {return;}
        super.send(data);
      }
      close() {
        closed++;
        super.close();
      }
    }
    const t = wsTransport('ws://x', { WebSocket: NoPongWS, heartbeat: { interval: 5, timeout: 5 }, backoff: { initial: 1000, jitter: false } });
    t.connect();
    await tick();
    await new Promise((r) => setTimeout(r, 25)); // ping fires, no pong, deadline elapses → sock.close()
    expect(closed).toBeGreaterThan(0);
    t.close();
  });
});

describe('wsTransport openCalls terminal frames', () => {
  it('clears an in-flight call on a { $status: 200 } terminal frame (no stale DISCONNECTED on later drop)', async () => {
    const t = wsTransport('ws://x', { WebSocket: FakeWS, heartbeat: false, backoff: { initial: 5, jitter: false } });
    const frames: Record<string, unknown>[] = [];
    t.onMessage((raw) => {
      try {
        frames.push(JSON.parse(raw) as Record<string, unknown>);
      } catch {
        /* ignore */
      }
    });
    t.connect();
    await tick();
    // hand-send a call frame, then have the server-side reply route an { id, ok: true } terminal
    FakeWS.last!.send(JSON.stringify({ id: 'k1', type: '/x', method: 'POST', data: {} }));
    // simulate the terminal response frame coming back (the `$status` branch)
    FakeWS.last!.inject(JSON.stringify({ id: 'k1', $status: 200, data: null }));
    FakeWS.last!.drop();
    await tick();
    const disconnects = frames.filter((f) => f.id === 'k1' && f.$code === 'DISCONNECTED');
    expect(disconnects).toEqual([]); // already terminal → not re-failed
    t.close();
  });

  it('clears an in-flight call on an { end: true } terminal frame', async () => {
    const t = wsTransport('ws://x', { WebSocket: FakeWS, heartbeat: false, backoff: { initial: 5, jitter: false } });
    const frames: Record<string, unknown>[] = [];
    t.onMessage((raw) => {
      try {
        frames.push(JSON.parse(raw) as Record<string, unknown>);
      } catch {
        /* ignore */
      }
    });
    t.connect();
    await tick();
    FakeWS.last!.send(JSON.stringify({ id: 'k2', type: '/x', method: 'POST', data: {} }));
    FakeWS.last!.inject(JSON.stringify({ id: 'k2', end: true }));
    FakeWS.last!.drop();
    await tick();
    const disconnects = frames.filter((f) => f.id === 'k2' && f.$code === 'DISCONNECTED');
    expect(disconnects).toEqual([]);
    t.close();
  });
});

describe('wsTransport backoff jitter & lifecycle', () => {
  it('applies jittered backoff (default jitter: true) on reconnect', async () => {
    const randSpy = vi.spyOn(Math, 'random').mockReturnValue(0.5);
    try {
      const t = wsTransport('ws://x', { WebSocket: FakeWS, heartbeat: false, backoff: { initial: 5 } }); // jitter defaults true
      t.connect();
      await tick();
      const built = FakeWS.constructed;
      FakeWS.last!.drop();
      await new Promise((r) => setTimeout(r, 30));
      expect(FakeWS.constructed).toBe(built + 1); // jittered delay elapsed → reconnected
      expect(randSpy).toHaveBeenCalled();
      t.close();
    } finally {
      randSpy.mockRestore();
    }
  });

  it('manual close during a scheduled reconnect stops it (no further sockets)', async () => {
    const t = wsTransport('ws://x', { WebSocket: FakeWS, heartbeat: false, backoff: { initial: 1000, jitter: false } });
    t.connect();
    await tick();
    const built = FakeWS.constructed;
    FakeWS.last!.drop(); // schedules a reconnect ~1000ms out
    t.close(); // manualClose = true; the pending timer should never construct
    await new Promise((r) => setTimeout(r, 10));
    expect(FakeWS.constructed).toBe(built);
    expect(t.state).toBe('closed');
  });

  it('connect() is a no-op while a socket already exists', async () => {
    const t = wsTransport('ws://x', { WebSocket: FakeWS, heartbeat: false });
    t.connect();
    await tick();
    const built = FakeWS.constructed;
    t.connect(); // sock != null → early return (line 221)
    expect(FakeWS.constructed).toBe(built);
    t.close();
  });
});

describe('wsTransport subscription replay map', () => {
  it('drops a sub from the replay map on unsub (not replayed after reconnect)', async () => {
    const sdk = client<typeof api>({ baseUrl: 'http://test', manifest: app.manifest(), fetchImpl: (req) => app.fetch(req), ws: wsTransport('ws://test/ws', { WebSocket: FakeWS, heartbeat: false, backoff: { initial: 5, jitter: false } }) });
    const got: number[] = [];
    const off = sdk.on('tick', { room: 'z' }, (d) => got.push(d.n));
    await tick();
    off(); // sends an unsub frame → subs.delete branch (line 251)
    await tick();
    const built = FakeWS.constructed;
    FakeWS.last!.drop();
    await new Promise((r) => setTimeout(r, 20)); // reconnect; nothing should be resubscribed
    expect(FakeWS.constructed).toBe(built + 1);
    await tick();
    app.emit('tick', { room: 'z' }, { n: 9 });
    await tick();
    expect(got).toEqual([]); // unsubscribed before the drop → no delivery
  });

  it('canon handles a null params value (broadcast-style sub)', async () => {
    // send a sub frame with no params at all → canon(undefined) branch (line 140)
    const t = wsTransport('ws://x', { WebSocket: FakeWS, heartbeat: false, backoff: { initial: 5, jitter: false } });
    t.connect();
    await tick();
    expect(() => t.send(JSON.stringify({ sub: 'sys:notice' }))).not.toThrow();
    expect(() => t.send(JSON.stringify({ unsub: 'sys:notice' }))).not.toThrow();
    t.close();
  });
});
