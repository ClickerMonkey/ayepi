/**
 * Two-way calls on one socket: the accepting server calls the connecting client back through {@link peers}, and the
 * client serves its own spec through `serve`. The link here is in-process (frames hop straight between the two ws
 * handlers) with a drop / reconnect switch, so every behaviour is deterministic.
 */
import { describe, it, expect, expectTypeOf } from 'vitest';
import { z } from 'zod';
import {
  ApiError,
  REVERSE_ID,
  client,
  endpoint,
  implement,
  peers,
  server,
  spec,
  wsTransport,
  type ClientWs,
  type Peer,
  type Server,
  type WebSocketCtor,
  type WebSocketLike,
  type WsConn,
  type WsMessageEvent,
} from '../src/index';

const wait = (ms = 5) => new Promise((r) => setTimeout(r, ms));

/* ---- the spec the connecting side serves (the hub calls it) ---- */
const systemLink = spec({
  endpoints: {
    ping: endpoint({ response: z.object({ pong: z.literal(true) }) }),
    run: endpoint({
      body: z.object({ fn: z.string(), n: z.number() }),
      response: z.object({ out: z.string() }),
      errors: { 422: z.object({ reason: z.string() }) },
    }),
    status: endpoint({ ws: 'sys:status', body: z.object({ of: z.string() }), response: z.object({ state: z.string() }) }),
    rows: endpoint({ body: z.object({ n: z.number() }), streamOut: z.object({ i: z.number() }) }),
    sum: endpoint({ streamIn: z.object({ v: z.number() }), response: z.object({ total: z.number() }) }),
    scale: endpoint({ query: z.object({ by: z.coerce.number() }), streamIn: z.object({ v: z.number() }), streamOut: z.object({ v: z.number() }) }),
    pick: endpoint({ body: z.object({ fresh: z.boolean() }), responses: { 200: z.object({ cached: z.string() }), 201: z.object({ made: z.string() }) } }),
    lie: endpoint({ response: z.object({ n: z.number() }) }),
    nothing: endpoint({ body: z.object({ x: z.number() }) }),
  },
  events: {
    changed: { params: z.object({ uri: z.string() }), data: z.object({ version: z.number() }) },
  },
});
type SystemLink = typeof systemLink;

/* ---- the spec the accepting side serves (the system calls it) ---- */
const hubLink = spec({
  endpoints: {
    hello: endpoint({ body: z.object({ name: z.string() }), response: z.object({ welcome: z.string(), sawPong: z.boolean() }) }),
    progress: endpoint({ body: z.object({ run: z.string(), pct: z.number() }) }),
  },
});

interface Rig {
  readonly systems: ReturnType<typeof peers<SystemLink>>;
  readonly sdk: ReturnType<typeof client<typeof hubLink>>;
  /** The hub-side connection currently open (throws when dropped). */
  conn(): WsConn;
  /** The hub's peer for the open connection. */
  peer(): Peer<SystemLink>;
  /** Drop the socket: both sides see it close. */
  drop(): void;
  /** Open a fresh socket. */
  connect(): void;
  /** Raw frames the hub sent the system. */
  readonly toSystem: Record<string, unknown>[];
  /** Raw frames the system sent the hub. */
  readonly toHub: Record<string, unknown>[];
  /** Served calls the system saw abort. */
  readonly aborted: string[];
  /** Progress the hub received from the system. */
  readonly progress: { run: string; pct: number }[];
  /** Emit a system event. */
  emitChanged(uri: string, version: number): void;
  /** The hub server. */
  readonly hub: Server<typeof hubLink>;
  /** Hand a raw frame to the system's client, as if the hub sent it. */
  toClient(raw: string): void;
}

/** Wire a hub and a system over an in-process socket. */
function rig(opts: { validate?: boolean } = {}): Rig {
  const systems = peers(systemLink, opts.validate === undefined ? undefined : { validate: opts.validate });
  const toSystem: Record<string, unknown>[] = [];
  const toHub: Record<string, unknown>[] = [];
  const aborted: string[] = [];
  const progress: { run: string; pct: number }[] = [];

  const hub = server(hubLink, [
    implement(hubLink).handlers({
      hello: async ({ data, conn }) => {
        const pong = await systems.of(conn!).call('ping');
        return { welcome: `hi ${data.name}`, sawPong: pong.pong };
      },
      progress: ({ data }) => void progress.push(data),
    }),
  ], { peers: systems });

  let sdkRef: Rig['sdk'] | null = null;
  const local = server(systemLink, [
    implement(systemLink).handlers({
      ping: () => ({ pong: true as const }),
      run: async ({ data, fail, signal }) => {
        if (data.fn === 'bad') {fail(422, { reason: `cannot ${data.fn}` });}
        if (data.fn === 'boom') {throw new Error('exploded');}
        if (data.fn === 'slow') {
          await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
          aborted.push(data.fn);
          return { out: 'late' };
        }
        if (data.fn === 'callback') {await sdkRef!.call('progress', { run: 'r1', pct: data.n }, { transport: 'ws' });}
        return { out: `${data.fn}:${data.n}` };
      },
      status: ({ data }) => ({ state: `${data.of} ok` }),
      rows: async function* ({ data }) {
        for (let i = 0; i < data.n; i++) {yield { i };}
      },
      sum: async ({ stream }) => {
        let total = 0;
        for await (const item of stream) {total += item.v;}
        return { total };
      },
      scale: async function* ({ data, stream }) {
        for await (const item of stream) {yield { v: item.v * data.by };}
      },
      pick: ({ data }) => (data.fresh ? { status: 201, data: { made: 'new' } } : { status: 200, data: { cached: 'old' } }),
      lie: () => ({ n: 1 }),
      nothing: () => {},
    }),
  ]);

  let conn: WsConn | null = null;
  let deliver: (frame: string) => void = () => {};
  const states = new Set<(s: 'closed' | 'connecting' | 'open') => void>();
  const ws: ClientWs = {
    send: (frame) => {
      toHub.push(JSON.parse(frame) as Record<string, unknown>);
      if (conn) {void hub.ws.message(conn, frame);}
    },
    onMessage: (cb) => {
      deliver = cb;
    },
    onState: (cb) => {
      states.add(cb);
      return () => void states.delete(cb);
    },
  };
  const sdk = client<typeof hubLink>({ baseUrl: 'http://hub', manifest: hubLink, ws, serve: local, prefer: 'ws' });
  sdkRef = sdk;

  const connect = () => {
    const opened = hub.ws.open((frame) => {
      if (conn !== opened) {return;}
      toSystem.push(JSON.parse(frame) as Record<string, unknown>);
      deliver(frame);
    }, new Request('http://hub/ws'));
    conn = opened;
    for (const cb of states) {cb('open');}
  };
  const drop = () => {
    const c = conn;
    conn = null;
    for (const cb of states) {cb('connecting');}
    if (c) {hub.ws.close(c);}
  };
  connect();

  return {
    systems,
    sdk,
    conn: () => {
      if (!conn) {throw new Error('dropped');}
      return conn;
    },
    peer: () => systems.of(conn!),
    drop,
    connect,
    toSystem,
    toHub,
    aborted,
    progress,
    emitChanged: (uri, version) => local.emit('changed', { uri }, { version }),
    hub,
    toClient: (raw) => deliver(raw),
  };
}

describe('peers: unary calls', () => {
  it('the hub calls the system and gets its typed result', async () => {
    const r = rig();
    const result = await r.peer().call('run', { fn: 'read', n: 2 });
    expect(result).toEqual({ out: 'read:2' });
  });

  it('a data-less endpoint takes only options', async () => {
    const r = rig();
    expect(await r.peer().call('ping')).toEqual({ pong: true });
  });

  it('an endpoint addressed by explicit ws id', async () => {
    const r = rig();
    expect(await r.peer().call('status', { of: 'fs' })).toEqual({ state: 'fs ok' });
    expect(r.toSystem.some((f) => f.type === 'sys:status')).toBe(true);
  });

  it('a void endpoint resolves undefined', async () => {
    const r = rig();
    await expect(r.peer().call('nothing', { x: 1 })).resolves.toBeUndefined();
  });

  it('multi-status results are a { status, data } union', async () => {
    const r = rig();
    expect(await r.peer().call('pick', { fresh: true })).toEqual({ status: 201, data: { made: 'new' } });
    expect(await r.peer().call('pick', { fresh: false })).toEqual({ status: 200, data: { cached: 'old' } });
  });

  it('frames of hub calls are keyed rid, never id', async () => {
    const r = rig();
    await r.peer().call('run', { fn: 'a', n: 1 });
    const call = r.toSystem.find((f) => f.type === '/run');
    expect(call).toMatchObject({ [REVERSE_ID]: expect.any(String), method: 'POST', data: { fn: 'a', n: 1 } });
    expect(call && 'id' in call).toBe(false);
    const reply = r.toHub.find((f) => f[REVERSE_ID] === call?.[REVERSE_ID] && '$status' in f);
    expect(reply).toMatchObject({ $status: 200, data: { out: 'a:1' } });
    expect(reply && 'id' in reply).toBe(false);
  });

  it('both directions run at once on the same connection without id collisions', async () => {
    const r = rig();
    const [mine, theirs] = await Promise.all([
      r.sdk.call('hello', { name: 'fs' }, { transport: 'ws' }),
      Promise.all([1, 2, 3].map((n) => r.peer().call('run', { fn: 'x', n }))),
    ]);
    expect(mine).toEqual({ welcome: 'hi fs', sawPong: true });
    expect(theirs.map((t) => t.out)).toEqual(['x:1', 'x:2', 'x:3']);
    /* both sides numbered their calls from c1, in their own key */
    expect(r.toHub.some((f) => f.id === 'c1')).toBe(true);
    expect(r.toSystem.some((f) => f[REVERSE_ID] === 'c1')).toBe(true);
  });

  it('a served handler can call back to the hub while it runs', async () => {
    const r = rig();
    expect(await r.peer().call('run', { fn: 'callback', n: 40 })).toEqual({ out: 'callback:40' });
    expect(r.progress).toEqual([{ run: 'r1', pct: 40 }]);
  });

  it('the hub can reach the peer from inside its own handler (io.ws.conn)', async () => {
    const r = rig();
    expect(await r.sdk.call('hello', { name: 'fs' }, { transport: 'ws' })).toEqual({ welcome: 'hi fs', sawPong: true });
  });
});

describe('peers: errors', () => {
  it('a declared error rejects with its typed body', async () => {
    const r = rig();
    const err = await r.peer().call('run', { fn: 'bad', n: 0 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 422, data: { reason: 'cannot bad' } });
  });

  it('a thrown error rejects 500 INTERNAL', async () => {
    const r = rig();
    await expect(r.peer().call('run', { fn: 'boom', n: 0 })).rejects.toMatchObject({ status: 500, code: 'INTERNAL', message: 'exploded' });
  });

  it('input the system rejects comes back as VALIDATION', async () => {
    const r = rig();
    const bad = { fn: 'x', n: 'one' } as unknown as { fn: string; n: number }; // deliberately wrong at runtime
    await expect(r.peer().call('run', bad)).rejects.toMatchObject({ status: 400, code: 'VALIDATION' });
  });

  it('results are validated against the spec by default', async () => {
    const lying = spec({ endpoints: { lie: endpoint({ response: z.object({ n: z.string() }) }) } });
    const systems = peers(lying);
    const hub = server(hubLink, [implement(hubLink).handlers({ hello: () => ({ welcome: '', sawPong: false }), progress: () => {} })], { peers: systems });
    let deliver: (f: string) => void = () => {};
    let conn: WsConn | null = null;
    const local = server(systemLink, [rigHandlers()]);
    client<typeof hubLink>({
      baseUrl: 'http://hub',
      manifest: hubLink,
      serve: local,
      ws: { send: (f) => void hub.ws.message(conn!, f), onMessage: (cb) => void (deliver = cb) },
    });
    conn = hub.ws.open((f) => deliver(f), new Request('http://hub/ws'));
    /* the system answers { n: 1 } where the hub's copy of the spec says n is a string */
    await expect(systems.of(conn).call('lie')).rejects.toBeInstanceOf(z.ZodError);
  });

  it('validation can be switched off', async () => {
    const r = rig({ validate: false });
    expect(await r.peer().call('lie')).toEqual({ n: 1 });
  });

  it('a peer built from a manifest has nothing to validate with', async () => {
    const systems = peers<SystemLink>(server(systemLink, [rigHandlers()]).manifest());
    const hub = server(hubLink, [implement(hubLink).handlers({ hello: () => ({ welcome: '', sawPong: false }), progress: () => {} })], { peers: systems });
    let deliver: (f: string) => void = () => {};
    let conn: WsConn | null = null;
    client<typeof hubLink>({
      baseUrl: 'http://hub',
      manifest: hubLink,
      serve: server(systemLink, [rigHandlers()]),
      ws: { send: (f) => void hub.ws.message(conn!, f), onMessage: (cb) => void (deliver = cb) },
    });
    conn = hub.ws.open((f) => deliver(f), new Request('http://hub/ws'));
    expect(await systems.of(conn).call('run', { fn: 'm', n: 3 })).toEqual({ out: 'm:3' });
  });

  it('a client that serves nothing answers 501 NOT_SERVED', async () => {
    const systems = peers(systemLink);
    const hub = server(hubLink, [implement(hubLink).handlers({ hello: () => ({ welcome: '', sawPong: false }), progress: () => {} })], { peers: systems });
    let deliver: (f: string) => void = () => {};
    let conn: WsConn | null = null;
    client<typeof hubLink>({
      baseUrl: 'http://hub',
      manifest: hubLink,
      ws: { send: (f) => void hub.ws.message(conn!, f), onMessage: (cb) => void (deliver = cb) },
    });
    conn = hub.ws.open((f) => deliver(f), new Request('http://hub/ws'));
    await expect(systems.of(conn).call('ping')).rejects.toMatchObject({ status: 501, code: 'NOT_SERVED' });
    /* reverse frames that are not calls get no answer */
    deliver(JSON.stringify({ [REVERSE_ID]: 'c9', end: true }));
    deliver(JSON.stringify({ [REVERSE_ID]: null, type: 'changed', data: {} }));
  });

  it('a server without peers answers a rid frame BAD_FRAME', async () => {
    const hub = server(hubLink, [implement(hubLink).handlers({ hello: () => ({ welcome: '', sawPong: false }), progress: () => {} })]);
    const out: Record<string, unknown>[] = [];
    const conn = hub.ws.open((f) => void out.push(JSON.parse(f) as Record<string, unknown>), new Request('http://hub/ws'));
    await hub.ws.message(conn, JSON.stringify({ [REVERSE_ID]: 'c1', $status: 200 }));
    expect(out).toEqual([{ $status: 400, $code: 'BAD_FRAME', $error: 'this server makes no calls over the socket' }]);
  });

  it('a non-object frame is BAD_FRAME on the server and ignored by the client', async () => {
    const r = rig();
    const out: Record<string, unknown>[] = [];
    const hub = server(hubLink, [implement(hubLink).handlers({ hello: () => ({ welcome: '', sawPong: false }), progress: () => {} })]);
    const conn = hub.ws.open((f) => void out.push(JSON.parse(f) as Record<string, unknown>), new Request('http://hub/ws'));
    await hub.ws.message(conn, 'null');
    await hub.ws.message(conn, '[1]');
    expect(out.map((f) => f.$code)).toEqual(['BAD_FRAME', 'BAD_FRAME']);
    /* the system's client shrugs off junk from the socket */
    const before = r.toHub.length;
    r.toClient('{not json');
    r.toClient('7');
    expect(r.toHub.length).toBe(before);
    expect(await r.peer().call('ping')).toEqual({ pong: true });
  });

  it('peer calls never go over http', async () => {
    const r = rig();
    const loose = r.peer() as unknown as { call(name: string, data: unknown, opts: unknown): Promise<unknown> }; // deliberately bypassing the typed surface
    await expect(loose.call('run', { fn: 'x', n: 1 }, { transport: 'http' })).rejects.toMatchObject({ code: 'PEER_HTTP' });
  });
});

describe('peers: item streams', () => {
  it('streams items out of the system', async () => {
    const r = rig();
    const seen: number[] = [];
    for await (const row of r.peer().call('rows', { n: 4 })) {seen.push(row.i);}
    expect(seen).toEqual([0, 1, 2, 3]);
  });

  it('streams items into the system', async () => {
    const r = rig();
    const result = await r.peer().call('sum', undefined, {
      stream: async function* () {
        yield { v: 2 };
        yield { v: 5 };
      },
    });
    expect(result).toEqual({ total: 7 });
  });

  it('streams items both ways at once', async () => {
    const r = rig();
    const out: number[] = [];
    const items = r.peer().call('scale', { by: 10 }, { stream: [{ v: 1 }, { v: 2 }, { v: 3 }].values() as unknown as AsyncIterable<{ v: number }> });
    for await (const item of items) {out.push(item.v);}
    expect(out).toEqual([10, 20, 30]);
  });
});

describe('peers: cancellation', () => {
  it('aborting the hub call aborts the served handler', async () => {
    const r = rig();
    const ac = new AbortController();
    const pending = r.peer().call('run', { fn: 'slow', n: 0 }, { signal: ac.signal });
    await wait();
    ac.abort(new Error('changed my mind'));
    await expect(pending).rejects.toThrow('changed my mind');
    await wait();
    expect(r.aborted).toEqual(['slow']);
    expect(r.toSystem.some((f) => f.abort === true && typeof f[REVERSE_ID] === 'string')).toBe(true);
    /* the late result is never sent: the call was cancelled */
    expect(r.toHub.some((f) => (f.data as { out?: string } | undefined)?.out === 'late')).toBe(false);
  });

  it('an already-aborted signal rejects without waiting', async () => {
    const r = rig();
    await expect(r.peer().call('ping', { signal: AbortSignal.abort(new Error('no')) })).rejects.toThrow('no');
  });
});

describe('peers: connection lifecycle and reconnect', () => {
  it('a drop rejects every open hub call DISCONNECTED exactly once and aborts the served handler', async () => {
    const r = rig();
    const peer = r.peer();
    let settled = 0;
    const pending = peer.call('run', { fn: 'slow', n: 0 }).finally(() => settled++);
    await wait();
    r.drop();
    await expect(pending).rejects.toMatchObject({ status: 0, code: 'DISCONNECTED' });
    await wait();
    expect(settled).toBe(1);
    expect(r.aborted).toEqual(['slow']);
    expect(peer.open).toBe(false);
    expect(peer.signal.aborted).toBe(true);
    expect(peer.signal.reason).toMatchObject({ code: 'DISCONNECTED' });
  });

  it('a call on a closed peer rejects DISCONNECTED at once', async () => {
    const r = rig();
    const peer = r.peer();
    r.drop();
    await expect(peer.call('ping')).rejects.toMatchObject({ code: 'DISCONNECTED' });
    const rows = peer.call('rows', { n: 1 });
    await expect(rows[Symbol.asyncIterator]().next()).rejects.toMatchObject({ code: 'DISCONNECTED' });
  });

  it('a reconnect is a fresh peer that works, and the old one stays closed', async () => {
    const r = rig();
    const first = r.peer();
    r.drop();
    expect(r.systems.size).toBe(0);
    r.connect();
    const second = r.peer();
    expect(second).not.toBe(first);
    expect(await second.call('run', { fn: 'again', n: 1 })).toEqual({ out: 'again:1' });
    expect(first.open).toBe(false);
  });

  it('onOpen and onClose follow connections; unsubscribing stops them', async () => {
    const r = rig();
    const events: string[] = [];
    const offOpen = r.systems.onOpen((p) => events.push(`open ${p.conn.id}`));
    const offClose = r.systems.onClose((p) => events.push(`close ${p.conn.id} ${p.open}`));
    const id = r.conn().id;
    r.drop();
    r.connect();
    const next = r.conn().id;
    offOpen();
    offClose();
    r.drop();
    expect(events).toEqual([`close ${id} false`, `open ${next}`]);
  });

  it('the registry lists open peers and refuses unknown connections', () => {
    const r = rig();
    expect([...r.systems].map((p) => p.conn)).toEqual([r.conn()]);
    expect(r.systems.get(r.conn())).toBe(r.peer());
    const stranger = server(hubLink, [implement(hubLink).handlers({ hello: () => ({ welcome: '', sawPong: false }), progress: () => {} })]).ws.open(() => {}, new Request('http://x/'));
    expect(r.systems.get(stranger)).toBeUndefined();
    expect(() => r.systems.of(stranger)).toThrow(`connection ${stranger.id} has no open peer`);
  });

  it('closing a connection twice is harmless and notifies once', () => {
    const r = rig();
    const c = r.conn();
    let closes = 0;
    r.systems.onClose(() => closes++);
    r.drop();
    r.hub.ws.close(c);
    expect(closes).toBe(1);
    expect(r.systems.get(c)).toBeUndefined();
  });

  it('replies for calls that already settled are ignored', async () => {
    const r = rig();
    await r.peer().call('ping');
    const sent = r.toSystem.length;
    await r.hub.ws.message(r.conn(), JSON.stringify({ [REVERSE_ID]: 'c1', $status: 200, data: { pong: true } }));
    await r.hub.ws.message(r.conn(), JSON.stringify({ [REVERSE_ID]: 'c404', chunk: 1 }));
    expect(r.toSystem.length).toBe(sent);
    expect(await r.peer().call('ping')).toEqual({ pong: true });
  });

  it('a served frame from a dropped connection is not sent on the new one', async () => {
    const r = rig();
    const slow = r.peer().call('run', { fn: 'slow', n: 0 });
    await wait();
    r.drop();
    await expect(slow).rejects.toMatchObject({ code: 'DISCONNECTED' });
    r.connect();
    await wait();
    /* the aborted handler finished with 'late', but its connection is gone */
    expect(r.toHub.some((f) => (f.data as { out?: string } | undefined)?.out === 'late')).toBe(false);
  });
});

describe('peers: events from the connecting side', () => {
  it('the hub subscribes to the system and receives its events until the connection drops', async () => {
    const r = rig();
    const seen: number[] = [];
    const off = r.peer().on('changed', { uri: 'fs://a' }, (d) => seen.push(d.version));
    await wait();
    r.emitChanged('fs://a', 1);
    r.emitChanged('fs://b', 2);
    await wait();
    expect(seen).toEqual([1]);
    off();
    await wait();
    r.emitChanged('fs://a', 3);
    await wait();
    expect(seen).toEqual([1]);
    /* the event frame went to the hub keyed rid: null */
    expect(r.toHub.some((f) => f[REVERSE_ID] === null && f.type === 'changed')).toBe(true);
  });

  it('subscribing on a closed peer is a quiet no-op', async () => {
    const r = rig();
    const peer = r.peer();
    r.drop();
    const off = peer.on('changed', { uri: 'fs://a' }, () => {});
    off();
    await wait();
  });
});

describe('peers: definition-time checks', () => {
  it('a spec with http-only endpoints is refused', () => {
    const withFiles = spec({ endpoints: { upload: endpoint({ files: { doc: z.file() } }), ok: endpoint({}) } });
    // @ts-expect-error — http-only endpoints cannot be called over the socket
    expect(() => peers(withFiles)).toThrow('peer endpoints must work over ws; http-only: upload');
  });
});

describe('served link through a real wsTransport', () => {
  /** A fake WebSocket that hands frames straight to a hub server. */
  function fakeSockets(hub: Server<typeof hubLink>): { ctor: WebSocketCtor; kill(): void } {
    let current: { kill(): void } | null = null;
    class Fake implements WebSocketLike {
      readonly #listeners = new Map<string, ((e: WsMessageEvent) => void)[]>();
      readonly #conn: WsConn;
      #closed = false;
      constructor() {
        this.#conn = hub.ws.open((frame: string) => {
          if (!this.#closed) {this.#emit('message', { data: frame });}
        }, new Request('http://hub/ws'));
        current = { kill: () => this.close() };
        queueMicrotask(() => this.#emit('open', {}));
      }
      send(data: string): void {
        if (!this.#closed) {void hub.ws.message(this.#conn, data);}
      }
      close(): void {
        if (this.#closed) {return;}
        this.#closed = true;
        hub.ws.close(this.#conn);
        this.#emit('close', {});
      }
      addEventListener(type: 'open' | 'message' | 'close' | 'error', listener: (event: WsMessageEvent) => void): void {
        this.#listeners.set(type, [...(this.#listeners.get(type) ?? []), listener]);
      }
      #emit(type: string, e: WsMessageEvent): void {
        for (const l of this.#listeners.get(type) ?? []) {l(e);}
      }
    }
    return { ctor: Fake, kill: () => current?.kill() };
  }

  it('the hub calls the system, the socket dies mid-call, the transport reconnects and calls work again', async () => {
    const systems = peers(systemLink);
    const hub = server(hubLink, [implement(hubLink).handlers({ hello: () => ({ welcome: 'w', sawPong: false }), progress: () => {} })], { peers: systems });
    const sockets = fakeSockets(hub);
    const aborted: string[] = [];
    const local = server(systemLink, [rigHandlers(aborted)]);
    const transport = wsTransport('ws://hub/ws', { WebSocket: sockets.ctor, heartbeat: false, backoff: { initial: 1, max: 1, jitter: false } });
    const sdk = client<typeof hubLink>({ baseUrl: 'http://hub', manifest: hubLink, ws: transport, serve: local, prefer: 'ws' });
    let opened = 0;
    systems.onOpen(() => opened++);

    expect(await sdk.call('hello', { name: 'fs' })).toEqual({ welcome: 'w', sawPong: false });
    const [first] = [...systems];
    expect(await first!.call('run', { fn: 'one', n: 1 })).toEqual({ out: 'one:1' });

    const slow = first!.call('run', { fn: 'slow', n: 0 });
    await wait();
    sockets.kill();
    await expect(slow).rejects.toMatchObject({ code: 'DISCONNECTED' });
    await wait();
    expect(aborted).toEqual(['slow']);

    await wait(20); // reconnect
    expect(transport.state).toBe('open');
    expect(opened).toBe(2);
    const [second] = [...systems];
    expect(second).not.toBe(first);
    expect(await second!.call('run', { fn: 'two', n: 2 })).toEqual({ out: 'two:2' });
    transport.close();
  });
});

/** The system handlers, standalone (for rigs that build their own wiring). */
function rigHandlers(aborted: string[] = []) {
  return implement(systemLink).handlers({
    ping: () => ({ pong: true as const }),
    run: async ({ data, signal }) => {
      if (data.fn === 'slow') {
        await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
        aborted.push(data.fn);
      }
      return { out: `${data.fn}:${data.n}` };
    },
    status: ({ data }) => ({ state: data.of }),
    rows: async function* () {},
    sum: () => ({ total: 0 }),
    scale: async function* () {},
    pick: () => ({ status: 200, data: { cached: '' } }),
    lie: () => ({ n: 1 }),
    nothing: () => {},
  });
}

describe('peer types', () => {
  it('derive arguments and results from the remote spec', () => {
    const systems = peers(systemLink);
    type P = Parameters<Parameters<typeof systems.onOpen>[0]>[0];
    expectTypeOf<P>().toEqualTypeOf<Peer<SystemLink>>();
    const typed = (p: Peer<SystemLink>) => {
      expectTypeOf(p.call('run', { fn: 'a', n: 1 })).toEqualTypeOf<Promise<{ out: string }>>();
      expectTypeOf(p.call('ping')).toEqualTypeOf<Promise<{ pong: true }>>();
      expectTypeOf(p.call('rows', { n: 1 })).toEqualTypeOf<AsyncIterable<{ i: number }>>();
      expectTypeOf(p.call('nothing', { x: 1 })).toEqualTypeOf<Promise<void>>();
      // @ts-expect-error — not an endpoint of the remote spec
      void p.call('hello', { name: 'x' });
      // @ts-expect-error — wrong data
      void p.call('run', { fn: 1, n: 1 });
      // @ts-expect-error — peer calls have no transport choice
      void p.call('ping', { transport: 'ws' });
      // @ts-expect-error — streaming input requires opts.stream
      void p.call('sum', undefined, {});
      p.on('changed', { uri: 'x' }, (d) => expectTypeOf(d).toEqualTypeOf<{ version: number }>());
    };
    void typed;
  });
});

describe('handler payload conn', () => {
  it('is the ws connection a call arrived on, and absent for http and in-process calls', async () => {
    const api = spec({ endpoints: { where: endpoint({ response: z.object({ ws: z.boolean() }) }) } });
    const app = server(api, [implement(api).handlers({ where: ({ conn }) => ({ ws: conn !== undefined }) })]);
    expect(await app.call('where')).toEqual({ ws: false });
    const res = await app.fetch(new Request('http://x/where', { method: 'POST' }));
    expect(await res.json()).toEqual({ ws: false });
    let deliver: (f: string) => void = () => {};
    const conn = app.ws.open((f) => deliver(f), new Request('http://x/ws'));
    const sdk = client<typeof api>({ baseUrl: 'http://x', manifest: api, ws: { send: (f) => void app.ws.message(conn, f), onMessage: (cb) => void (deliver = cb) } });
    expect(await sdk.call('where', { transport: 'ws' })).toEqual({ ws: true });
  });
});
