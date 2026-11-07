/**
 * # Peers — calls a server makes back over its WebSocket connections
 *
 * Two-way request/response on one socket. The connecting side serves a spec of its own (a {@link client} given
 * `serve`), and the accepting side calls it through a {@link Peers} registry handed to {@link server} as
 * `peers`. Every connection the server opens gets a typed {@link Peer}: `peer.call(name, data, opts)` works like
 * `sdk.call` (typed data, results, declared errors, item streams both ways, abort), and `peer.on(...)` subscribes
 * to the connecting side's events.
 *
 * On the wire, frames of the server's calls carry `rid` where the connecting side's calls carry `id`; each side
 * numbers only its own calls, so ids cannot collide. A call lives on one connection: when it closes, every call the
 * server has open on it rejects with `ApiError(0, 'DISCONNECTED')` and the peer's `signal` aborts. A reconnect is a
 * new connection with a new peer.
 *
 * ```ts
 * const systems = peers(systemLink)                          // the spec the connecting side serves
 * const app = server(hubLink, [hubImpl], { peers: systems })
 * systems.onOpen((peer) => void peer.call('ping'))
 * // inside a handler: systems.of(io.ws.conn).call('run', { fn: 'read' })
 * ```
 *
 * @module
 */

import { client, resolveManifest, specOf, type ApiClient, type ClientWs } from './client';
import type { AnySpec } from './endpoint';
import { ApiError } from './errors';
import type { Manifest } from './manifest';
import type { CallReturn, IsHttpOnly, PeerCallArgs } from './payload';
import type { WsConn } from './server';
import { DISCONNECTED_STATUS, OpenCalls, disconnectedFrame, fromReverse, parseFrame, toReverse, type WsFrame } from './ws-calls';

/** The endpoints of `R` a peer can call: every endpoint that is not HTTP-only (files and raw byte streams are). */
export type PeerKeys<R extends AnySpec> = {
  [K in keyof R['endpoints'] & string]: IsHttpOnly<R['endpoints'][K]> extends true ? never : K
}[keyof R['endpoints'] & string];

/** The HTTP-only endpoints of `R`, which a peer spec may not have. */
type HttpOnlyKeys<R extends AnySpec> = Exclude<keyof R['endpoints'] & string, PeerKeys<R>>;

/** The connecting side of one connection, as the accepting server sees it: a typed caller of the spec it serves. */
export interface Peer<R extends AnySpec> {
  /** The connection this peer lives on. */
  readonly conn: WsConn;
  /** Whether the connection is still open. */
  readonly open: boolean;
  /** Aborts (with an `ApiError(0, 'DISCONNECTED')` reason) when the connection closes. */
  readonly signal: AbortSignal;
  /**
   * Call one of the peer's endpoints over the connection. Arguments and result are derived per endpoint exactly as
   * for `sdk.call`; options carry only `signal` and, for streaming-input endpoints, `stream`. Rejects with
   * `ApiError(0, 'DISCONNECTED')` when the connection is closed or closes before the reply.
   */
  call<K extends PeerKeys<R>>(name: K, ...args: PeerCallArgs<R['endpoints'][K]>): CallReturn<R['endpoints'][K]>;
  /** Subscribe to one of the peer's events; returns an unsubscribe function. Subscriptions end with the connection. */
  readonly on: ApiClient<R>['on'];
}

/** Options for {@link peers}. */
export interface PeersOptions {
  /**
   * Parse every result and stream item a peer sends with the spec's schemas (default `true` when {@link peers} is
   * given the spec; there is nothing to validate with when it is given a manifest).
   */
  readonly validate?: boolean;
}

/** The port a {@link server} drives to give its connections peers. */
export interface PeerHost {
  /** A connection opened. */
  attach(conn: WsConn): void;
  /** A frame keyed `rid` arrived on `conn`: part of a call the server made. */
  receive(conn: WsConn, frame: WsFrame): void;
  /** A connection closed. Safe to call more than once. */
  detach(conn: WsConn): void;
}

/** The key under which a {@link Peers} registry exposes its {@link PeerHost} to {@link server}. */
export const peerHost: unique symbol = Symbol('ayepi.peerHost');

/** Anything a server can drive as its peers (a {@link Peers} registry). */
export interface PeerSource {
  readonly [peerHost]: PeerHost;
}

/** A listener for a peer's connection opening or closing. */
export type PeerListener<R extends AnySpec> = (peer: Peer<R>) => void;

/** One connection's peer: a client of the remote spec whose ws is the connection, re-keyed to `rid`. */
class PeerLink<R extends AnySpec> implements Peer<R> {
  readonly #abort = new AbortController();
  readonly #calls = new OpenCalls();
  /** The client engine's inbound handler; `client()` registers it while constructing. */
  #deliver!: (frame: string) => void;
  readonly #client: ApiClient<R>;
  readonly call: Peer<R>['call'];
  readonly on: ApiClient<R>['on'];

  constructor(
    readonly conn: WsConn,
    manifest: Manifest,
    validate: AnySpec | undefined,
  ) {
    const ws: ClientWs = {
      send: (raw) => this.#send(raw),
      onMessage: (cb) => {
        this.#deliver = cb;
      },
    };
    this.#client = client<R>({ baseUrl: 'http://peer.invalid/', manifest, ws, prefer: 'ws', validate, fetchImpl: refuseHttp });
    const loose = this.#client as unknown as { call(name: string, ...args: readonly unknown[]): unknown }; // internal cast: PeerCallArgs is CallArgs without the http-only options
    this.call = ((name: string, ...args: readonly unknown[]) => loose.call(name, ...args)) as Peer<R>['call']; // internal cast: variadic forwarder behind the typed surface
    this.on = this.#client.on;
  }

  get open(): boolean {
    return !this.#abort.signal.aborted;
  }

  get signal(): AbortSignal {
    return this.#abort.signal;
  }

  /** A frame of one of this peer's calls arrived. */
  receive(frame: WsFrame): void {
    this.#calls.settle(frame);
    this.#deliver(fromReverse(frame));
  }

  /** The connection closed: settle every open call and abort the signal. */
  close(): void {
    this.#abort.abort(new ApiError(DISCONNECTED_STATUS, 'DISCONNECTED', 'connection closed'));
    this.#calls.fail(this.#deliver, 'connection closed');
  }

  #send(raw: string): void {
    const frame = parseFrame(raw);
    /* v8 ignore next */ // reason: the client engine only ever sends JSON objects
    if (!frame) {return;}
    /* a call frame (it has a type) awaits a terminal reply; chunks, ends, aborts and subscriptions do not */
    const call = typeof frame.id === 'string' && typeof frame.type === 'string' ? frame.id : null;
    if (!this.open) {
      /* a call on a closed connection settles at once; anything else belongs to a call already settled */
      if (call !== null) {this.#deliver(disconnectedFrame(call, 'connection closed'));}
      return;
    }
    if (call !== null) {this.#calls.add(call);}
    this.conn.send(toReverse(frame));
  }
}

/** Peer calls never travel over HTTP: the connecting side has no listener. */
function refuseHttp(): Promise<Response> {
  return Promise.reject(new ApiError(400, 'PEER_HTTP', 'peer calls travel over the socket only'));
}

/**
 * The peers of a server's connections: one typed {@link Peer} per open connection. Create it with {@link peers},
 * pass it to {@link server} as `peers`, and reach a connection's peer with {@link Peers.of}.
 */
export class Peers<R extends AnySpec> implements PeerSource {
  readonly #manifest: Manifest;
  readonly #validate: AnySpec | undefined;
  readonly #links = new Map<WsConn, PeerLink<R>>();
  readonly #opened = new Set<PeerListener<R>>();
  readonly #closed = new Set<PeerListener<R>>();

  /** The {@link PeerHost} the server drives. */
  readonly [peerHost]: PeerHost = {
    attach: (conn) => this.#attach(conn),
    receive: (conn, frame) => this.#links.get(conn)?.receive(frame),
    detach: (conn) => this.#detach(conn),
  };

  /**
   * @param remote  - the spec the connecting side serves (or its manifest, with `R` given explicitly).
   * @param options - see {@link PeersOptions}.
   */
  constructor(remote: R | Manifest, options: PeersOptions = {}) {
    this.#manifest = resolveManifest(remote);
    const httpOnly = Object.entries(this.#manifest.endpoints).filter(([, m]) => m.httpOnly).map(([name]) => name);
    if (httpOnly.length > 0) {throw new Error(`peer endpoints must work over ws; http-only: ${httpOnly.join(', ')}`);}
    this.#validate = options.validate === false ? undefined : specOf(remote);
  }

  /** The number of open connections. */
  get size(): number {
    return this.#links.size;
  }

  /** Every open connection's peer. */
  [Symbol.iterator](): IterableIterator<Peer<R>> {
    return this.#links.values();
  }

  /** The peer of an open connection, or `undefined` when it is closed or was not opened by a server using this registry. */
  get(conn: WsConn): Peer<R> | undefined {
    return this.#links.get(conn);
  }

  /** The peer of an open connection. Throws when the connection is closed or unknown. */
  of(conn: WsConn): Peer<R> {
    const link = this.#links.get(conn);
    if (!link) {throw new Error(`connection ${conn.id} has no open peer`);}
    return link;
  }

  /** Listen for connections opening. Returns an unsubscribe function. */
  onOpen(listener: PeerListener<R>): () => void {
    this.#opened.add(listener);
    return () => void this.#opened.delete(listener);
  }

  /** Listen for connections closing (after their open calls have settled). Returns an unsubscribe function. */
  onClose(listener: PeerListener<R>): () => void {
    this.#closed.add(listener);
    return () => void this.#closed.delete(listener);
  }

  #attach(conn: WsConn): void {
    const link = new PeerLink<R>(conn, this.#manifest, this.#validate);
    this.#links.set(conn, link);
    for (const listener of [...this.#opened]) {listener(link);}
  }

  #detach(conn: WsConn): void {
    const link = this.#links.get(conn);
    if (!link) {return;}
    this.#links.delete(conn);
    link.close();
    for (const listener of [...this.#closed]) {listener(link);}
  }
}

/**
 * Create the {@link Peers} registry for a server whose connecting sides serve `remote`. A spec with HTTP-only
 * endpoints (files, raw byte streams) is a compile error naming them, and throws.
 *
 * @example
 * ```ts
 * const systems = peers(systemLink)
 * const app = server(hubLink, [hubImpl], { peers: systems })
 * const result = await systems.of(conn).call('run', { fn: 'read', args: { path: 'a.txt' } })
 * ```
 */
export function peers<R extends AnySpec>(
  remote: R | Manifest,
  ...rest: [HttpOnlyKeys<R>] extends [never] ? [options?: PeersOptions] : [error: { readonly httpOnly: HttpOnlyKeys<R> }]
): Peers<R> {
  const [options] = rest;
  return new Peers<R>(remote, options !== undefined && !('httpOnly' in options) ? options : {});
}
