/**
 * # @ayepi/bun
 *
 * [Bun](https://bun.sh) adapter for an ayepi {@link Server}. Bun is fetch-native
 * and has a **built-in WebSocket server**, so this adapter needs **no
 * dependencies** — it forwards HTTP straight to `app.fetch` and wires Bun's
 * `websocket` handlers to `app.ws.open`/`message`/`close`.
 *
 * ```ts
 * import { serve } from '@ayepi/bun'
 * const close = serve(app, { port: 3000, path: '/ws' })
 * ```
 *
 * The `Bun` global is read at runtime (this file typechecks under plain `tsc`
 * via the minimal interfaces below; the real `Bun` is provided when you run it
 * under Bun).
 *
 * @module
 */

import type { AnySpec, Server, WsConn } from '@ayepi/core';

type AnyApp = Server<AnySpec>;

/** `WebSocket.readyState` value for an open socket (per the WHATWG spec). */
const WS_OPEN = 1;

/* ---- minimal structural view of the Bun runtime APIs we use ---- */
interface BunWebSocket<T = unknown> {
  readonly data: T;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  readonly readyState: number;
}
interface BunServerHandle {
  upgrade(req: Request, opts?: { data?: unknown }): boolean;
}
interface BunServeResult {
  stop(closeActiveConnections?: boolean): void;
  readonly port: number;
  readonly hostname: string;
}
interface BunServeOptions {
  port?: number;
  hostname?: string;
  fetch(req: Request, server: BunServerHandle): Response | undefined | Promise<Response | undefined>;
  websocket?: {
    open?(ws: BunWebSocket): void;
    message?(ws: BunWebSocket, message: string | ArrayBuffer | Uint8Array): void;
    close?(ws: BunWebSocket, code?: number, reason?: string): void;
  };
}
interface BunRuntime {
  serve(options: BunServeOptions): BunServeResult;
}

/** Data attached to each upgraded socket at upgrade time. */
interface ConnData {
  readonly req: Request;
  conn?: WsConn;
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
 * Boot an ayepi app on Bun's built-in HTTP + WebSocket server.
 *
 * @returns a `close()` function that stops the server.
 */
export function serve(app: AnyApp, opts: ServeOptions): () => void {
  const bun = (globalThis as unknown as { Bun?: BunRuntime }).Bun; // internal cast: read the ambient Bun global
  if (!bun) {throw new Error('@ayepi/bun: not running under Bun (no global `Bun`)');}

  const server = bun.serve({
    port: opts.port,
    hostname: opts.hostname,
    fetch(req, srv) {
      const isWs = req.headers.get('upgrade')?.toLowerCase() === 'websocket';
      if (isWs && (opts.path === undefined || new URL(req.url).pathname === opts.path)) {
        const data: ConnData = { req };
        if (srv.upgrade(req, { data })) {return undefined;} // upgraded — Bun takes over
        return new Response('WebSocket upgrade failed', { status: 400 });
      }
      return app.fetch(req);
    },
    websocket: {
      open(ws) {
        const data = ws.data as ConnData;
        data.conn = app.ws.open((frame) => {
          if (ws.readyState === WS_OPEN) {ws.send(frame);}
        }, data.req);
      },
      message(ws, message) {
        const data = ws.data as ConnData;
        if (data.conn) {void app.ws.message(data.conn, typeof message === 'string' ? message : new TextDecoder().decode(message));}
      },
      close(ws) {
        const data = ws.data as ConnData;
        if (data.conn) {app.ws.close(data.conn);}
      },
    },
  });

  opts.onListen?.({ port: server.port, hostname: server.hostname });
  return () => server.stop(true);
}
