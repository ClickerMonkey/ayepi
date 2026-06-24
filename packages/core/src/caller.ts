/**
 * # Caller — composable client-side call policy
 *
 * `sdk.caller(name, options)` wraps a raw {@link ApiClient.call} with stateful policy:
 * **caching** (TTL, tags, stale-while-revalidate, memory/local/session storage),
 * **debounce** (with optional accumulation), **rate limiting**, **last-response-only**,
 * **in-flight dedupe**, **retry**, and lifecycle **hooks**. Each policy is its own small
 * wrapper function (a {@link Layer}) that decorates the next, composed in a fixed order, so
 * state and logic for different features never tangle.
 *
 * Caches are **shared across the callers of one client**, so a mutating caller's tag
 * invalidation (e.g. `createUser` ⇒ `invalidates: ['users']`) clears the cached reads of
 * other callers (`listUsers`).
 *
 * @module
 */

import type { AnyEndpoint } from './endpoint';
import type { CallArgs, CallReturn, ClientData } from './payload';

/* ============================================================================
 * Stable keys
 * ========================================================================== */

const sortDeep = (v: unknown): unknown => {
  if (Array.isArray(v)) {return v.map(sortDeep);}
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(v as Record<string, unknown>).sort()) {out[key] = sortDeep((v as Record<string, unknown>)[key]);}
    return out;
  }
  return v;
};
/** Deterministic JSON (sorted keys) — the default cache key for a call's `data`. */
export const stableStringify = (value: unknown): string => JSON.stringify(sortDeep(value)) ?? 'null';

/** Whether a value round-trips through JSON (only such results are cacheable — excludes `undefined`/functions). */
const isJsonSafe = (v: unknown): boolean => {
  try {
    return JSON.stringify(v) !== undefined;
  } catch {
    return false;
  }
};

/* ============================================================================
 * Client cache — tag-aware LRU over a pluggable sync KV store
 * ========================================================================== */

/** A synchronous key/value store backing a {@link ClientCache} (memory or a `Storage`). */
export interface KVStore {
  get(key: string): string | undefined;
  set(key: string, value: string): void;
  delete(key: string): boolean;
  keys(): Iterable<string>;
}

/** Where a cache persists: a built-in backend name or your own {@link KVStore}. */
export type CacheStoreSpec = 'memory' | 'session' | 'local' | KVStore;

/** Options for {@link createClientCache}. */
export interface ClientCacheOptions {
  /** Backend (default `'memory'`). `'local'`/`'session'` fall back to memory where `Storage` is unavailable (SSR). */
  readonly store?: CacheStoreSpec;
  /** Max entries before LRU eviction (default 500). */
  readonly max?: number;
  /** Default time-to-live in ms (per-`set` `ttl` overrides; omitted ⇒ no expiry). */
  readonly ttl?: number;
  /** Key namespace for a `Storage` backend (default `'ayepi:cache:'`). */
  readonly prefix?: string;
  /** Clock injection (tests). */
  readonly now?: () => number;
}

/** A stored cache entry (serialized in the backend). */
interface Entry {
  /** The cached value. */
  readonly v: unknown;
  /** Absolute expiry (epoch ms), or `0` for none. */
  readonly exp: number;
  /** Absolute end of the stale-while-revalidate window (epoch ms), or `0`. */
  readonly stale: number;
  /** Tags for group invalidation. */
  readonly tags: readonly string[];
}

/** What a {@link ClientCache.read} returns: the value plus whether it is fresh or stale (SWR). */
export interface CacheHit {
  readonly value: unknown;
  /** `true` when past `ttl` but within the stale-while-revalidate window. */
  readonly stale: boolean;
}

/** A tag-aware LRU cache shared by a client's callers. */
export interface ClientCache {
  /** Read a key — `undefined` when missing or fully expired (past the stale window). */
  read(key: string): CacheHit | undefined;
  /** Cache a JSON-serializable value (no-op for non-serializable values). */
  write(key: string, value: unknown, opts?: { ttl?: number; staleWhileRevalidate?: number; tags?: readonly string[] }): void;
  /** Remove one key. */
  remove(key: string): void;
  /** Remove every key matching `pred` (e.g. a caller's prefix). Returns the count removed. */
  removeWhere(pred: (key: string) => boolean): number;
  /** Remove every entry carrying any of `tags`. Returns the count removed. */
  invalidateTags(tags: readonly string[]): number;
  /** Drop everything. */
  clear(): void;
}

/** A `Storage`-backed {@link KVStore} (localStorage/sessionStorage), namespaced by `prefix`. */
const storageKV = (storage: Storage, prefix: string): KVStore => ({
  get: (key) => storage.getItem(prefix + key) ?? undefined,
  set: (key, value) => storage.setItem(prefix + key, value),
  delete: (key) => {
    const full = prefix + key;
    const had = storage.getItem(full) !== null;
    storage.removeItem(full);
    return had;
  },
  keys: function* () {
    for (let i = 0; i < storage.length; i++) {
      const k = storage.key(i);
      if (k !== null && k.startsWith(prefix)) {yield k.slice(prefix.length);}
    }
  },
});

/** Resolve a {@link CacheStoreSpec} to a concrete {@link KVStore}, falling back to memory (SSR-safe). */
const resolveStore = (spec: CacheStoreSpec, prefix: string): KVStore => {
  if (typeof spec === 'object') {return spec;}
  if (spec !== 'memory') {
    try {
      const storage = spec === 'local' ? globalThis.localStorage : globalThis.sessionStorage;
      if (storage) {return storageKV(storage, prefix);}
    } catch {
      /* access can throw (privacy mode, SSR) — fall back to memory */
    }
  }
  const map = new Map<string, string>();
  return { get: (k) => map.get(k), set: (k, v) => void map.set(k, v), delete: (k) => map.delete(k), keys: () => map.keys() };
};

/** Create a tag-aware LRU cache over the chosen backend. */
export function createClientCache(opts: ClientCacheOptions = {}): ClientCache {
  const max = opts.max ?? 500;
  const defaultTtl = opts.ttl ?? 0;
  const now = opts.now ?? Date.now;
  const kv = resolveStore(opts.store ?? 'memory', opts.prefix ?? 'ayepi:cache:');

  // in-memory LRU order (most-recent last); rebuilt lazily from the backend's existing keys
  const order = new Map<string, true>();
  for (const k of kv.keys()) {order.set(k, true);}
  const touch = (key: string): void => {
    order.delete(key);
    order.set(key, true);
  };
  const parse = (key: string): Entry | undefined => {
    const raw = kv.get(key);
    if (raw === undefined) {return undefined;}
    try {
      return JSON.parse(raw) as Entry;
    } catch {
      kv.delete(key);
      return undefined;
    }
  };
  const drop = (key: string): boolean => {
    order.delete(key);
    return kv.delete(key);
  };
  const evict = (): void => {
    while (order.size > max) {drop(order.keys().next().value as string);} // size > max ⇒ at least one key exists
  };

  return {
    read: (key) => {
      const e = parse(key);
      if (!e) {return undefined;}
      const t = now();
      if (e.exp && t >= e.exp) {
        if (!e.stale || t >= e.stale) {
          drop(key); // past the stale window too → gone
          return undefined;
        }
        touch(key);
        return { value: e.v, stale: true }; // serve stale; caller may revalidate
      }
      touch(key);
      return { value: e.v, stale: false };
    },
    write: (key, value, o) => {
      if (!isJsonSafe(value)) {return;} // only cache JSON-serializable results
      const ttl = o?.ttl ?? defaultTtl;
      const exp = ttl > 0 ? now() + ttl : 0;
      const stale = exp && o?.staleWhileRevalidate ? exp + o.staleWhileRevalidate : 0;
      const entry: Entry = { v: value, exp, stale, tags: o?.tags ?? [] };
      kv.set(key, JSON.stringify(entry));
      touch(key);
      evict();
    },
    remove: (key) => void drop(key),
    removeWhere: (pred) => {
      let n = 0;
      for (const key of [...kv.keys()]) {
        if (pred(key) && drop(key)) {n += 1;}
      }
      return n;
    },
    invalidateTags: (tags) => {
      if (tags.length === 0) {return 0;}
      const want = new Set(tags);
      let n = 0;
      for (const key of [...kv.keys()]) {
        const e = parse(key);
        if (e && e.tags.some((tag) => want.has(tag)) && drop(key)) {n += 1;}
      }
      return n;
    },
    clear: () => {
      for (const key of [...kv.keys()]) {kv.delete(key);}
      order.clear();
    },
  };
}

/* ============================================================================
 * Caller context — per-client registry of caches (one per store), so tag
 * invalidation reaches every caller's cache regardless of backend.
 * ========================================================================== */

/** Shared per-client caller state: a cache per distinct store, with cross-store tag invalidation. */
export interface CallerContext {
  /** The cache for a store spec (memoized; the default store when omitted). */
  cacheFor(store: CacheStoreSpec | undefined): ClientCache;
  /** Invalidate `tags` across **every** cache this client has created. */
  invalidateTags(tags: readonly string[]): void;
}

/** Create the shared caller context. `defaults` seed each store's cache (`max`/`ttl`/`store`). */
export function createCallerContext(defaults: ClientCacheOptions = {}): CallerContext {
  const caches = new Map<CacheStoreSpec, ClientCache>();
  const cacheFor = (store: CacheStoreSpec | undefined): ClientCache => {
    const spec = store ?? defaults.store ?? 'memory';
    let c = caches.get(spec);
    if (!c) {
      c = createClientCache({ ...defaults, store: spec });
      caches.set(spec, c);
    }
    return c;
  };
  return {
    cacheFor,
    invalidateTags: (tags) => {
      cacheFor(undefined); // ensure the default cache exists so a lone invalidator still works
      for (const c of caches.values()) {c.invalidateTags(tags);}
    },
  };
}

/* ============================================================================
 * Public caller types
 * ========================================================================== */

/** Tags for a caller — a static list, or derived from the call's data (+ result, for invalidation). */
export type Tagger<E extends AnyEndpoint> = readonly string[] | ((data: ClientData<E>, result: unknown) => readonly string[]);

/** Per-caller caching config (or `true` for defaults). */
export interface CallerCacheConfig<E extends AnyEndpoint> {
  /** Entry time-to-live (ms); omitted ⇒ the client cache default (often no expiry). */
  readonly ttl?: number;
  /** Extra ms after `ttl` during which a stale value is served while it refetches in the background. */
  readonly staleWhileRevalidate?: number;
  /** Derive the cache key from the call's data (default: stable JSON of the data). */
  readonly key?: (data: ClientData<E>) => string;
  /** Tags attached to this caller's cached entries (for group invalidation). */
  readonly tags?: Tagger<E>;
  /** Which client cache to use (default the client's shared memory cache). */
  readonly store?: CacheStoreSpec;
}

/** Per-caller debounce config (or a plain `wait` in ms). */
export interface CallerDebounceConfig<E extends AnyEndpoint> {
  /** Quiet period before the trailing call fires (ms). */
  readonly wait: number;
  /** Force a call after at most this long since the first queued call (ms). */
  readonly maxWait?: number;
  /** Also fire immediately on the leading edge of a burst. */
  readonly leading?: boolean;
  /** Merge the data of every debounced call into one call's data. */
  readonly accumulate?: (dataList: ClientData<E>[]) => ClientData<E>;
  /** Fan the single accumulated result back to each queued caller (default: all get the same result). */
  readonly spread?: (result: unknown, dataList: ClientData<E>[]) => unknown[];
}

/** Per-caller rate-limit config (token bucket). */
export interface CallerRateLimitConfig {
  /** Bucket capacity (max calls per window). */
  readonly limit: number;
  /** Window/refill period (ms). */
  readonly window: number;
  /** Over budget: `'wait'` for a token (default), `'drop'` (reject), or `'throw'`. */
  readonly onLimit?: 'wait' | 'drop' | 'throw';
}

/** Per-caller retry config — a lightweight exponential backoff (a client-side subset of `@ayepi/core`'s retry). */
export interface CallerRetryConfig {
  /** Total tries including the first (default 3). */
  readonly attempts?: number;
  /** First backoff delay in ms (default 200). */
  readonly base?: number;
  /** Backoff growth multiplier (default 2). */
  readonly factor?: number;
  /** Maximum backoff delay in ms (default 30000). */
  readonly max?: number;
  /** Randomization fraction `0..1` subtracted from each delay (default 0.5). */
  readonly jitter?: number;
}

/** Options for {@link ApiClient.caller}. Each enabled feature is applied as its own wrapper layer. */
export interface CallerOptions<E extends AnyEndpoint> {
  /** Cache responses keyed by the call's data (TTL, tags, stale-while-revalidate, store). */
  readonly cache?: boolean | CallerCacheConfig<E>;
  /** Debounce rapid calls (with optional accumulation into one call). */
  readonly debounce?: number | CallerDebounceConfig<E>;
  /** Token-bucket rate limit. */
  readonly rateLimit?: CallerRateLimitConfig;
  /** Retry a failed call with exponential backoff ({@link CallerRetryConfig}). */
  readonly retry?: CallerRetryConfig;
  /** Only deliver the most recent call's response — supersede (abort) older in-flight calls. */
  readonly lastOnly?: boolean;
  /** Coalesce concurrent identical calls into one in-flight request. */
  readonly dedupe?: boolean;
  /** Tags this caller invalidates (clearing matching entries in **other** callers' caches). */
  readonly invalidates?: Tagger<E>;
  /** When to invalidate (`'success'` default). */
  readonly invalidateOn?: 'success' | 'start' | 'both';
  /** Fired when a call is admitted (before any wait). */
  readonly onStart?: (data: ClientData<E>) => void;
  /** Fired when a call resolves. */
  readonly onSuccess?: (result: unknown, data: ClientData<E>) => void;
  /** Fired when a call rejects. */
  readonly onError?: (error: unknown, data: ClientData<E>) => void;
  /** Fired when a call settles (either way). */
  readonly onSettled?: (data: ClientData<E>) => void;
}

/** A configured caller for one endpoint — `call` applies the policy; plus control + status. */
export interface Caller<E extends AnyEndpoint> {
  /** Invoke the endpoint through the policy layers (same arguments as `client.call`). */
  call(...args: CallArgs<E>): CallReturn<E>;
  /** Abort in-flight calls and drop any pending debounced calls. */
  cancel(): void;
  /** Clear this caller's own cached entries. */
  invalidate(): void;
  /** How many calls are currently in flight (awaiting a result, including debounce waits). */
  readonly pending: number;
}

/** Rejected when a rate-limited caller is over budget with `onLimit: 'drop'`/`'throw'`. */
export class CallerRateLimited extends Error {
  constructor(message = 'caller rate limit exceeded') {
    super(message);
    this.name = 'CallerRateLimited';
  }
}

/* ============================================================================
 * Internals — the layer pipeline
 * ========================================================================== */

const KEY_SEP = ' ';
const abortError = (reason: string): DOMException => new DOMException(reason, 'AbortError');

/** A signal that aborts when any input signal aborts (a portable `AbortSignal.any`). */
const anySignal = (signals: ReadonlyArray<AbortSignal | undefined>): AbortSignal => {
  const real = signals.filter((s): s is AbortSignal => s !== undefined);
  if (real.length === 1) {return real[0]!;} // the common case (no user signal → just the caller's)
  const ctrl = new AbortController(); // 0 inputs ⇒ a never-aborting signal; 2+ ⇒ aborts when any does
  const onAbort = (): void => {
    ctrl.abort();
    for (const s of real) {s.removeEventListener('abort', onAbort);}
  };
  for (const s of real) {
    if (s.aborted) {
      ctrl.abort();
      return ctrl.signal;
    }
    s.addEventListener('abort', onAbort, { once: true });
  }
  return ctrl.signal;
};

/** Sleep `ms`, rejecting early if `signal` aborts. */
const sleep = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(abortError('aborted'));
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(abortError('aborted'));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });

/** A normalized call: the merged `data` and the per-call `opts` bag. */
interface Call {
  readonly data: unknown;
  readonly opts: Record<string, unknown> | undefined;
}
type Invoke = (call: Call, signal: AbortSignal) => Promise<unknown>;
type Layer = (next: Invoke) => Invoke;
const compose = (base: Invoke, layers: readonly Layer[]): Invoke => layers.reduceRight((next, layer) => layer(next), base);

const resolveTags = (tagger: Tagger<AnyEndpoint> | undefined, data: unknown, result: unknown): readonly string[] =>
  tagger === undefined ? [] : typeof tagger === 'function' ? tagger(data as never, result) : tagger;

/* ---- layers (each owns its own state) ---- */

const withHooks = (o: CallerOptions<AnyEndpoint>, pending: { n: number }): Layer => (next) => async (call, signal) => {
  pending.n += 1;
  o.onStart?.(call.data as never);
  try {
    const r = await next(call, signal);
    o.onSuccess?.(r, call.data as never);
    return r;
  } catch (err) {
    o.onError?.(err, call.data as never);
    throw err;
  } finally {
    pending.n -= 1;
    o.onSettled?.(call.data as never);
  }
};

const withInvalidate = (tagger: Tagger<AnyEndpoint>, when: 'success' | 'start' | 'both', ctx: CallerContext): Layer => (next) => async (call, signal) => {
  if (when !== 'success') {ctx.invalidateTags(resolveTags(tagger, call.data, undefined));}
  const r = await next(call, signal);
  if (when !== 'start') {ctx.invalidateTags(resolveTags(tagger, call.data, r));}
  return r;
};

const withCache = (cfg: CallerCacheConfig<AnyEndpoint>, cache: ClientCache, keyOf: (data: unknown) => string): Layer => (next) => async (call, signal) => {
  const key = keyOf(call.data);
  const store = (result: unknown): void => cache.write(key, result, { ttl: cfg.ttl, staleWhileRevalidate: cfg.staleWhileRevalidate, tags: resolveTags(cfg.tags, call.data, result) });
  const hit = cache.read(key);
  if (hit && !hit.stale) {return hit.value;}
  if (hit && hit.stale) {
    void next(call, signal).then(store).catch(() => {}); // SWR: refresh in the background
    return hit.value;
  }
  const r = await next(call, signal);
  store(r);
  return r;
};

const withDedupe = (keyOf: (data: unknown) => string): Layer => {
  const inflight = new Map<string, Promise<unknown>>();
  return (next) => (call, signal) => {
    const key = keyOf(call.data);
    const existing = inflight.get(key);
    if (existing) {return existing;}
    const p = next(call, signal).finally(() => inflight.delete(key));
    inflight.set(key, p);
    return p;
  };
};

const withLastOnly = (): Layer => {
  let current: AbortController | null = null;
  return (next) => (call, signal) => {
    current?.abort(abortError('superseded'));
    const ctrl = new AbortController();
    current = ctrl;
    const linked = anySignal([signal, ctrl.signal]);
    // reject a superseded call as soon as it's aborted, regardless of whether the underlying request honors the signal
    return new Promise<unknown>((resolve, reject) => {
      linked.addEventListener('abort', () => reject(abortError('superseded')), { once: true });
      next(call, linked).then(resolve, reject);
    }).finally(() => {
      if (current === ctrl) {current = null;}
    });
  };
};

const withRateLimit = (cfg: CallerRateLimitConfig): Layer => {
  const onLimit = cfg.onLimit ?? 'wait';
  const perToken = cfg.window / cfg.limit;
  let tokens = cfg.limit;
  let last = Date.now();
  const refill = (): void => {
    const t = Date.now();
    const add = ((t - last) / cfg.window) * cfg.limit;
    if (add > 0) {
      tokens = Math.min(cfg.limit, tokens + add);
      last = t;
    }
  };
  return (next) => async (call, signal) => {
    refill();
    if (tokens < 1) {
      if (onLimit === 'throw' || onLimit === 'drop') {throw new CallerRateLimited();}
      await sleep((1 - tokens) * perToken, signal);
      refill();
    }
    tokens -= 1;
    return next(call, signal);
  };
};

const withRetry = (cfg: CallerRetryConfig): Layer => {
  const attempts = cfg.attempts ?? 3;
  const base = cfg.base ?? 200;
  const factor = cfg.factor ?? 2;
  const max = cfg.max ?? 30_000;
  const jitter = cfg.jitter ?? 0.5;
  return (next) => async (call, signal) => {
    let lastErr: unknown;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        return await next(call, signal);
      } catch (err) {
        lastErr = err;
        if (attempt >= attempts) {break;}
        const backoff = Math.min(max, base * factor ** (attempt - 1));
        await sleep(backoff * (1 - jitter * Math.random()), signal); // throws AbortError if aborted mid-backoff
      }
    }
    throw lastErr;
  };
};

interface Queued {
  readonly call: Call;
  readonly resolve: (v: unknown) => void;
  readonly reject: (e: unknown) => void;
}
const withDebounce = (cfg: CallerDebounceConfig<AnyEndpoint>, cancellers: Array<() => void>): Layer => {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let queue: Queued[] = [];
  let firstAt = 0;
  return (next) => {
    const fire = (signal: AbortSignal): void => {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      const batch = queue;
      queue = [];
      firstAt = 0;
      const dataList = batch.map((q) => q.call.data);
      const merged: Call = cfg.accumulate ? { data: cfg.accumulate(dataList as never), opts: batch[batch.length - 1]!.call.opts } : batch[batch.length - 1]!.call;
      next(merged, signal).then(
        (r) => {
          const results = cfg.spread ? cfg.spread(r, dataList as never) : null;
          batch.forEach((q, i) => q.resolve(results ? results[i] : r));
        },
        (e) => batch.forEach((q) => q.reject(e)),
      );
    };
    cancellers.push(() => {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      const batch = queue;
      queue = [];
      firstAt = 0;
      for (const q of batch) {q.reject(abortError('cancelled'));}
    });
    return (call, signal) =>
      new Promise<unknown>((resolve, reject) => {
        const now = Date.now();
        if (queue.length === 0) {firstAt = now;}
        queue.push({ call, resolve, reject });
        const lead = cfg.leading && timer === null && queue.length === 1;
        if (timer) {clearTimeout(timer);}
        const overdue = cfg.maxWait !== undefined && now - firstAt >= cfg.maxWait;
        if (lead || overdue) {
          fire(signal);
          return;
        }
        const delay = cfg.maxWait !== undefined ? Math.min(cfg.wait, firstAt + cfg.maxWait - now) : cfg.wait;
        timer = setTimeout(() => fire(signal), delay);
      });
  };
};

/* ---- assembly ---- */

/** Loose view of the manifest endpoint the caller needs (kept structural to avoid a hard import). */
export interface CallerEndpoint {
  readonly p: readonly unknown[];
  readonly q: readonly unknown[];
  readonly f: readonly unknown[];
  readonly hasBody: boolean;
  readonly streamIn: string | null;
  readonly streamOut: string | null;
  readonly items: boolean;
  readonly itemsIn: boolean;
}

/**
 * Build a {@link Caller} for one endpoint: normalize args → `{ data, opts }`, fold the enabled
 * policy layers around a base that calls `rawCall(data?, opts)`, and expose `cancel`/`invalidate`/
 * `pending`. Streaming endpoints bypass every layer (policies are for unary request/response calls).
 */
export function makeCaller(name: string, m: CallerEndpoint, rawCall: (...args: unknown[]) => unknown, ctx: CallerContext, options: CallerOptions<AnyEndpoint>): Caller<AnyEndpoint> {
  const streaming = m.items || m.itemsIn || m.streamIn !== null || m.streamOut !== null;
  if (streaming) {
    return { call: (...args) => rawCall(...args) as CallReturn<AnyEndpoint>, cancel: () => {}, invalidate: () => {}, pending: 0 };
  }

  const hasData = m.p.length > 0 || m.q.length > 0 || m.hasBody || m.f.length > 0;
  const cacheCfg: CallerCacheConfig<AnyEndpoint> = options.cache === true ? {} : options.cache === undefined || options.cache === false ? {} : options.cache;
  const dataKey = (data: unknown): string => (cacheCfg.key ? cacheCfg.key(data as never) : stableStringify(data));
  const namespaced = (data: unknown): string => `${name}${KEY_SEP}${dataKey(data)}`;
  const cache = options.cache ? ctx.cacheFor(cacheCfg.store) : null;

  const pending = { n: 0 };
  const cancellers: Array<() => void> = [];
  let callerCtrl = new AbortController();

  const base: Invoke = (call, signal) => {
    const opts = { ...(call.opts ?? {}), signal };
    return Promise.resolve(hasData ? rawCall(call.data, opts) : rawCall(opts));
  };

  const layers: Layer[] = [];
  if (options.onStart || options.onSuccess || options.onError || options.onSettled) {layers.push(withHooks(options, pending));}
  if (options.invalidates) {layers.push(withInvalidate(options.invalidates, options.invalidateOn ?? 'success', ctx));}
  if (cache) {layers.push(withCache(cacheCfg, cache, namespaced));}
  if (options.dedupe) {layers.push(withDedupe(namespaced));}
  if (options.lastOnly) {layers.push(withLastOnly());}
  if (options.debounce !== undefined) {
    const dc: CallerDebounceConfig<AnyEndpoint> = typeof options.debounce === 'number' ? { wait: options.debounce } : options.debounce;
    layers.push(withDebounce(dc, cancellers));
  }
  if (options.rateLimit) {layers.push(withRateLimit(options.rateLimit));}
  if (options.retry) {layers.push(withRetry(options.retry));}

  const invoke = compose(base, layers);

  const call = (...args: unknown[]): unknown => {
    const data = hasData ? args[0] : undefined;
    const opts = (hasData ? args[1] : args[0]) as Record<string, unknown> | undefined;
    const signal = anySignal([opts?.signal as AbortSignal | undefined, callerCtrl.signal]);
    return invoke({ data, opts }, signal);
  };

  return {
    call: call as Caller<AnyEndpoint>['call'],
    cancel: () => {
      callerCtrl.abort(abortError('cancelled'));
      callerCtrl = new AbortController();
      for (const c of cancellers) {c();}
    },
    invalidate: () => void cache?.removeWhere((key) => key.startsWith(`${name}${KEY_SEP}`)),
    get pending() {
      return pending.n;
    },
  };
}
