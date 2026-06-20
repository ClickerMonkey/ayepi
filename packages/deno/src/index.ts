/**
 * # @ayepi/deno
 *
 * [Deno](https://deno.com) adapter for an ayepi {@link Server}. Deno is
 * fetch-native and upgrades WebSockets with the built-in
 * `Deno.upgradeWebSocket`, so this adapter needs **no dependencies** — HTTP goes
 * straight to `app.fetch` and the upgraded socket is wired to
 * `app.ws.open`/`message`/`close`.
 *
 * ```ts
 * import { serve } from '@ayepi/deno'
 * const close = serve(app, { port: 3000, path: '/ws' })
 * ```
 *
 * The `Deno` global is read at runtime (this file typechecks under plain `tsc`
 * via the minimal interfaces below; the real `Deno` is provided when you run it
 * under Deno).
 *
 * @module
 */

import type { AnySpec, Server, WsConn } from '@ayepi/core';

type AnyApp = Server<AnySpec>;

/** `WebSocket.readyState` value for an open socket (per the WHATWG spec). */
const WS_OPEN = 1;

/* ---- minimal structural view of the Deno runtime APIs we use ---- */
interface DenoWebSocket {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  readyState: number;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: unknown) => void) | null;
  onerror: ((ev: unknown) => void) | null;
}
interface DenoUpgrade {
  socket: DenoWebSocket;
  response: Response;
}
interface DenoServeHandle {
  shutdown(): Promise<void>;
  finished: Promise<void>;
}
interface DenoServeOptions {
  port?: number;
  hostname?: string;
  signal?: AbortSignal;
  onListen?: (info: { port: number; hostname: string }) => void;
}
interface DenoRuntime {
  serve(options: DenoServeOptions, handler: (req: Request) => Response | Promise<Response>): DenoServeHandle;
  upgradeWebSocket(req: Request): DenoUpgrade;
}

/** Options for {@link serve}. */
export interface ServeOptions {
  /** TCP port to listen on. */
  readonly port: number;
  /** Interface to bind. */
  readonly hostname?: string;
  /** Restrict WebSocket upgrades to this pathname (e.g. `'/ws'`). */
  readonly path?: string;
  /** Called once the server is listening. */
  readonly onListen?: (info: { port: number; hostname: string }) => void;
}

/**
 * Boot an ayepi app on Deno's built-in HTTP + WebSocket server.
 *
 * @returns a `close()` function that shuts the server down and resolves once it
 * has finished.
 */
export function serve(app: AnyApp, opts: ServeOptions): () => Promise<void> {
  const deno = (globalThis as unknown as { Deno?: DenoRuntime }).Deno; // internal cast: read the ambient Deno global
  if (!deno) {throw new Error('@ayepi/deno: not running under Deno (no global `Deno`)');}

  const handler = (req: Request): Response | Promise<Response> => {
    const isWs = req.headers.get('upgrade')?.toLowerCase() === 'websocket';
    if (isWs && (opts.path === undefined || new URL(req.url).pathname === opts.path)) {
      const { socket, response } = deno.upgradeWebSocket(req);
      let conn: WsConn | null = null;
      socket.onopen = () => {
        conn = app.ws.open((frame) => {
          if (socket.readyState === WS_OPEN) {socket.send(frame);}
        }, req);
      };
      socket.onmessage = (ev) => {
        if (conn) {void app.ws.message(conn, String(ev.data));}
      };
      socket.onclose = () => {
        if (conn) {app.ws.close(conn);}
      };
      socket.onerror = () => {
        if (conn) {app.ws.close(conn);}
      };
      return response;
    }
    return app.fetch(req);
  };

  const server = deno.serve(
    { port: opts.port, hostname: opts.hostname, onListen: (info) => opts.onListen?.(info) },
    handler,
  );
  return async () => {
    await server.shutdown();
  };
}
