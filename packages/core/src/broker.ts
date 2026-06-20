/**
 * # Broker
 *
 * Cross-instance event fanout. Every {@link Server.emit} publishes to the broker;
 * every server instance subscribes and delivers to its own local WebSocket
 * connections — so an `emit` on one pod reaches subscribers on **all** pods.
 *
 * The message is an opaque string on purpose: the same interface carries any
 * cross-server transport (Redis pub/sub, NATS, Postgres `LISTEN/NOTIFY`, …).
 *
 * @module
 */

/**
 * Pluggable message bus for event fanout across server instances.
 *
 * A conforming implementation needs only two operations: publish an opaque
 * string, and subscribe to receive every published string. Ordering and
 * at-least-once vs at-most-once semantics follow the underlying transport;
 * ayepi treats delivery as best-effort.
 *
 * @example A Redis implementation is ~10 lines:
 * ```ts
 * const redisBroker = (pub: Redis, sub: Redis): Broker => ({
 *   publish: (m) => void pub.publish('ayepi', m),
 *   subscribe: (l) => {
 *     void sub.subscribe('ayepi')
 *     sub.on('message', (_ch, m) => l(m))
 *     return () => void sub.unsubscribe('ayepi')
 *   },
 * })
 * ```
 *
 * @example A Postgres `LISTEN/NOTIFY` implementation:
 * ```ts
 * const pgBroker = (client: Client): Broker => ({
 *   publish: (m) => void client.query('SELECT pg_notify($1, $2)', ['ayepi', m]),
 *   subscribe: (l) => {
 *     void client.query('LISTEN ayepi')
 *     const h = (msg: { payload?: string }) => l(msg.payload ?? '')
 *     client.on('notification', h)
 *     return () => client.removeListener('notification', h)
 *   },
 * })
 * ```
 */
export interface Broker {
  /** Publish an opaque message to every subscriber across all instances. */
  publish(message: string): void | Promise<void>;
  /**
   * Register a listener for published messages.
   * @returns an unsubscribe function that detaches the listener.
   */
  subscribe(listener: (message: string) => void): () => void;
}

/**
 * In-process {@link Broker} — the default when no broker is supplied.
 *
 * Share a single instance between multiple {@link Server}s to simulate a
 * multi-pod deployment in tests: an `emit` on one server is heard by
 * subscribers on the other.
 *
 * @example
 * ```ts
 * const broker = localBroker()
 * const a = server(api, handlers, { broker })
 * const b = server(api, handlers, { broker })
 * a.emit('systemNotice', { msg: 'hi' }) // delivered to b's subscribers too
 * ```
 */
export function localBroker(): Broker {
  const listeners = new Set<(m: string) => void>();
  return {
    publish(m) {
      for (const l of listeners) {l(m);}
    },
    subscribe(l) {
      listeners.add(l);
      return () => void listeners.delete(l);
    },
  };
}
