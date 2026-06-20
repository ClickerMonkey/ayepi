/**
 * # In-memory backend
 *
 * A zero-dependency implementation of all three {@link Backend} ports that
 * **simulates the distributed protocol** — visibility-timeout leases with
 * heartbeat-driven redelivery, TTL'd store with an atomic `setIfNotExists`, and
 * in-process fanout. Share one backend between several `createWork` instances to model
 * a multi-pod deployment in tests, and inject `now` to drive time deterministically.
 *
 * The {@link memoryQueue} can additionally be **file-backed** (`file: './work-queue.json'`)
 * so pending work survives a process restart — single-process durability without standing up
 * Redis/SQS. State is written atomically (temp file + rename) after every mutation; on startup
 * the file is reloaded and any in-flight (leased) item is redelivered, since the worker that
 * held its lease is gone.
 *
 * @module
 */

import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Backend, Store, PubSub, PulledWork, Queue } from './ports';
import { uuid, type Clock } from './internal';

/** Options shared by the in-memory ports (mainly the injectable clock). */
export interface MemoryOptions {
  /** Clock injection for deterministic tests (default `Date.now`). */
  readonly now?: Clock;
}

/**
 * The minimal **synchronous** filesystem surface the file-backed {@link memoryQueue} uses.
 * `node:fs` satisfies it (the default); tests inject their own. Writes are synchronous so the
 * queue's own synchronous operations stay synchronous.
 */
export interface QueueFsLike {
  /** Read a file's contents, or `undefined` when it doesn't exist. */
  readFile(path: string): string | undefined;
  /** Write (overwrite) a file. */
  writeFile(path: string, data: string): void;
  /** Rename a file (used for an atomic temp → target swap). */
  rename(from: string, to: string): void;
  /** Ensure a directory exists (recursive; called once before the first write). */
  mkdir(path: string): void;
}

/** The default {@link QueueFsLike}, backed by synchronous `node:fs`. */
const nodeQueueFs: QueueFsLike = {
  readFile: (p) => (existsSync(p) ? readFileSync(p, 'utf8') : undefined),
  writeFile: (p, d) => writeFileSync(p, d),
  rename: (a, b) => renameSync(a, b),
  mkdir: (p) => void mkdirSync(p, { recursive: true }),
};

/* ---- pub/sub ---- */

/**
 * In-process {@link PubSub} (the `localBroker` shape). Share one instance across
 * engines to fan a publish out to every "pod".
 */
export function memoryPubSub(): PubSub {
  const listeners = new Set<(m: string) => void>();
  return {
    publish(m) {
      for (const l of [...listeners]) {l(m);} // copy: a listener may unsubscribe mid-dispatch
    },
    subscribe(l) {
      listeners.add(l);
      return () => void listeners.delete(l);
    },
  };
}

/* ---- key/value store ---- */

interface Entry {
  value: string;
  expires?: number;
}

/**
 * In-memory {@link Store} with lazy TTL expiry and an atomic {@link Store.setIfNotExists}.
 * The compare-and-set every distributed claim relies on.
 */
export function memoryStore(opts: MemoryOptions = {}): Store {
  const now = opts.now ?? Date.now;
  const map = new Map<string, Entry>();
  const live = (key: string): Entry | undefined => {
    const e = map.get(key);
    if (!e) {return undefined;}
    if (e.expires !== undefined && e.expires <= now()) {
      map.delete(key);
      return undefined;
    }
    return e;
  };
  return {
    get: (key) => live(key)?.value,
    set: (key, value, ttl) => void map.set(key, { value, expires: ttl ? now() + ttl : undefined }),
    delete: (key) => void map.delete(key),
    setIfNotExists: (key, value, ttl) => {
      if (live(key)) {return false;}
      map.set(key, { value, expires: ttl ? now() + ttl : undefined });
      return true;
    },
    increment: (key, by, ttl) => {
      const cur = Number(live(key)?.value ?? '0') + by;
      map.set(key, { value: String(cur), expires: ttl ? now() + ttl : undefined });
      return cur;
    },
  };
}

/* ---- queue ---- */

interface QItem {
  body: string;
  /** Earliest time the item may be leased (delay / retry backoff). */
  visibleAt: number;
  /** The current lease's expiry, if leased. */
  leaseUntil?: number;
  /** The current lease token; only the holder may heartbeat/ack/fail. */
  leaseToken?: string;
  /** Completed (failed/expired) deliveries so far; the next delivery is `attempt + 1`. */
  attempt: number;
  /** Idempotency key (drops duplicate pushes while pending). */
  dedupeKey?: string;
}

/** Dead-lettered bodies, exposed for inspection in tests via {@link MemoryQueue.dead}. */
export interface DeadLettered {
  readonly body: string;
  readonly error: string;
}

/** A {@link Queue} plus the in-memory extras tests reach for (its operations are synchronous). */
export interface MemoryQueue extends Queue {
  /** Lease up to `max` visible items (synchronous — reclaims expired leases first). */
  pop(max: number, visibility: number): PulledWork[];
  /** Items currently moved to the dead-letter sink. */
  readonly dead: readonly DeadLettered[];
  /** Count of items still in the queue (leased or visible). */
  size(): number;
}

/** File-persistence options for {@link memoryQueue} — single-process durability. */
export interface MemoryQueuePersistence {
  /**
   * Persist the queue (pending items + dead-letter sink) to this file so work survives a
   * process restart. Writes are atomic (a temp file is renamed over the target) and happen
   * after every mutation. On startup the file is reloaded. Omit for a pure in-memory queue.
   */
  readonly file?: string;
  /** Injected filesystem (default synchronous `node:fs`). For tests, or a custom backing store. */
  readonly fs?: QueueFsLike;
  /**
   * Observe a (best-effort) persistence error — a load that found a corrupt file, or a failed
   * write. Persistence never throws into the engine: the in-memory state stays authoritative
   * for the running process and the failure is reported here. Off by default; must not throw.
   */
  readonly onError?: (err: unknown) => void;
}

/** Options for {@link memoryQueue}: the shared clock plus optional file {@link MemoryQueuePersistence}. */
export interface MemoryQueueOptions extends MemoryOptions, MemoryQueuePersistence {}

/** The persisted file shape — the durable slice of a {@link memoryQueue}. */
interface PersistedQueue {
  readonly items: QItem[];
  readonly dead: DeadLettered[];
}

/**
 * In-memory {@link Queue} with visibility-timeout leasing. `pop` first **reclaims**
 * items whose lease expired (a dead worker → redelivery, `attempt++`), then leases
 * fresh visible items. `ack`/`heartbeat`/`fail` are token-gated, so a stale worker
 * whose lease already lapsed cannot ack work another worker now owns.
 *
 * Pass `file` to make it **durable**: state is reloaded on construction and rewritten
 * atomically after every mutation. A heartbeat is *not* persisted (lease expiry is
 * reset on reload anyway), so steady-state heartbeating doesn't touch the disk.
 */
export function memoryQueue(opts: MemoryQueueOptions = {}): MemoryQueue {
  const now = opts.now ?? Date.now;
  const items: QItem[] = [];
  const dead: DeadLettered[] = [];
  const find = (token: unknown): QItem | undefined => items.find((i) => i.leaseToken === token);

  /* ---- optional file persistence ---- */
  const file = opts.file;
  const fs = opts.fs ?? nodeQueueFs;
  const tmpFile = file !== undefined ? `${file}.tmp` : '';
  let dirEnsured = false;
  const report = (err: unknown): void => {
    try {
      opts.onError?.(err);
    } catch {
      /* persistence reporting must never disrupt the queue */
    }
  };
  const persist = (): void => {
    if (file === undefined) {return;}
    try {
      if (!dirEnsured) {
        const dir = dirname(file);
        if (dir !== '.') {fs.mkdir(dir);} // dirname() yields '.' for a bare filename — nothing to create
        dirEnsured = true;
      }
      fs.writeFile(tmpFile, JSON.stringify({ items, dead } satisfies PersistedQueue));
      fs.rename(tmpFile, file); // atomic swap — a crash mid-write can't corrupt the target
    } catch (err) {
      report(err); // best-effort: the running queue is unaffected
    }
  };
  const load = (): void => {
    if (file === undefined) {return;}
    let raw: string | undefined;
    try {
      raw = fs.readFile(file);
    } catch (err) {
      report(err);
      return;
    }
    if (raw === undefined) {return;} // no prior file → start empty
    try {
      const parsed = JSON.parse(raw) as Partial<PersistedQueue>;
      for (const i of parsed.items ?? []) {
        if (i.leaseToken !== undefined) {
          // an in-flight delivery whose worker is gone → redeliver (its lease is spent)
          i.leaseToken = undefined;
          i.leaseUntil = undefined;
          i.attempt += 1;
          i.visibleAt = now();
        }
        items.push(i);
      }
      for (const d of parsed.dead ?? []) {dead.push(d);}
    } catch (err) {
      report(err); // corrupt file → start empty rather than crash
    }
  };
  load();

  return {
    dead,
    size: () => items.length,
    push(body, o) {
      if (o?.dedupeKey && items.some((i) => i.dedupeKey === o.dedupeKey)) {return;}
      items.push({ body, visibleAt: now() + (o?.delay ?? 0), attempt: 0, dedupeKey: o?.dedupeKey });
      persist();
    },
    pop(max, visibility) {
      const t = now();
      let changed = false;
      // reclaim expired leases first (missed-heartbeat redelivery)
      for (const i of items) {
        if (i.leaseToken && i.leaseUntil !== undefined && i.leaseUntil <= t) {
          i.leaseToken = undefined;
          i.leaseUntil = undefined;
          i.attempt += 1;
          changed = true;
        }
      }
      const out: PulledWork[] = [];
      for (const i of items) {
        if (out.length >= max) {break;}
        if (i.leaseToken || i.visibleAt > t) {continue;}
        const token = uuid();
        i.leaseToken = token;
        i.leaseUntil = t + visibility;
        out.push({ body: i.body, handle: token, attempt: i.attempt + 1 });
        changed = true;
      }
      if (changed) {persist();} // skip the disk on an idle poll that leased nothing
      return out;
    },
    heartbeat(p, visibility) {
      const i = find(p.handle);
      if (i) {i.leaseUntil = now() + visibility;} // not persisted — lease expiry is reset on reload
    },
    ack(p) {
      const idx = items.findIndex((i) => i.leaseToken === p.handle);
      if (idx >= 0) {
        items.splice(idx, 1); // token-gated: a stale lease no longer matches
        persist();
      }
    },
    fail(p, delay) {
      const i = find(p.handle);
      if (!i) {return;}
      i.leaseToken = undefined;
      i.leaseUntil = undefined;
      i.attempt = p.attempt; // this delivery is spent; next pop is attempt + 1
      i.visibleAt = now() + (delay ?? 0);
      persist();
    },
    deadLetter(body, error) {
      dead.push({ body, error });
      persist();
    },
  };
}

/* ---- bundle ---- */

/** Options for {@link memoryBackend}: the shared clock plus optional queue file persistence. */
export interface MemoryBackendOptions extends MemoryOptions {
  /**
   * File-persistence for the bundled queue (the store and pub/sub stay purely in-memory).
   * Pass `{ file: '…' }` to make pending work survive a process restart.
   */
  readonly queue?: MemoryQueuePersistence;
}

/**
 * The three in-memory ports together, sharing one clock. The default backend when
 * `createWork()` is called with no ports.
 *
 * @example A two-pod test on one shared backend:
 * ```ts
 * const backend = memoryBackend()
 * const podA = createWork({ ...backend, work: [add] })
 * const podB = createWork({ ...backend, work: [add] })
 * ```
 *
 * @example A single durable process — pending work survives a restart:
 * ```ts
 * const backend = memoryBackend({ queue: { file: './work-queue.json' } })
 * const work = createWork({ ...backend, work: [add] })
 * ```
 */
export function memoryBackend(opts: MemoryBackendOptions = {}): Backend {
  return { queue: memoryQueue({ now: opts.now, ...opts.queue }), pubsub: memoryPubSub(), store: memoryStore(opts) };
}
