/**
 * # 11 · fullstack — pluggable backends (server-only)
 *
 * The work engine and the response cache run on **swappable ports**. In production you'd
 * pass a real Redis client (`ioredis`) and a real `SQSClient`; here we drive the *same
 * adapters* — `@ayepi/redis`'s `redisStore`/`redisPubSub`/`redisCache` and `@ayepi/aws`'s
 * `sqsQueue` — against tiny **in-memory stand-in clients** that implement exactly the
 * client surface each adapter calls. So the real adapter code paths are exercised and
 * built, with **zero infrastructure and zero extra runtime dependencies**.
 *
 * Pick the work backend with `BACKEND=memory | redis | sqs` (default `memory`). The
 * response cache always runs on `redisCache` (over the stand-in), so `@ayepi/redis` is
 * exercised on every run.
 *
 * This module is imported by the Node **api** only — never the browser app.
 */
import type { Queue, Store, PubSub } from '@ayepi/work';
import type { CacheStore } from '@ayepi/cache';
import { redisStore, redisPubSub, redisCache, type RedisCommandClient, type RedisLike } from '@ayepi/redis';
import { sqsQueue } from '@ayepi/aws/sqs';

/** The client type `sqsQueue` expects — derived so we never import `@aws-sdk` directly. */
type SqsClient = Parameters<typeof sqsQueue>[0]['client'];

const now = (): number => Date.now();
const uuid = (): string => `${now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

/* ---------------------------------------------------------------------------------------
 * A Map-backed `RedisCommandClient` — the exact command surface `redisStore`/`redisCache`
 * use: GET, SET (+`PX`/`NX`), DEL, INCRBY, PEXPIRE, and SCAN (`MATCH`/`COUNT`).
 * ------------------------------------------------------------------------------------- */
export function memoryRedisCommands(): RedisCommandClient {
  const data = new Map<string, { value: string; expireAt?: number }>();

  const live = (key: string): { value: string; expireAt?: number } | undefined => {
    const e = data.get(key);
    if (!e) return undefined;
    if (e.expireAt !== undefined && e.expireAt <= now()) {
      data.delete(key);
      return undefined;
    }
    return e;
  };
  const glob = (pattern: string): RegExp => new RegExp('^' + pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$');

  return {
    get: (key) => Promise.resolve(live(key)?.value ?? null),
    set: (key, value, ...args) => {
      // parse `PX <ms>` and `NX` out of the variadic options
      let px: number | undefined;
      let nx = false;
      for (let i = 0; i < args.length; i++) {
        const a = String(args[i]).toUpperCase();
        if (a === 'PX') px = Number(args[++i]);
        else if (a === 'NX') nx = true;
      }
      if (nx && live(key)) return Promise.resolve(null); // SET NX fails when the key exists
      data.set(key, { value, expireAt: px !== undefined ? now() + px : undefined });
      return Promise.resolve('OK');
    },
    del: (...keys) => {
      let n = 0;
      for (const k of keys) if (data.delete(k)) n++;
      return Promise.resolve(n);
    },
    incrby: (key, by) => {
      const next = Number(live(key)?.value ?? '0') + by;
      data.set(key, { value: String(next), expireAt: data.get(key)?.expireAt });
      return Promise.resolve(next);
    },
    pexpire: (key, ms) => {
      const e = live(key);
      if (!e) return Promise.resolve(0);
      e.expireAt = now() + ms;
      return Promise.resolve(1);
    },
    scan: (_cursor, ...args) => {
      let match = '*';
      for (let i = 0; i < args.length; i++) {
        if (String(args[i]).toUpperCase() === 'MATCH') match = String(args[++i]);
      }
      const re = glob(match);
      const keys = [...data.keys()].filter((k) => live(k) && re.test(k));
      return Promise.resolve(['0', keys]); // single-pass: always returns the terminal cursor
    },
  };
}

/* ---------------------------------------------------------------------------------------
 * An in-process pub/sub hub presenting the `RedisLike` surface `redisPubSub` needs:
 * publish / subscribe / unsubscribe / duplicate / on('message'|'error').
 * ------------------------------------------------------------------------------------- */
type Conn = { channels: Set<string>; onMessage?: (channel: string, message: string) => void };

export function memoryRedisPubSubClient(): RedisLike {
  const conns = new Set<Conn>();
  const make = (): RedisLike => {
    const conn: Conn = { channels: new Set() };
    conns.add(conn);
    const self: RedisLike = {
      publish: (channel, message) => {
        let n = 0;
        for (const c of conns) {
          if (c.channels.has(channel) && c.onMessage) {
            c.onMessage(channel, message);
            n++;
          }
        }
        return n;
      },
      subscribe: (...channels: string[]) => {
        for (const ch of channels) conn.channels.add(ch);
        return undefined;
      },
      unsubscribe: (...channels: string[]) => {
        for (const ch of channels) conn.channels.delete(ch);
        return undefined;
      },
      duplicate: () => make(),
      on: (event: 'message' | 'error', listener: ((channel: string, message: string) => void) | ((error: Error) => void)) => {
        if (event === 'message') conn.onMessage = listener as (channel: string, message: string) => void;
        return self;
      },
    };
    return self;
  };
  return make();
}

/* ---------------------------------------------------------------------------------------
 * A faithful in-memory SQS, exposing only `send(command)` — the surface `sqsQueue` uses.
 * Implements visibility timeouts, receipt handles, receive counts, delays, and delete.
 * ------------------------------------------------------------------------------------- */
interface SqsMsg {
  id: string;
  body: string;
  visibleAt: number; // epoch ms the message becomes receivable
  receiptHandle?: string; // current in-flight handle (rotated each receive)
  receiveCount: number;
}

export function memorySqsClient(): SqsClient {
  const msgs = new Map<string, SqsMsg>();
  const byHandle = new Map<string, string>(); // receiptHandle → message id
  const input = (command: unknown): Record<string, unknown> => (command as { input: Record<string, unknown> }).input;

  const send = (command: unknown): Promise<unknown> => {
    const name = (command as { constructor: { name: string } }).constructor.name;
    const i = input(command);
    switch (name) {
      case 'SendMessageCommand': {
        const id = uuid();
        const delayMs = (Number(i.DelaySeconds ?? 0)) * 1000;
        msgs.set(id, { id, body: String(i.MessageBody ?? ''), visibleAt: now() + delayMs, receiveCount: 0 });
        return Promise.resolve({ MessageId: id });
      }
      case 'ReceiveMessageCommand': {
        const max = Number(i.MaxNumberOfMessages ?? 1);
        const visMs = Number(i.VisibilityTimeout ?? 30) * 1000;
        const out: Array<Record<string, unknown>> = [];
        for (const m of msgs.values()) {
          if (out.length >= max) break;
          if (m.visibleAt > now()) continue; // not yet visible (delayed or in-flight)
          if (m.receiptHandle) byHandle.delete(m.receiptHandle);
          m.receiptHandle = uuid();
          m.receiveCount++;
          m.visibleAt = now() + visMs; // hide for the visibility window
          byHandle.set(m.receiptHandle, m.id);
          out.push({ MessageId: m.id, ReceiptHandle: m.receiptHandle, Body: m.body, Attributes: { ApproximateReceiveCount: String(m.receiveCount) } });
        }
        return Promise.resolve({ Messages: out });
      }
      case 'ChangeMessageVisibilityCommand': {
        const id = byHandle.get(String(i.ReceiptHandle));
        const m = id ? msgs.get(id) : undefined;
        if (m) m.visibleAt = now() + Number(i.VisibilityTimeout ?? 0) * 1000;
        return Promise.resolve({});
      }
      case 'DeleteMessageCommand': {
        const handle = String(i.ReceiptHandle);
        const id = byHandle.get(handle);
        if (id) {
          msgs.delete(id);
          byHandle.delete(handle);
        }
        return Promise.resolve({});
      }
      default:
        return Promise.resolve({});
    }
  };

  return { send } as unknown as SqsClient; // stand-in: only `.send(command)` is exercised
}

/** Which work backend to wire, from `BACKEND` (default `memory`). */
export type BackendKind = 'memory' | 'redis' | 'sqs';

/** The selected ports: a (partial) work backend plus the always-on `redisCache` store. */
export interface SelectedBackends {
  readonly kind: BackendKind;
  readonly label: string;
  /** Ports to spread into `createWork(...)` — empty for `memory` (uses the bundled backend). */
  readonly work: { queue?: Queue; store?: Store; pubsub?: PubSub };
  /** The response-cache store (always a `redisCache` over the stand-in). */
  readonly cacheStore: CacheStore;
}

/** Build the backends for `kind`. Shares one stand-in Redis between the work store and cache. */
export function selectBackends(kind: BackendKind = (process.env.BACKEND as BackendKind) || 'memory'): SelectedBackends {
  const redisCmd = memoryRedisCommands();
  const cacheStore = redisCache(redisCmd, { prefix: 'cache:' });

  if (kind === 'redis') {
    return {
      kind,
      label: '@ayepi/redis (store + pubsub) over an in-memory client',
      work: { store: redisStore(redisCmd, { prefix: 'work:' }), pubsub: redisPubSub(memoryRedisPubSubClient()) },
      cacheStore,
    };
  }
  if (kind === 'sqs') {
    return {
      kind,
      label: '@ayepi/aws sqsQueue + @ayepi/redis store/pubsub over in-memory clients',
      work: {
        queue: sqsQueue({ client: memorySqsClient(), queueUrl: 'memory://work', waitTimeSeconds: 0 }),
        store: redisStore(redisCmd, { prefix: 'work:' }),
        pubsub: redisPubSub(memoryRedisPubSubClient()),
      },
      cacheStore,
    };
  }
  return { kind: 'memory', label: 'bundled in-memory work backend', work: {}, cacheStore };
}
