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
import type { AnySpec, Server } from '@ayepi/core';

/** A minimal structural view of the ayepi server surface this adapter drives. */
type AnyApp = Server<AnySpec>;

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
  /** Called once the server is listening. */
  readonly onListen?: (info: { port: number; hostname: string }) => void;
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
  return new Request(url, init);
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
 * Create a `node:http` request listener for an ayepi app — useful for mounting on
 * an existing server, behind a proxy, or alongside other routes.
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
export function createRequestListener(app: AnyApp): (req: http.IncomingMessage, res: http.ServerResponse) => void {
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
 * `app.ws.open`, so subscription guards can authenticate from it.
 *
 * @param app    - the ayepi app.
 * @param server - the HTTP server to listen for upgrades on.
 * @param path   - when set, only upgrades on this pathname are accepted.
 * @returns the underlying {@link WebSocketServer} (call `.close()` to stop).
 */
export function handleUpgrade(app: AnyApp, server: http.Server, path?: string): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req: http.IncomingMessage, socket: Duplex, head: Buffer) => {
    if (path !== undefined) {
      const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
      if (pathname !== path) {
        socket.destroy();
        return;
      }
    }
    wss.handleUpgrade(req, socket, head, (ws: WebSocket) => {
      const request = toRequest(req, new AbortController().signal);
      const conn = app.ws.open((frame) => {
        if (ws.readyState === ws.OPEN) {ws.send(frame);}
      }, request);
      ws.on('message', (data: unknown) => {
        void app.ws.message(conn, String(data));
      });
      ws.on('close', () => app.ws.close(conn));
      ws.on('error', () => app.ws.close(conn));
    });
  });
  return wss;
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
  const wss = handleUpgrade(app, server, opts.path);
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
