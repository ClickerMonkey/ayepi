/**
 * # Served link
 *
 * The connecting side of a two-way socket. A {@link client} given `serve` hands every frame keyed by
 * {@link REVERSE_ID} to a {@link ServedLink}, which runs it through the local server's ws handler on one virtual
 * connection and sends the replies back re-keyed. The local server does all the work (routing, validation,
 * middleware, item streams, cancellation, events); this module only re-keys frames and ties the virtual connection
 * to the life of the real socket.
 *
 * Zod-free: the server is reached through the {@link Serves} port, a type-only view of {@link Server}.
 *
 * @module
 */

import type { AnySpec } from './endpoint';
import type { Server, WsConn } from './server';
import { REVERSE_ID, fromReverse, parseFrame, toReverse, type WsFrame } from './ws-calls';

/** What a client needs from the server it serves over the socket: its ws handler. */
export interface Serves {
  readonly ws: Server<AnySpec>['ws'];
}

/** The status and code a client that serves nothing answers the server's calls with. */
const NOT_SERVED = { $status: 501, $code: 'NOT_SERVED', $error: 'this client serves no spec' } as const;

/** Answer a call the server made when this side serves nothing, so the server's call rejects instead of hanging. */
export function refuseReverse(frame: WsFrame, send: (frame: string) => void): void {
  const rid = frame[REVERSE_ID];
  if (typeof rid === 'string' && typeof frame.type === 'string') {send(JSON.stringify({ [REVERSE_ID]: rid, ...NOT_SERVED }));}
}

/**
 * One served connection at a time, opened on the first reverse frame and closed when the socket drops. Closing it
 * aborts the calls in flight and clears the server's subscriptions, mirroring what the accepting side does with its
 * end of the dropped socket; a reconnect starts a fresh connection.
 */
export class ServedLink {
  #conn: WsConn | null = null;

  /**
   * @param app     - the local server whose spec this side serves.
   * @param send    - writes a frame to the socket.
   * @param request - builds the request the virtual connection carries (what the server's middleware sees as `req`).
   */
  constructor(
    private readonly app: Serves,
    private readonly send: (frame: string) => void,
    private readonly request: () => Request,
  ) {}

  /** Feed one reverse frame to the local server. */
  receive(frame: WsFrame): void {
    const conn = this.#conn ?? this.#open();
    void this.app.ws.message(conn, fromReverse(frame));
  }

  /** Close the served connection (the socket dropped). */
  drop(): void {
    const conn = this.#conn;
    if (!conn) {return;}
    this.#conn = null;
    this.app.ws.close(conn);
  }

  #open(): WsConn {
    const conn: WsConn = this.app.ws.open((out) => {
      const frame = parseFrame(out);
      /* a frame from a closed connection belongs to the socket that dropped */
      if (frame && this.#conn === conn) {this.send(toReverse(frame));}
    }, this.request());
    this.#conn = conn;
    return conn;
  }
}
