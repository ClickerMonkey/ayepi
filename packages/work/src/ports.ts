/**
 * # Ports
 *
 * The three pluggable seams every backend slots into. `@ayepi/work` ships an
 * in-memory implementation of all three ({@link memoryQueue}/{@link memoryPubSub}/
 * {@link memoryStore}); a distributed deployment swaps in Redis/SQS/etc. behind the
 * same interfaces with no engine changes.
 *
 * All durations are **milliseconds**.
 *
 * - {@link Queue} — the durable work log: push bodies, lease a batch, heartbeat the
 *   lease, ack/fail/dead-letter. At-least-once with a visibility timeout, so a dead
 *   worker's in-flight item is redelivered.
 * - {@link PubSub} — best-effort cross-instance fanout (identical shape to
 *   `@ayepi/core`'s `Broker`): used to wake distributed waiters and nudge gates.
 * - {@link Store} — get/set with TTL plus a compare-and-set primitive
 *   ({@link Store.setIfNotExists}) that backs every idempotency/lease concern.
 *
 * @module
 */

/** Options for {@link Queue.push}. */
export interface PushOptions {
  /** Delay before the item first becomes visible (retry backoff, scheduled work). */
  readonly delay?: number;
  /**
   * Idempotency key. If a backend supports it, pushing a second body with the same
   * key while the first is still pending is a no-op — used for at-least-once-safe
   * fan-out (dependency payloads, retries). Best-effort; not all backends dedupe.
   */
  readonly dedupeKey?: string;
}

/**
 * A unit of work leased from a {@link Queue}. `handle` is the backend-specific token
 * (a memory lease token, an SQS receipt handle, a Redis lease id, …) — pass the same
 * object back to {@link Queue.heartbeat}/{@link Queue.ack}/{@link Queue.fail}.
 */
export interface PulledWork {
  /** The opaque message body (a JSON-encoded work envelope). */
  readonly body: string;
  /** Backend-specific lease/receipt handle — round-tripped to heartbeat/ack/fail. */
  readonly handle: unknown;
  /** Delivery attempt for this body, starting at 1 (increments on redelivery). */
  readonly attempt: number;
}

/**
 * The durable work log. At-least-once delivery with a visibility timeout: a popped
 * item is invisible to other workers until its lease elapses; a worker keeps the
 * lease alive with {@link heartbeat} and removes the item with {@link ack}. A worker
 * that dies without acking lets the lease expire, and the item is redelivered.
 */
export interface Queue {
  /** Append a body to the log (optionally delayed/deduped). */
  push(body: string, opts?: PushOptions): void | Promise<void>;
  /**
   * Lease up to `max` currently-visible items, hiding each for `visibility` ms.
   * Returns fewer (or none) when the queue is short. Reclaims items whose lease
   * expired (redelivery) before leasing fresh ones.
   */
  pop(max: number, visibility: number): PulledWork[] | Promise<PulledWork[]>;
  /** Extend a leased item's visibility by `visibility` ms (called on a heartbeat). */
  heartbeat(pulled: PulledWork, visibility: number): void | Promise<void>;
  /** Permanently remove a leased item (it completed). A stale lease must not ack. */
  ack(pulled: PulledWork): void | Promise<void>;
  /** Return a leased item to the queue, visible again after `delay` ms (a retry). */
  fail(pulled: PulledWork, delay?: number): void | Promise<void>;
  /** Move a body to a dead-letter sink after exhausting retries (optional). */
  deadLetter?(body: string, error: string): void | Promise<void>;
  /**
   * Approximate number of messages currently in the queue (best-effort, backend-defined — may
   * include in-flight leases). Optional; when present, the work engine reports queue depth as
   * `queued` in {@link WorkSystemOptions.onBacklog}. Kept cheap (a single count/attribute call).
   */
  size?(): number | Promise<number>;
}

/**
 * Best-effort cross-instance message fanout. Identical in shape to `@ayepi/core`'s
 * `Broker`: publish an opaque string, subscribe to every published string.
 */
export interface PubSub {
  /** Publish an opaque message to every subscriber across all instances. */
  publish(message: string): void | Promise<void>;
  /**
   * Register a listener for published messages.
   * @returns an unsubscribe function that detaches the listener.
   */
  subscribe(listener: (message: string) => void): () => void;
}

/**
 * A small key/value store with TTL and one compare-and-set primitive.
 * {@link setIfNotExists} is the single atom every distributed claim is built on:
 * dependency fire-once, scheduler tick lease, group-handled claim, waiter registry.
 */
export interface Store {
  /** Read a value, or `undefined` if absent/expired. */
  get(key: string): string | undefined | Promise<string | undefined>;
  /** Write a value, optionally expiring after `ttl` ms. */
  set(key: string, value: string, ttl?: number): void | Promise<void>;
  /** Delete a key (optional). */
  delete?(key: string): void | Promise<void>;
  /**
   * Set **only if absent**. Returns `true` when this caller won the slot, `false` when
   * the key already held a (non-expired) value. The atomic claim every
   * idempotency/lease concern relies on.
   */
  setIfNotExists(key: string, value: string, ttl?: number): boolean | Promise<boolean>;
  /**
   * Atomically add `by` (may be negative) to an integer key and return the new value.
   * Backs the group open-work counter. Optional: when absent the engine falls back to
   * a (non-atomic) get+set, which is only safe on a single-process backend.
   */
  increment?(key: string, by: number, ttl?: number): number | Promise<number>;
}

/** The three ports a backend provides together. */
export interface Backend {
  readonly queue: Queue;
  readonly pubsub: PubSub;
  readonly store: Store;
}
