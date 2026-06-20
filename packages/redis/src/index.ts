/**
 * # @ayepi/redis
 *
 * A [Redis](https://redis.io) pub/sub {@link Broker} for ayepi, built for
 * [ioredis](https://github.com/redis/ioredis). Wire it into a {@link Server} so an
 * `emit` on one instance reaches subscribers on **every** instance:
 *
 * ```ts
 * import Redis from 'ioredis'
 * import { redisBroker } from '@ayepi/redis'
 *
 * const app = server(api, [handlers], { broker: redisBroker(new Redis(process.env.REDIS_URL)) })
 * ```
 *
 * ## Design notes
 *
 * - **Dedicated subscriber connection.** A Redis connection in subscribe mode
 *   can't issue other commands, so the broker uses a *separate* connection for
 *   subscribing — by default `client.duplicate()`, or pass your own via
 *   `opts.subscriber`. The original `client` is used only to `publish`.
 * - **Reconnect is handled by ioredis.** ioredis automatically re-subscribes to
 *   its channels after a reconnect, so a network blip doesn't silently stop event
 *   delivery — we subscribe once and let the client maintain it.
 * - **Best-effort, ephemeral semantics.** Redis pub/sub does not persist: an
 *   instance that is down misses events. That's the right model for live UI
 *   events (progress, presence, fan-out chat); use a durable transport (streams,
 *   a queue) if you need guaranteed delivery.
 *
 * @module
 */

import type { Broker } from '@ayepi/core';
import type { PubSub } from '@ayepi/work';

export { redisStore, redisCache } from './backends';
export type { RedisCommandClient, RedisStoreOptions, RedisCacheOptions } from './backends';

/**
 * The minimal ioredis surface this broker uses. `ioredis`'s `Redis` satisfies it
 * structurally; a compatible client (e.g. node-redis with matching method shapes)
 * works too.
 */
export interface RedisLike {
  /** Publish a message to a channel; returns the number of receivers (or a promise of it). */
  publish(channel: string, message: string): Promise<number> | number;
  /** Subscribe the connection to one or more channels. */
  subscribe(...channels: string[]): Promise<unknown> | unknown;
  /** Unsubscribe the connection from one or more channels. */
  unsubscribe(...channels: string[]): Promise<unknown> | unknown;
  /** Create a second connection with the same options (used for the subscriber). */
  duplicate(): RedisLike;
  /** Listen for delivered messages. */
  on(event: 'message', listener: (channel: string, message: string) => void): unknown;
  /** Listen for connection errors. */
  on(event: 'error', listener: (error: Error) => void): unknown;
}

/** Options for {@link redisBroker}. */
export interface RedisBrokerOptions {
  /** The pub/sub channel name (default `'ayepi'`). All instances must agree. */
  readonly channel?: string;
  /**
   * The connection to subscribe on. Defaults to `client.duplicate()`. Provide one
   * if you manage connections yourself — it must be dedicated to subscribing.
   */
  readonly subscriber?: RedisLike;
  /** Notified on publish/subscribe/connection errors. */
  readonly onError?: (error: unknown) => void;
}

/**
 * Create a Redis pub/sub {@link Broker}.
 *
 * @param client - an ioredis connection used to `publish` (a dedicated subscriber
 *                 connection is derived via `client.duplicate()` unless you pass
 *                 `opts.subscriber`).
 */
export function redisBroker(client: RedisLike, opts: RedisBrokerOptions = {}): Broker {
  const channel = opts.channel ?? 'ayepi';
  const sub = opts.subscriber ?? client.duplicate();
  const listeners = new Set<(message: string) => void>();
  const onError = opts.onError;
  let wired = false;

  const wire = (): void => {
    if (wired) {return;}
    wired = true;
    sub.on('message', (ch, message) => {
      if (ch !== channel) {return;}
      for (const l of listeners) {
        try {
          l(message);
        } catch (err) {
          onError?.(err);
        }
      }
    });
    if (onError) {
      sub.on('error', onError);
      client.on('error', onError);
    }
    // subscribe once; ioredis re-subscribes automatically across reconnects
    Promise.resolve()
      .then(() => sub.subscribe(channel))
      .catch((err: unknown) => onError?.(err));
  };

  return {
    publish(message) {
      return Promise.resolve()
        .then(() => client.publish(channel, message))
        .then(
          () => undefined,
          (err: unknown) => {
            onError?.(err);
          },
        );
    },
    subscribe(listener) {
      wire();
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

/**
 * The `@ayepi/work` {@link PubSub} backed by Redis pub/sub — the same fanout as
 * {@link redisBroker} (the two ports are identical), exposed under the work-port name so
 * `{ store: redisStore(c), pubsub: redisPubSub(c) }` reads cleanly. Best-effort: it wakes
 * distributed waiters; the engine's store-poll fallback covers a silent channel.
 */
export function redisPubSub(client: RedisLike, opts: RedisBrokerOptions = {}): PubSub {
  return redisBroker(client, opts);
}
