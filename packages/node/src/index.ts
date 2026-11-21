/**
 * # ayepi-node
 *
 * Node.js adapter for an ayepi {@link Server}. Bridges the `node:http`
 * `IncomingMessage`/`ServerResponse` world to the web-standard
 * `Request`/`Response` the ayepi core speaks, and serves WebSocket upgrades via
 * the [`ws`](https://github.com/websockets/ws) package wired to
 * `app.ws.open`/`message`/`close`.
 *
 * Bodies stream in both directions without buffering, response writes respect
 * backpressure (`res.write` / `'drain'`), and a client disconnect aborts the
 * per-request `AbortSignal` (the `signal` your handlers receive).
 *
 * ```ts
 * import { serve } from 'ayepi-node'
 * const close = serve(app, { port: 3000, path: '/ws' })
 * // …later
 * await close()
 * ```
 *
 * HTTP/1.1 only for v0.
 *
 * @module
 */

import http from 'node:http';
import { Readable } from 'node:stream';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type WebSocket } from 'ws';
import type { AnySpec, Server, WsConn } from '@ayepi/core';

/** A minimal structural view of the ayepi server surface this adapter drives. */
type AnyApp = Server<AnySpec>;

/** Anything that answers web-standard requests: an ayepi app, or any other `fetch` handler (an MCP endpoint, a proxy). */
export interface FetchHandler {
  fetch(req: Request): Promise<Response>;
}

/** Options for {@link serve}. */
export interface ServeOptions {
  /** TCP port to listen on. */
  readonly port: number;
  /** Interface to bind (default: all interfaces). */
  readonly hostname?: string;
  /**
   * Restrict WebSocket upgrades to this pathname (e.g. `'/ws'`). When omitted,
   * upgrades are accepted on any path.
   */
  readonly path?: string;
  /** WebSocket liveness checks; see {@link UpgradeOptions.heartbeat}. */
  readonly heartbeat?: number;
  /** Called once the server is listening. */
  readonly onListen?: (info: { port: number; hostname: string }) => void;
}

/** How the sockets of one ayepi app are handled: {@link upgradeHandler}'s options. */
export interface SocketOptions {
  /**
   * Send a WebSocket protocol ping on every connection this often (ms), and terminate a connection whose pong has
   * not come back by the next ping. A peer that vanished without closing (a crash, a dropped network) is then
   * closed within two intervals, so `app.ws.close` runs and its calls settle. Off when omitted.
   */
  readonly heartbeat?: number;
  /**
   * When to close a socket, in ms since the epoch, read from its upgrade `Request`: typically just before the
   * credential it opened with expires. The socket is closed with code {@link EXPIRED_CLOSE_CODE}, and a client whose
   * URL is a function (`wsTransport(() => url)`) reconnects with the credential it holds now. `undefined` keeps the
   * socket open. Off when omitted.
   */
  readonly closeAt?: (req: Request) => number | undefined;
  /** The clock `closeAt` is measured against (ms since the epoch). Default `Date.now`. */
  readonly clock?: () => number;
  /**
   * The largest message a socket may send, in bytes; a bigger one closes the socket (code 1009). Default `ws`'s
   * own (100 MiB).
   */
  readonly maxPayload?: number;
  /**
   * Whether to take an upgrade, read from its `Request` before it becomes a socket (cap open sockets per address,
   * say). A refused upgrade, or one whose check throws, is answered `429 Too Many Requests` and never reaches
   * `app.ws.open`; the `Request` an admitted one opens with is this same object. Default: every one.
   */
  readonly admit?: (req: Request) => boolean | Promise<boolean>;
}

/** Options for {@link handleUpgrade}. */
export interface UpgradeOptions extends SocketOptions {
  /** When set, only upgrades on this pathname are accepted. */
  readonly path?: string;
}

/** The close code a socket gets when its {@link SocketOptions.closeAt} time comes. */
export const EXPIRED_CLOSE_CODE = 4001;

/** One ayepi app's WebSocket side: hand it upgrades, and close its {@link WebSocketServer} to stop. */
export interface UpgradeHandler {
  /** The sockets this handler accepted (`.clients`), and `.close()` to stop. */
  readonly sockets: WebSocketServer;
  /** Accept an HTTP upgrade as a socket of this app. */
  upgrade(req: http.IncomingMessage, socket: Duplex, head: Buffer): void;
  /** Close one of this handler's sockets from the server side (a no-op when it is closed or not this handler's). */
  close(conn: WsConn, code?: number, reason?: string): void;
}

/** The socket address each request this adapter built came from (see {@link remoteAddress}). */
const remotes = new WeakMap<Request, string | undefined>();

/**
 * The address of the TCP peer a `Request` this adapter built came from (`IncomingMessage.socket.remoteAddress`): the
 * client itself, or the proxy in front of it. Works for HTTP requests and for a socket's upgrade `Request`; undefined
 * for a request built anywhere else (a test's, an in-process call) or when the socket was already gone. Headers such
 * as `X-Forwarded-For` are never read: whether to trust a proxy is the app's choice.
 */
export function remoteAddress(req: Request): string | undefined {
  return remotes.get(req);
}

/** Build a fetch `Request` from a Node `IncomingMessage`, wiring an abort `signal`. */
function toRequest(req: http.IncomingMessage, signal: AbortSignal): Request {
  const socket = req.socket as http.IncomingMessage['socket'] & { encrypted?: boolean };
  const proto = socket.encrypted ? 'https' : 'http';
  const host = req.headers.host ?? 'localhost';
  const url = `${proto}://${host}${req.url ?? '/'}`;
  const method = req.method ?? 'GET';
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (v === undefined) {continue;}
    if (Array.isArray(v)) {for (const vv of v) {headers.append(k, vv);}}
    else {headers.set(k, v);}
  }
  const hasBody = method !== 'GET' && method !== 'HEAD';
  const init: RequestInit & { duplex?: 'half' } = { method, headers, signal };
  if (hasBody) {
    init.body = Readable.toWeb(req) as ReadableStream<Uint8Array>;
    init.duplex = 'half'; // required by undici when streaming a request body
  }
  const request = new Request(url, init);
  remotes.set(request, socket.remoteAddress);
  return request;
}

/** Resolve once the response can accept more writes, or the socket closes. */
function whenWritable(res: http.ServerResponse): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      res.off('drain', done);
      res.off('close', done);
      resolve();
    };
    res.once('drain', done);
    res.once('close', done);
  });
}

/** Stream a fetch `Response` out through a Node `ServerResponse`, honoring backpressure. */
async function sendResponse(res: http.ServerResponse, response: Response): Promise<void> {
  res.statusCode = response.status;
  // set-cookie may legitimately repeat — preserve each header separately
  const setCookies = response.headers.getSetCookie?.() ?? [];
  response.headers.forEach((value, key) => {
    if (key.toLowerCase() === 'set-cookie') {return;}
    res.setHeader(key, value);
  });
  if (setCookies.length > 0) {res.setHeader('set-cookie', setCookies);}

  if (!response.body) {
    res.end();
    return;
  }
  const reader = response.body.getReader();
  res.once('close', () => void reader.cancel().catch(() => {}));
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {break;}
      if (res.writableEnded || res.destroyed) {break;}
      if (!res.write(value)) {await whenWritable(res);}
    }
  } catch {
    /* upstream stream errored mid-flight — truncate the response */
  } finally {
    if (!res.writableEnded) {res.end();}
  }
}

/**
 * Create a `node:http` request listener for an ayepi app, or any other {@link FetchHandler} — useful for mounting
 * on an existing server, behind a proxy, or alongside other routes.
 *
 * Each request gets an `AbortController` whose signal aborts when the client
 * disconnects before the response finishes; that signal is the `signal` your
 * handlers receive.
 *
 * @example
 * ```ts
 * http.createServer(createRequestListener(app)).listen(3000)
 * ```
 */
export function createRequestListener(app: FetchHandler): (req: http.IncomingMessage, res: http.ServerResponse) => void {
  return (req, res) => {
    const ac = new AbortController();
    res.on('close', () => {
      if (!res.writableFinished) {ac.abort();}
    });
    app
      .fetch(toRequest(req, ac.signal))
      .then((response) => sendResponse(res, response))
      .catch((err: unknown) => {
        if (!res.headersSent) {
          res.statusCode = 500;
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify({ error: { code: 'INTERNAL', message: err instanceof Error ? err.message : 'internal error' } }));
        } else if (!res.writableEnded) {
          res.end();
        }
      });
  };
}

/**
 * Attach an ayepi app's WebSocket handling to an `http.Server`'s `upgrade` event.
 *
 * Each upgraded socket becomes a {@link WsConn} via `app.ws.open`; inbound text
 * frames are forwarded to `app.ws.message`, and a socket close calls
 * `app.ws.close`. The upgrade `Request` (with its headers) is handed to
 * `app.ws.open`, so subscription guards can authenticate from it; its `signal` aborts when the socket closes.
 *
 * @param app     - the ayepi app.
 * @param server  - the HTTP server to listen for upgrades on.
 * @param options - a pathname to accept upgrades on, or {@link UpgradeOptions}.
 * @returns the underlying {@link WebSocketServer} (call `.close()` to stop).
 */
export function handleUpgrade(app: AnyApp, server: http.Server, options?: string | UpgradeOptions): WebSocketServer {
  const { path, ...socketOptions } = typeof options === 'string' ? { path: options } : (options ?? {});
  const handler = upgradeHandler(app, socketOptions);
  server.on('upgrade', (req: http.IncomingMessage, socket: Duplex, head: Buffer) => {
    if (path !== undefined && pathnameOf(req) !== path) {
      socket.destroy();
      return;
    }
    handler.upgrade(req, socket, head);
  });
  return handler.sockets;
}

/**
 * One ayepi app's WebSocket side, not yet attached to a server: each upgrade handed to it becomes a {@link WsConn}
 * via `app.ws.open` (see {@link handleUpgrade}). Use it to serve several apps on one `http.Server`, through
 * {@link routeUpgrades} or an `upgrade` listener of your own.
 */
export function upgradeHandler(app: AnyApp, options: SocketOptions = {}): UpgradeHandler {
  const { heartbeat, closeAt, clock = Date.now, maxPayload, admit } = options;
  const sockets = new WebSocketServer({ noServer: true, ...(maxPayload === undefined ? {} : { maxPayload }) });
  const open = new WeakMap<WsConn, WebSocket>();
  return {
    sockets,
    upgrade(req, socket, head) {
      const closed = new AbortController();
      const request = toRequest(req, closed.signal);
      const accept = (): void => sockets.handleUpgrade(req, socket, head, (ws: WebSocket) => {
        const conn = app.ws.open((frame) => {
          if (ws.readyState === ws.OPEN) {ws.send(frame);}
        }, request);
        open.set(conn, ws);
        const stopBeat = heartbeat === undefined ? () => {} : beat(ws, heartbeat);
        const stopExpiry = closeAt === undefined ? () => {} : expire(ws, closeAt(request), clock);
        const close = () => {
          stopBeat();
          stopExpiry();
          closed.abort();
          app.ws.close(conn);
        };
        ws.on('message', (data: unknown) => {
          void app.ws.message(conn, String(data));
        });
        ws.on('close', close);
        ws.on('error', close);
      });
      if (admit === undefined) {
        accept();
        return;
      }
      const refuse = (): void => {
        socket.end('HTTP/1.1 429 Too Many Requests\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      };
      void Promise.resolve().then(() => admit(request)).then((ok) => (ok ? accept() : refuse()), refuse);
    },
    close(conn, code, reason) {
      open.get(conn)?.close(code, reason);
    },
  };
}

/**
 * Serve several ayepi apps' sockets on one `http.Server`, each on its own pathname
 * (`{ '/ws': browser, '/link': systems }`). An upgrade on any other path is refused.
 */
export function routeUpgrades(server: http.Server, routes: Readonly<Record<string, UpgradeHandler>>): void {
  const byPath = new Map(Object.entries(routes));
  server.on('upgrade', (req: http.IncomingMessage, socket: Duplex, head: Buffer) => {
    const route = byPath.get(pathnameOf(req));
    if (route === undefined) {
      socket.destroy();
      return;
    }
    route.upgrade(req, socket, head);
  });
}

/** An upgrade request's pathname. */
function pathnameOf(req: http.IncomingMessage): string {
  return new URL(req.url ?? '/', 'http://localhost').pathname;
}

/** Close `ws` at `at` (ms since the epoch, by `clock`); nothing when `at` is undefined. Returns the stop function. */
function expire(ws: WebSocket, at: number | undefined, clock: () => number): () => void {
  if (at === undefined) {return () => {};}
  const timer = setTimeout(() => {
    ws.close(EXPIRED_CLOSE_CODE, 'expired');
  }, Math.max(0, at - clock()));
  timer.unref();
  return () => clearTimeout(timer);
}

/** Ping `ws` every `interval` ms and terminate it when a pong is missed. Returns the stop function. */
function beat(ws: WebSocket, interval: number): () => void {
  let alive = true;
  ws.on('pong', () => {
    alive = true;
  });
  const timer = setInterval(() => {
    if (!alive) {
      ws.terminate();
      return;
    }
    alive = false;
    ws.ping();
  }, interval);
  return () => clearInterval(timer);
}

/**
 * Boot an ayepi app on a real HTTP + WebSocket port.
 *
 * @returns a `close()` function that stops accepting connections, terminates
 * live WebSockets, and resolves once the server has shut down.
 *
 * @example
 * ```ts
 * const close = serve(app, { port: 3000, path: '/ws', onListen: ({ port }) => console.log(`:${port}`) })
 * process.on('SIGTERM', () => void close())
 * ```
 */
export function serve(app: AnyApp, opts: ServeOptions): () => Promise<void> {
  const server = http.createServer(createRequestListener(app));
  const wss = handleUpgrade(app, server, { path: opts.path, heartbeat: opts.heartbeat });
  const hostname = opts.hostname ?? '0.0.0.0';
  server.listen(opts.port, hostname, () => {
    const addr = server.address();
    const port = typeof addr === 'object' && addr ? addr.port : opts.port;
    opts.onListen?.({ port, hostname });
  });
  return () =>
    new Promise<void>((resolve, reject) => {
      for (const ws of wss.clients) {ws.terminate();}
      wss.close(() => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    });
}
