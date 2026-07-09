/**
 * A loopback "upstream" stub — a bare `node:http` server that answers after an optional
 * delay. The `net` archetype calls it over real TCP so a run exercises the outbound
 * connection path (sockets, keep-alive, the client dispatcher's pool) **without leaving the
 * machine**. Think of it as a stand-in for a DB or a third-party API.
 *
 * @module
 */

import http from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { listen, trackSockets, closeServer } from './util';

/** Options for {@link startUpstream}. */
export interface UpstreamOptions {
  /** Port to bind (default `0` — an OS-assigned ephemeral port). */
  readonly port?: number;
  /** Host to bind (default `127.0.0.1`). */
  readonly hostname?: string;
  /** Fixed response delay in ms (default `0`). Overridden per request by `?ms=`. */
  readonly delayMs?: number;
  /** Response body size in bytes (default `64`). Overridden per request by `?bytes=`. */
  readonly bytes?: number;
}

/** A running upstream stub. */
export interface Upstream {
  /** Base URL, e.g. `http://127.0.0.1:PORT`. */
  readonly url: string;
  /** The bound port. */
  readonly port: number;
  /** Requests served so far. */
  requests(): number;
  /** Stop the server (destroys live sockets). */
  close(): Promise<void>;
}

/**
 * Start the loopback upstream. Every request waits `?ms=<n>` (or the default delay) then
 * returns `?bytes=<n>` bytes of filler with a `200`. Latency and payload size are per-request
 * so the `net` archetype can dial in how "expensive" a downstream call is.
 */
export async function startUpstream(opts: UpstreamOptions = {}): Promise<Upstream> {
  const hostname = opts.hostname ?? '127.0.0.1';
  const baseDelay = opts.delayMs ?? 0;
  const baseBytes = opts.bytes ?? 64;
  let served = 0;

  const server = http.createServer((req, res) => {
    served += 1;
    const q = new URL(req.url ?? '/', 'http://x').searchParams;
    const ms = numParam(q.get('ms'), baseDelay);
    const bytes = numParam(q.get('bytes'), baseBytes);
    const respond = (): void => {
      res.writeHead(200, { 'content-type': 'application/octet-stream' });
      res.end(bytes > 0 ? Buffer.alloc(bytes, 0x61) : undefined);
    };
    if (ms > 0) {void delay(ms).then(respond);}
    else {respond();}
  });
  // Keep-alive on: reuse sockets across requests so we measure pool behavior, not TCP churn.
  server.keepAliveTimeout = 60_000;
  server.headersTimeout = 65_000;

  const sockets = trackSockets(server);
  const port = await listen(server, opts.port ?? 0, hostname);

  return {
    url: `http://${hostname}:${port}`,
    port,
    requests: () => served,
    close: () => closeServer(server, sockets),
  };
}

/** Parse a positive-int query param, falling back to `fallback` when absent/invalid. */
function numParam(raw: string | null, fallback: number): number {
  if (raw === null) {return fallback;}
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}
