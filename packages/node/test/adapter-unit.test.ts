/**
 * Unit tests for the request/response translation and upgrade plumbing in the
 * Node adapter. These drive `createRequestListener` and `handleUpgrade` with
 * hand-built mock `IncomingMessage` / `ServerResponse` / socket objects so we can
 * reach branches that real `fetch` can't easily produce: the `https` scheme,
 * undefined / array-valued request headers, a `Response` whose `getSetCookie`
 * is absent, repeated `set-cookie` values, a mid-flight stream error, and the
 * error-handler paths in the request listener.
 */
import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import http from 'node:http';
import { Readable } from 'node:stream';
import type { Duplex } from 'node:stream';
import { createRequestListener, handleUpgrade } from '../src/index';

/* ---------- mock helpers ---------- */

interface MockReqOpts {
  method?: string;
  url?: string;
  headers?: http.IncomingHttpHeaders;
  encrypted?: boolean;
  host?: string | undefined;
}

/** A fake IncomingMessage backed by an empty Readable so `Readable.toWeb` works. */
function mockReq(opts: MockReqOpts = {}): http.IncomingMessage {
  const body = Readable.from([]);
  const req = body as unknown as http.IncomingMessage & { socket: unknown };
  req.method = opts.method ?? 'GET';
  req.url = opts.url ?? '/';
  const headers: http.IncomingHttpHeaders = { ...(opts.headers ?? {}) };
  if (!('host' in headers) && opts.host !== undefined) {headers.host = opts.host;}
  req.headers = headers;
  req.socket = { encrypted: opts.encrypted } as never;
  return req;
}

/** A fake ServerResponse that records what was written and emits lifecycle events. */
class MockRes extends EventEmitter {
  statusCode = 200;
  headers: Record<string, string | string[]> = {};
  headersSent = false;
  writableEnded = false;
  writableFinished = false;
  destroyed = false;
  chunks: Uint8Array[] = [];
  ended = false;
  endBody?: unknown;
  /** when set, `write` returns false once to force the backpressure path. */
  private backpressureOnce = false;

  setHeader(k: string, v: string | string[]): void {
    this.headers[k] = v;
  }
  write(chunk: Uint8Array): boolean {
    this.headersSent = true;
    this.chunks.push(chunk);
    if (this.backpressureOnce) {
      this.backpressureOnce = false;
      queueMicrotask(() => this.emit('drain'));
      return false;
    }
    return true;
  }
  end(body?: unknown): void {
    this.headersSent = true;
    this.ended = true;
    this.writableEnded = true;
    this.writableFinished = true;
    this.endBody = body;
    queueMicrotask(() => this.emit('close'));
  }
  forceBackpressureOnce(): void {
    this.backpressureOnce = true;
  }
  asServerResponse(): http.ServerResponse {
    return this as unknown as http.ServerResponse;
  }
}

/** Build a minimal app whose `.fetch` returns the given response (or throws). */
function appReturning(make: () => Response | Promise<Response>): Parameters<typeof createRequestListener>[0] {
  return { fetch: () => Promise.resolve().then(make) } as never;
}

/** Wait for a MockRes to finish (end called). */
function whenEnded(res: MockRes): Promise<void> {
  return new Promise((resolve) => {
    if (res.ended) {return resolve();}
    res.on('close', () => resolve());
  });
}

/* ---------- toRequest branches (via createRequestListener) ---------- */

describe('toRequest translation branches', () => {
  it('uses https scheme for an encrypted socket and the request method/url', async () => {
    let seen: Request | undefined;
    const app = { fetch: (r: Request) => { seen = r; return Promise.resolve(new Response(null, { status: 204 })); } } as never;
    const res = new MockRes();
    createRequestListener(app)(mockReq({ encrypted: true, host: 'ex.com', url: '/p?q=1', method: 'GET' }), res.asServerResponse());
    await whenEnded(res);
    expect(seen!.url).toBe('https://ex.com/p?q=1');
    expect(seen!.method).toBe('GET');
  });

  it('falls back to localhost host, "/" url, and GET method when absent', async () => {
    let seen: Request | undefined;
    const app = { fetch: (r: Request) => { seen = r; return Promise.resolve(new Response(null, { status: 204 })); } } as never;
    const res = new MockRes();
    const req = mockReq();
    // strip the defaults the helper sets so the ?? fallbacks fire
    (req as { method?: string }).method = undefined;
    (req as { url?: string }).url = undefined;
    delete req.headers.host;
    createRequestListener(app)(req, res.asServerResponse());
    await whenEnded(res);
    expect(seen!.url).toBe('http://localhost/');
    expect(seen!.method).toBe('GET');
  });

  it('skips undefined header values and appends array-valued headers', async () => {
    let seen: Request | undefined;
    const app = { fetch: (r: Request) => { seen = r; return Promise.resolve(new Response(null, { status: 204 })); } } as never;
    const res = new MockRes();
    const req = mockReq({
      host: 'h',
      headers: {
        'x-skip': undefined,
        'x-multi': ['a', 'b'],
        'x-single': 'one',
      } as http.IncomingHttpHeaders,
    });
    createRequestListener(app)(req, res.asServerResponse());
    await whenEnded(res);
    expect(seen!.headers.has('x-skip')).toBe(false);
    expect(seen!.headers.get('x-multi')).toBe('a, b');
    expect(seen!.headers.get('x-single')).toBe('one');
  });

  it('streams a request body for non-GET/HEAD methods', async () => {
    let bodyText: string | undefined;
    const app = { fetch: async (r: Request) => { bodyText = await r.text(); return new Response(null, { status: 204 }); } } as never;
    const res = new MockRes();
    const body = Readable.from([Buffer.from('payload')]);
    const req = body as unknown as http.IncomingMessage & { socket: unknown };
    req.method = 'POST';
    req.url = '/x';
    req.headers = { host: 'h' };
    req.socket = {} as never;
    createRequestListener(app)(req, res.asServerResponse());
    await whenEnded(res);
    expect(bodyText).toBe('payload');
  });
});

/* ---------- sendResponse branches (via createRequestListener) ---------- */

describe('sendResponse translation branches', () => {
  it('copies headers, skips set-cookie in forEach, and preserves repeated set-cookie via getSetCookie', async () => {
    const headers = new Headers();
    headers.set('content-type', 'text/plain');
    headers.append('set-cookie', 'a=1');
    headers.append('set-cookie', 'b=2');
    const res = new MockRes();
    createRequestListener(appReturning(() => new Response('hi', { headers })))(mockReq({ host: 'h' }), res.asServerResponse());
    await whenEnded(res);
    expect(res.headers['content-type']).toBe('text/plain');
    expect(res.headers['set-cookie']).toEqual(['a=1', 'b=2']);
    expect(Buffer.concat(res.chunks).toString()).toBe('hi');
  });

  it('handles a Response whose headers lack getSetCookie (?? [] fallback)', async () => {
    const res = new MockRes();
    const fakeHeaders = {
      // no getSetCookie method at all
      forEach(cb: (v: string, k: string) => void) { cb('text/plain', 'content-type'); },
    };
    const fakeResponse = {
      status: 200,
      headers: fakeHeaders,
      body: null,
    } as unknown as Response;
    createRequestListener(appReturning(() => fakeResponse))(mockReq({ host: 'h' }), res.asServerResponse());
    await whenEnded(res);
    expect(res.headers['content-type']).toBe('text/plain');
    expect(res.statusCode).toBe(200);
    expect(res.ended).toBe(true);
  });

  it('ends with no body when response.body is null', async () => {
    const res = new MockRes();
    createRequestListener(appReturning(() => new Response(null, { status: 204 })))(mockReq({ host: 'h' }), res.asServerResponse());
    await whenEnded(res);
    expect(res.statusCode).toBe(204);
    expect(res.chunks.length).toBe(0);
    expect(res.ended).toBe(true);
  });

  it('awaits drain on backpressure (write returns false)', async () => {
    const res = new MockRes();
    res.forceBackpressureOnce();
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new Uint8Array([1, 2, 3]));
        c.enqueue(new Uint8Array([4, 5, 6]));
        c.close();
      },
    });
    createRequestListener(appReturning(() => new Response(stream)))(mockReq({ host: 'h' }), res.asServerResponse());
    await whenEnded(res);
    expect(Buffer.concat(res.chunks)).toEqual(Buffer.from([1, 2, 3, 4, 5, 6]));
  });

  it('truncates (still ends) when the upstream stream errors mid-flight', async () => {
    const res = new MockRes();
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new Uint8Array([1]));
      },
      pull() {
        throw new Error('boom');
      },
    });
    createRequestListener(appReturning(() => new Response(stream)))(mockReq({ host: 'h' }), res.asServerResponse());
    await whenEnded(res);
    expect(res.ended).toBe(true);
    expect(Buffer.concat(res.chunks)).toEqual(Buffer.from([1]));
  });

  it('stops writing when the response is already ended/destroyed', async () => {
    const res = new MockRes();
    let pulls = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(c) {
        pulls++;
        c.enqueue(new Uint8Array([pulls]));
        // mark the response ended after the first chunk so the loop breaks
        res.writableEnded = true;
      },
    });
    createRequestListener(appReturning(() => new Response(stream)))(mockReq({ host: 'h' }), res.asServerResponse());
    await new Promise((r) => setTimeout(r, 30));
    // exactly one chunk written, then the writableEnded guard breaks the loop
    expect(res.chunks.length).toBeLessThanOrEqual(1);
  });

});

/* ---------- createRequestListener error paths ---------- */

describe('createRequestListener error handling', () => {
  it('writes a 500 JSON error when fetch rejects before headers are sent (Error)', async () => {
    const res = new MockRes();
    createRequestListener(appReturning(() => { throw new Error('kaput'); }))(mockReq({ host: 'h' }), res.asServerResponse());
    await whenEnded(res);
    expect(res.statusCode).toBe(500);
    expect(res.headers['content-type']).toBe('application/json');
    expect(JSON.parse(String(res.endBody))).toEqual({ error: { code: 'INTERNAL', message: 'kaput' } });
  });

  it('uses a generic message when the rejection is not an Error', async () => {
    const res = new MockRes();
    createRequestListener(appReturning(() => { throw 'string failure'; }))(mockReq({ host: 'h' }), res.asServerResponse());
    await whenEnded(res);
    expect(res.statusCode).toBe(500);
    expect(JSON.parse(String(res.endBody))).toEqual({ error: { code: 'INTERNAL', message: 'internal error' } });
  });

  it('just ends (no 500 body) when headers were already sent and not yet ended', async () => {
    const res = new MockRes();
    // a response that streams one chunk (sending headers) then errors in sendResponse:
    // simulate by having fetch resolve, sendResponse start, but throw after first write.
    const stream = new ReadableStream<Uint8Array>({
      start(c) { c.enqueue(new Uint8Array([1])); },
      pull() { throw new Error('mid'); },
    });
    // sendResponse swallows the stream error itself, so to hit the listener's
    // "else if (!res.writableEnded)" branch we make sendResponse reject.
    const badResponse = {
      status: 200,
      headers: new Headers(),
      get body() {
        // mark headers sent, then throw to make sendResponse reject
        res.headersSent = true;
        throw new Error('explode after headers');
      },
    } as unknown as Response;
    void stream;
    createRequestListener(appReturning(() => badResponse))(mockReq({ host: 'h' }), res.asServerResponse());
    await whenEnded(res);
    expect(res.ended).toBe(true);
    // no 500 JSON because headersSent was true
    expect(res.statusCode).not.toBe(500);
  });

  it('does nothing further when headers sent and response already ended', async () => {
    const res = new MockRes();
    const badResponse = {
      status: 200,
      headers: new Headers(),
      get body() {
        res.headersSent = true;
        res.writableEnded = true;
        throw new Error('explode');
      },
    } as unknown as Response;
    createRequestListener(appReturning(() => badResponse))(mockReq({ host: 'h' }), res.asServerResponse());
    await new Promise((r) => setTimeout(r, 20));
    expect(res.statusCode).not.toBe(500);
  });

  it('aborts the request signal when the client closes before the response finishes', async () => {
    let aborted = false;
    const app = {
      fetch: (r: Request) =>
        new Promise<Response>((resolve) => {
          r.signal.addEventListener('abort', () => { aborted = true; resolve(new Response(null, { status: 204 })); });
        }),
    } as never;
    const res = new MockRes();
    createRequestListener(app)(mockReq({ host: 'h' }), res.asServerResponse());
    // simulate client disconnect before the response finished
    res.writableFinished = false;
    res.emit('close');
    await new Promise((r) => setTimeout(r, 20));
    expect(aborted).toBe(true);
  });

  it('does not abort when the response already finished on close', async () => {
    let aborted = false;
    const app = {
      fetch: (r: Request) => {
        r.signal.addEventListener('abort', () => { aborted = true; });
        return Promise.resolve(new Response('ok'));
      },
    } as never;
    const res = new MockRes();
    createRequestListener(app)(mockReq({ host: 'h' }), res.asServerResponse());
    await whenEnded(res);
    res.writableFinished = true;
    res.emit('close');
    await new Promise((r) => setTimeout(r, 10));
    expect(aborted).toBe(false);
  });
});

/* ---------- handleUpgrade branches ---------- */

/** A fake http.Server that just relays an `upgrade` event we emit by hand. */
function fakeServer(): http.Server & { fireUpgrade: (req: http.IncomingMessage, socket: Duplex, head: Buffer) => void } {
  const ee = new EventEmitter() as http.Server & { fireUpgrade: (req: http.IncomingMessage, socket: Duplex, head: Buffer) => void };
  ee.fireUpgrade = (req, socket, head) => ee.emit('upgrade', req, socket, head);
  return ee;
}

/** A fake Duplex socket recording whether it was destroyed. */
function fakeSocket(): Duplex & { destroyed: boolean } {
  const s = new EventEmitter() as Duplex & { destroyed: boolean };
  s.destroyed = false;
  (s as unknown as { destroy: () => void }).destroy = () => { s.destroyed = true; };
  return s;
}

describe('handleUpgrade path filtering', () => {
  it('destroys the socket when the upgrade path does not match', () => {
    const app = { ws: { open: vi.fn(), message: vi.fn(), close: vi.fn() } } as never;
    const server = fakeServer();
    const wss = handleUpgrade(app, server, '/ws');
    const handleUpgradeSpy = vi.spyOn(wss, 'handleUpgrade');
    const socket = fakeSocket();
    server.fireUpgrade(mockReq({ url: '/nope', host: 'h' }), socket, Buffer.alloc(0));
    expect(socket.destroyed).toBe(true);
    expect(handleUpgradeSpy).not.toHaveBeenCalled();
    wss.close();
  });

  it('proceeds to wss.handleUpgrade when the path matches', () => {
    const app = { ws: { open: vi.fn(), message: vi.fn(), close: vi.fn() } } as never;
    const server = fakeServer();
    const wss = handleUpgrade(app, server, '/ws');
    const handleUpgradeSpy = vi.spyOn(wss, 'handleUpgrade').mockImplementation(() => {});
    const socket = fakeSocket();
    server.fireUpgrade(mockReq({ url: '/ws', host: 'h' }), socket, Buffer.alloc(0));
    expect(socket.destroyed).toBe(false);
    expect(handleUpgradeSpy).toHaveBeenCalled();
    wss.close();
  });

  it('falls back to "/" when the upgrade request has no url', () => {
    const app = { ws: { open: vi.fn(), message: vi.fn(), close: vi.fn() } } as never;
    const server = fakeServer();
    const wss = handleUpgrade(app, server, '/ws');
    const handleUpgradeSpy = vi.spyOn(wss, 'handleUpgrade').mockImplementation(() => {});
    const socket = fakeSocket();
    const req = mockReq({ host: 'h' });
    (req as { url?: string }).url = undefined; // exercise the `req.url ?? '/'` fallback
    server.fireUpgrade(req, socket, Buffer.alloc(0));
    // url "/" !== "/ws" so the socket is destroyed
    expect(socket.destroyed).toBe(true);
    expect(handleUpgradeSpy).not.toHaveBeenCalled();
    wss.close();
  });

  it('accepts any path when no path is configured', () => {
    const app = { ws: { open: vi.fn(), message: vi.fn(), close: vi.fn() } } as never;
    const server = fakeServer();
    const wss = handleUpgrade(app, server);
    const handleUpgradeSpy = vi.spyOn(wss, 'handleUpgrade').mockImplementation(() => {});
    const socket = fakeSocket();
    server.fireUpgrade(mockReq({ url: '/anything', host: 'h' }), socket, Buffer.alloc(0));
    expect(handleUpgradeSpy).toHaveBeenCalled();
    wss.close();
  });

  it('wires open/message/close/error and sends frames only when the socket is OPEN', () => {
    const opened: Array<(frame: string) => void> = [];
    const app = {
      ws: {
        open: vi.fn((send: (f: string) => void) => { opened.push(send); return { id: 'conn1' }; }),
        message: vi.fn(),
        close: vi.fn(),
      },
    } as never;
    const server = fakeServer();
    const wss = handleUpgrade(app, server, '/ws');
    // fake ws passed to the handleUpgrade callback
    const fakeWs = Object.assign(new EventEmitter(), {
      OPEN: 1,
      readyState: 1,
      send: vi.fn(),
    });
    vi.spyOn(wss, 'handleUpgrade').mockImplementation(((_req: unknown, _sock: unknown, _head: unknown, cb: (ws: unknown) => void) => {
      cb(fakeWs);
    }) as never);

    server.fireUpgrade(mockReq({ url: '/ws', host: 'h' }), fakeSocket(), Buffer.alloc(0));

    // app.ws.open was called and gave us a send fn that forwards to ws.send when OPEN
    expect(opened.length).toBe(1);
    const send = opened[0]!;
    send('frame-while-open');
    expect(fakeWs.send).toHaveBeenCalledWith('frame-while-open');

    // when not OPEN, send is suppressed
    fakeWs.readyState = 3; // CLOSED
    send('frame-while-closed');
    expect(fakeWs.send).toHaveBeenCalledTimes(1);

    // inbound message → app.ws.message(conn, String(data))
    fakeWs.emit('message', Buffer.from('hello'));
    expect((app as { ws: { message: ReturnType<typeof vi.fn> } }).ws.message).toHaveBeenCalledWith({ id: 'conn1' }, 'hello');

    // close → app.ws.close(conn)
    fakeWs.emit('close');
    expect((app as { ws: { close: ReturnType<typeof vi.fn> } }).ws.close).toHaveBeenCalledWith({ id: 'conn1' });

    // error → app.ws.close(conn) again
    fakeWs.emit('error', new Error('x'));
    expect((app as { ws: { close: ReturnType<typeof vi.fn> } }).ws.close).toHaveBeenCalledTimes(2);

    wss.close();
  });
});
