/**
 * Small `node:http`/timing helpers shared across the harness.
 *
 * @module
 */

import type http from 'node:http';
import type { Socket } from 'node:net';

/** Bind `server` and resolve with the actual port (supports ephemeral `0`). Rejects on listen error. */
export function listen(server: http.Server, port: number, hostname: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const onError = (err: Error): void => reject(err);
    server.once('error', onError);
    server.listen(port, hostname, () => {
      server.removeListener('error', onError);
      const addr = server.address();
      resolve(typeof addr === 'object' && addr ? addr.port : port);
    });
  });
}

/**
 * Track live sockets so a shutdown can destroy them — otherwise keep-alive connections hold the
 * server open past `close()`. Returns the live set.
 */
export function trackSockets(server: http.Server): Set<Socket> {
  const sockets = new Set<Socket>();
  server.on('connection', (s: Socket) => {
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
  });
  return sockets;
}

/** Close an http server and destroy any lingering keep-alive sockets. */
export function closeServer(server: http.Server, sockets: Set<Socket>): Promise<void> {
  return new Promise((resolve, reject) => {
    for (const s of sockets) {s.destroy();}
    server.close((err) => (err ? reject(err) : resolve()));
  });
}

/** Round a number to `digits` decimal places (for tidy reports). */
export function round(n: number, digits = 1): number {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}
