/**
 * # @ayepi/cache
 *
 * Response-caching middleware for [`@ayepi/core`](https://www.npmjs.com/package/@ayepi/core).
 * {@link cache} builds a middleware that derives a **key from the request** (method +
 * path + query, plus an optional dev-defined `vary` — e.g. the authenticated user) and,
 * on a **hit**, replays the stored response without running the handler. Entries live in
 * memory for a bounded **time** (`ttl`, with optional `stale-while-revalidate`) and a
 * bounded **space** (`maxBytes` / `maxEntryBytes` / `maxEntries`, LRU-evicted).
 *
 * ```ts
 * // shared.ts (frontend-safe): the def declares what it contributes
 * import { cache } from '@ayepi/cache'
 * const cached = cache()                                   // provides { cache } to handlers
 * spec({ endpoints: { ...cached.group({ … }) } })
 *
 * // server.ts: bind the policy (ttl, vary, bounds)
 * import { cache } from '@ayepi/cache/server'
 * implement(api).middleware(cache.server(cached, {
 *   ttl: 30_000,                                           // fresh for 30s
 *   vary: (io) => io.ctx.user.id,                          // per-user cache
 *   maxBytes: 64 * 1024 * 1024,
 * }))
 * ```
 *
 * - **Bounded memory** — the default {@link memoryCache} is an LRU store with total/entry
 *   byte caps and an entry-count cap; dead entries are swept lazily.
 * - **Time controls** — `ttl` (freshness) and `staleWhileRevalidate` (serve-stale grace).
 * - **Customizable** — `key`/`vary`, `methods`, `shouldCache`, response headers, `skip`,
 *   request `Cache-Control` respect, and per-response opt-out via `io.ctx.cache`.
 *
 * @module
 */

import { middleware, ctx } from '@ayepi/core';
import type { AnyMiddleware, Json, MaybePromise, MiddlewareDef } from '@ayepi/core';

/* ---- tunable constants ---- */
/** Default middleware name. */
const DEFAULT_NAME = 'cache';
/** Milliseconds per second — `Age` / `Cache-Control: max-age` are expressed in seconds. */
const MS_PER_SECOND = 1000;
/** Default total cache capacity (bytes) for {@link memoryCache}. */
const DEFAULT_MAX_BYTES = 64 * 1024 * 1024;
/** Default per-entry cap (bytes) — larger responses are not cached. */
const DEFAULT_MAX_ENTRY_BYTES = 1024 * 1024;
/** Default entry-count cap. */
const DEFAULT_MAX_ENTRIES = 10_000;

/** A stored response, ready to replay. */
export interface CacheEntry {
  /** The serialized JSON response body. */
  readonly body: string;
  /** The HTTP status to replay (a 2xx). */
  readonly status: number;
  /** Response headers to replay (e.g. `content-type`). */
  readonly headers: readonly (readonly [string, string])[];
  /** When the entry was stored (ms epoch). */
  readonly storedAt: number;
  /** Fresh until this time (ms epoch) — served as a `HIT` before it. */
  readonly expires: number;
  /** Serve-stale grace boundary (ms epoch) — `>= expires`; a `STALE` hit until it, then dead. */
  readonly staleUntil: number;
  /** The serialized body's byte length (what counts toward the store's space bounds). */
  readonly bytes: number;
  /** The request method this entry answers. */
  readonly method: string;
  /** The request path this entry answers. */
  readonly path: string;
  /** The full cache key (used to double-check against hash collisions); the hashed store key when `checkKey` is off. */
  readonly key: string;
}

/** The subset of an entry exposed to {@link CacheStore.invalidate} predicates. */
export interface EntryMeta {
  readonly key: string;
  readonly method: string;
  readonly path: string;
  readonly storedAt: number;
  readonly expires: number;
  readonly staleUntil: number;
  readonly bytes: number;
}

/**
 * Pluggable cache backend. The default is the in-process {@link memoryCache}; implement
 * this interface to back the cache with another store. The store owns **space** (which
 * entries to keep); the middleware owns **time** (freshness vs `entry.expires`).
 */
export interface CacheStore {
  /** Fetch a stored entry (and mark it most-recently-used), or `undefined`. */
  get(key: string): MaybePromise<CacheEntry | undefined>;
  /** Store an entry, evicting as needed to stay within the store's bounds. */
  set(key: string, entry: CacheEntry): MaybePromise<void>;
  /** Remove one entry; returns whether it existed. */
  delete(key: string): MaybePromise<boolean>;
  /** Drop every entry. */
  clear(): MaybePromise<void>;
  /** Remove every entry matching `pred`; returns how many were removed. Powers manual invalidation and the time-sweep. */
  invalidate(pred: (meta: EntryMeta) => boolean): MaybePromise<number>;
}

/** Options for {@link memoryCache}. */
export interface MemoryCacheOptions {
  /** Total capacity in bytes (default 64 MiB) — LRU-evicted when exceeded. */
  readonly maxBytes?: number;
  /** Per-entry cap in bytes (default 1 MiB) — larger responses are skipped. */
  readonly maxEntryBytes?: number;
  /** Maximum number of entries (default 10 000) — LRU-evicted when exceeded. */
  readonly maxEntries?: number;
}

/**
 * Create an in-process LRU {@link CacheStore} bounded by total bytes, per-entry bytes,
 * and entry count. The default store — fine for a single instance. Most-recently-used
 * on `get`/`set`; when over a bound, evicts least-recently-used entries (or skips a
 * `set` whose entry alone exceeds `maxEntryBytes`).
 */
export function memoryCache(opts: MemoryCacheOptions = {}): CacheStore {
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  const maxEntryBytes = opts.maxEntryBytes ?? DEFAULT_MAX_ENTRY_BYTES;
  const maxEntries = opts.maxEntries ?? DEFAULT_MAX_ENTRIES;
  // Map preserves insertion order → front = least-recently-used; re-insert to mark MRU.
  const entries = new Map<string, CacheEntry>();
  let totalBytes = 0;

  const drop = (key: string): void => {
    const e = entries.get(key);
    if (e) {
      totalBytes -= e.bytes;
      entries.delete(key);
    }
  };
  const evictLRU = (): void => {
    // oldest-first until back within both bounds
    for (const key of entries.keys()) {
      if (totalBytes <= maxBytes && entries.size <= maxEntries) {break;}
      drop(key);
    }
  };

  return {
    get(key) {
      const e = entries.get(key);
      if (!e) {return undefined;}
      entries.delete(key); // re-insert at the back → most-recently-used
      entries.set(key, e);
      return e;
    },
    set(key, entry) {
      drop(key); // replace any prior value for this key
      if (entry.bytes > maxEntryBytes) {return;} // too large to cache at all
      entries.set(key, entry);
      totalBytes += entry.bytes;
      evictLRU();
    },
    delete(key) {
      const existed = entries.has(key);
      drop(key);
      return existed;
    },
    clear() {
      entries.clear();
      totalBytes = 0;
    },
    invalidate(pred) {
      let removed = 0;
      for (const e of [...entries.values()]) {
        if (pred(e)) {
          drop(e.key);
          removed++;
        }
      }
      return removed;
    },
  };
}

/** The parts a default cache key is built from. */
export interface CacheKeyParts {
  /** The request method (upper-cased). */
  readonly method: string;
  /** The request path. */
  readonly path: string;
  /** The query string (raw, e.g. `io` URL search) or parsed entries — normalized by sorting. */
  readonly query?: string | URLSearchParams | Iterable<readonly [string, string]>;
  /** The request body (parsed JSON / form object) or ws call args — included so POST-style caches key on the payload. */
  readonly body?: Json;
  /** An optional extra discriminator (e.g. the authenticated user id) appended verbatim. */
  readonly vary?: Json;
}

/** Normalize a query input into a stable, order-independent list of `[k, v]` pairs. */
function normalizeQuery(query: CacheKeyParts['query']): [string, string][] {
  if (query === undefined) {return [];}
  const params =
    typeof query === 'string'
      ? new URLSearchParams(query)
      : query instanceof URLSearchParams
        ? query
        : new URLSearchParams([...query].map(([k, v]) => [k, v] as [string, string]));
  return [...params].sort((a, b) => (a[0] === b[0] ? (a[1] < b[1] ? -1 : 1) : a[0] < b[0] ? -1 : 1));
}

/** Recursively sort object keys so semantically-equal values serialize identically. */
function sortDeep(v: unknown): unknown {
  if (Array.isArray(v)) {return v.map(sortDeep);}
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as Record<string, unknown>).sort()) {out[k] = sortDeep((v as Record<string, unknown>)[k]);}
    return out;
  }
  return v;
}

/** Deterministic `JSON.stringify` — object keys sorted at every depth, so key order never matters. */
export function stableStringify(value: unknown): string {
  return JSON.stringify(sortDeep(value)) ?? 'null';
}

/**
 * Build a stable cache key from request parts — the same string the middleware uses.
 * Query parameters are sorted and the body is canonicalized (sorted keys at every depth),
 * so equal requests share a key regardless of property order. Exported so you can target
 * {@link CacheStore.delete} after a mutation (e.g. bust a user's cached report).
 */
export function cacheKey(parts: CacheKeyParts): string {
  return stableStringify([parts.method.toUpperCase(), parts.path, normalizeQuery(parts.query), parts.body ?? null, parts.vary ?? null]);
}

/**
 * A fast, **non-cryptographic** hash (cyrb53 → base36) for shrinking a large cache key —
 * pass it as the `hash` option so the store keys on a short digest instead of the full
 * (possibly huge) JSON. Collisions are unlikely but possible; keep `checkKey` on (the
 * default when hashing) to fall through on one, or supply a crypto hash (e.g. sha-256)
 * for stronger guarantees.
 */
export function hashKey(key: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < key.length; i++) {
    const ch = key.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  const n = 4294967296 * (2097151 & h2) + (h1 >>> 0);
  return n.toString(36);
}

/**
 * Compute the informational cache headers for an entry: `Age` (seconds since it was
 * stored) and `Cache-Control: max-age` (seconds of freshness remaining). The middleware
 * adds the `X-Cache: HIT|STALE|MISS` marker separately.
 */
export function cacheHeaders(entry: CacheEntry, now: number): Record<string, string> {
  const age = Math.max(0, Math.floor((now - entry.storedAt) / MS_PER_SECOND));
  const maxAge = Math.max(0, Math.ceil((entry.expires - now) / MS_PER_SECOND));
  return { age: String(age), 'cache-control': `max-age=${maxAge}` };
}

/** The shape core produces for a multi-status (`responses:`) endpoint — `{ status, data }`. */
function looksMultiStatus(r: object): boolean {
  const keys = Object.keys(r);
  return keys.length === 2 && keys.includes('status') && keys.includes('data') && typeof (r as { status: unknown }).status === 'number';
}

/**
 * Whether a handler's result is a plain JSON response body the cache can store and
 * replay. `false` for an empty body (`null`/`undefined` → 204), a short-circuit
 * `Response`, a function, a streamed body (async-iterable / `ReadableStream`), or a
 * multi-status `{ status, data }` wrapper (whose replay status would be wrong). Useful in
 * a custom `shouldCache` or a custom {@link CacheStore}.
 */
export function isCacheableResult(result: unknown): boolean {
  if (result === null || result === undefined) {return false;} // 204 / empty
  if (result instanceof Response) {return false;} // a downstream short-circuit (e.g. a 4xx)
  if (typeof result === 'function') {return false;}
  if (typeof result === 'object') {
    const o = result as { [Symbol.asyncIterator]?: unknown; getReader?: unknown };
    if (typeof o[Symbol.asyncIterator] === 'function' || typeof o.getReader === 'function') {return false;} // a stream
    if (looksMultiStatus(result)) {return false;} // multi-status wrapper — replay would be wrong
  }
  return true;
}

/**
 * The handle a cached endpoint's handler reads as `io.ctx.cache` — present only on a
 * **miss** (a hit never runs the handler). Use it to opt this response out of caching
 * ({@link CacheControl.noStore}) or override its lifetime ({@link CacheControl.ttl}).
 */
export interface CacheControl {
  /** The cache key computed for this request. */
  readonly key: string;
  /** Always `false` here — the handler only runs when the cache missed. */
  readonly hit: boolean;
  /** Do not store this response (e.g. it depends on something the key doesn't capture). */
  noStore(): void;
  /** Override the freshness lifetime for this response (ms). */
  ttl(ms: number): void;
}

/**
 * Options for the {@link cache} **def** — frontend-safe only.
 *
 * @typeParam R - middleware this one depends on (their context is typed in the
 *   server-side `key`/`vary`/`skip`/`shouldCache`).
 */
export interface CacheDefOptions<R extends readonly AnyMiddleware[]> {
  /** Middleware this one depends on — their context is available (and typed) in `key`/`vary`/`skip`. */
  readonly requires?: R;
  /** Middleware name for docs/debugging (default `'cache'`). */
  readonly name?: string;
}

/**
 * Create a response-caching middleware **def**. The def declares what the middleware
 * contributes (`{ cache: CacheControl }`) but **no** policy. Bind the
 * ttl/vary/bounds with [`cache.server(def, { ttl })`](./server).
 *
 * @typeParam R - inferred from `requires`; their context types flow into the
 *   server-side `key`/`vary`/`skip`/`shouldCache`.
 */
export function cache<const R extends readonly AnyMiddleware[] = readonly []>(opts?: CacheDefOptions<R>): CacheDef<R> {
  const name = opts?.name ?? DEFAULT_NAME;
  return middleware(name, { provides: ctx<{ cache: CacheControl }>(), requires: (opts?.requires ?? []) as R });
}

/** The def type a {@link cache} call produces — what `cache.server` binds against. */
export type CacheDef<R extends readonly AnyMiddleware[] = readonly []> = MiddlewareDef<{ cache: CacheControl }, R>;
