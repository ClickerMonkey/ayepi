/**
 * The client's `unauthorized` hook (await it once on a 401 to a call made with credentials, then retry once) over
 * HTTP and ws, and `wsTransport.reconnect()` reading the URL again.
 */
import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { spec, middleware, ctx, use, implement, server, client, wsTransport, reject, ApiError, type WebSocketLike, type WsMessageEvent, type WsConn } from '../src/index';

const auth = middleware('auth', { provides: ctx<{ user: string }>() });
const api = spec({
  endpoints: {
    whoami: use(auth).endpoint({ body: z.object({ n: z.number() }), response: z.object({ user: z.string(), n: z.number() }) }),
  },
});

/** The one token the server accepts; tests rotate it to expire the client's. */
let valid = 'fresh';
const app = server(api, [
  implement(api)
    .middleware(auth, async (io) => {
      const url = new URL(io.req.url);
      const token = io.req.headers.get('authorization')?.replace('Bearer ', '') ?? url.searchParams.get('t');
      if (token !== valid) {throw reject(401, 'UNAUTHORIZED');}
      return io.next({ user: token });
    })
    .handlers({ whoami: ({ user, data }) => ({ user, n: data.n }) }),
]);

/** A WebSocket bound to `app.ws`; the upgrade request carries the URL (and so its token). */
class FakeWS implements WebSocketLike {
  static urls: string[] = [];
  private readonly listeners = new Map<string, ((ev: WsMessageEvent) => void)[]>();
  private conn: WsConn | null = null;
  constructor(readonly url: string) {
    FakeWS.urls.push(url);
    setTimeout(() => {
      this.conn = app.ws.open((frame) => this.fire('message', { data: frame }), new Request(url.replace(/^ws/, 'http')));
      this.fire('open', {});
    }, 1);
  }
  addEventListener(type: 'open' | 'message' | 'close' | 'error', listener: (event: WsMessageEvent) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  private fire(type: string, ev: WsMessageEvent) {
    for (const l of this.listeners.get(type) ?? []) {l(ev);}
  }
  send(data: string) {
    if (this.conn) {void app.ws.message(this.conn, data);}
  }
  close() {
    if (this.conn) {app.ws.close(this.conn);}
    this.conn = null;
    this.fire('close', {});
  }
}

type Api = typeof api;

/** A client whose token starts stale; `refresh` is what the hook does (count it, maybe fix the token). */
function setup(over: { transport?: 'ws'; token?: string; refresh?: (t: { token: string }) => boolean } = {}) {
  valid = 'fresh';
  const state = { token: over.token ?? 'stale', hooks: 0 };
  const socket = wsTransport(() => `ws://test/ws?t=${state.token}`, { WebSocket: FakeWS, heartbeat: false, whileDisconnected: 'queue' });
  const sdk = client<Api>({
    baseUrl: 'http://test',
    manifest: api,
    fetchImpl: (req) => app.fetch(req),
    headers: (): Readonly<Record<string, string>> => (state.token === '' ? {} : { authorization: `Bearer ${state.token}` }),
    ws: socket,
    prefer: over.transport === 'ws' ? 'ws' : 'http',
    unauthorized: async () => {
      state.hooks++;
      await new Promise((r) => setTimeout(r, 5));
      const ok = (over.refresh ?? ((t) => ((t.token = 'fresh'), true)))(state);
      if (ok) {socket.reconnect();}
      return ok;
    },
  });
  return { sdk, state, socket };
}

const status = (p: Promise<unknown>) => p.then(() => 200, (e: unknown) => (e instanceof ApiError ? e.status : -1));

describe('client unauthorized hook', () => {
  it('http: refreshes once for calls refused together, then retries each', async () => {
    const { sdk, state } = setup();
    const [a, b] = await Promise.all([sdk.call('whoami', { n: 1 }), sdk.call('whoami', { n: 2 })]);
    expect([a, b]).toEqual([{ user: 'fresh', n: 1 }, { user: 'fresh', n: 2 }]);
    expect(state.hooks).toBe(1);
  });

  it('http: a false hook lets the 401 through; calls without credentials never ask', async () => {
    const declined = setup({ refresh: () => false });
    expect(await status(declined.sdk.call('whoami', { n: 1 }))).toBe(401);
    expect(declined.state.hooks).toBe(1);
    const anonymous = setup({ token: '' });
    expect(await status(anonymous.sdk.call('whoami', { n: 1 }))).toBe(401);
    expect(anonymous.state.hooks).toBe(0);
  });

  it('http: retries only once', async () => {
    const { sdk, state } = setup({ refresh: () => true }); // claims success but the token stays stale
    expect(await status(sdk.call('whoami', { n: 1 }))).toBe(401);
    expect(state.hooks).toBe(1);
  });

  it('ws: refreshes, reconnects with the new URL, and retries over the socket', async () => {
    FakeWS.urls = [];
    const { sdk, state, socket } = setup({ transport: 'ws' });
    const [a, b] = await Promise.all([sdk.call('whoami', { n: 1 }), sdk.call('whoami', { n: 2 })]);
    expect([a, b]).toEqual([{ user: 'fresh', n: 1 }, { user: 'fresh', n: 2 }]);
    expect(state.hooks).toBe(1);
    expect(FakeWS.urls).toEqual(['ws://test/ws?t=stale', 'ws://test/ws?t=fresh']);
    socket.close();
  });

  it('ws: retries only once', async () => {
    const { sdk, state, socket } = setup({ transport: 'ws', refresh: () => true });
    expect(await status(sdk.call('whoami', { n: 1 }))).toBe(401);
    expect(state.hooks).toBe(1);
    socket.close();
  });

  it('ws: a false hook lets the 401 through', async () => {
    const { sdk, state, socket } = setup({ transport: 'ws', refresh: () => false });
    expect(await status(sdk.call('whoami', { n: 1 }))).toBe(401);
    expect(state.hooks).toBe(1);
    socket.close();
  });

  it('ws: a call aborted while the hook runs is not sent again', async () => {
    FakeWS.urls = [];
    const ac = new AbortController();
    let sent = 0;
    const { sdk, state, socket } = setup({ transport: 'ws', refresh: (t) => (ac.abort(), sent++, (t.token = 'fresh'), true) });
    await expect(sdk.call('whoami', { n: 1 }, { signal: ac.signal })).rejects.toMatchObject({ name: 'AbortError' });
    await new Promise((r) => setTimeout(r, 10));
    expect([state.hooks, sent]).toEqual([1, 1]);
    socket.close();
  });
});

describe('wsTransport.reconnect', () => {
  it('opens a new socket at once and does nothing after close', async () => {
    FakeWS.urls = [];
    let n = 0;
    const socket = wsTransport(() => `ws://test/ws?t=${++n}`, { WebSocket: FakeWS, heartbeat: false });
    socket.connect();
    await new Promise((r) => setTimeout(r, 10));
    socket.reconnect();
    expect(socket.state).toBe('connecting');
    await new Promise((r) => setTimeout(r, 10));
    expect(socket.state).toBe('open');
    socket.close();
    socket.reconnect();
    expect(socket.state).toBe('closed');
    expect(FakeWS.urls).toEqual(['ws://test/ws?t=1', 'ws://test/ws?t=2']);
  });
});
