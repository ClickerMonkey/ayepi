/**
 * # @ayepi/cache/server — cache **impl** binder
 *
 * The server half of `@ayepi/cache`: it binds a frontend-safe {@link cache} def to its
 * policy — the key derivation (`vary`/`key`), lifetime (`ttl`/`staleWhileRevalidate`),
 * store + bounds, and which responses to cache. (Caching has no `node:*` deps, so this
 * split is for API symmetry with the other middleware and to keep the policy out of a
 * frontend-importable spec.)
 *
 * ```ts
 * import { cache } from '@ayepi/cache/server';
 * implement(api).middleware(cache.server(cached, {
 *   ttl: 30_000,
 *   vary: (io) => io.ctx.user.id,
 * }));
 * ```
 *
 * Place `cache` **last** in a chain (closest to the handler) so upstream middleware
 * (`auth`, `rateLimit`, telemetry) still run on a hit and `vary` can read their context.
 *
 * @module
 */

import type { AnyMiddleware, BoundMiddleware, ImplFor, MiddlewareIO, StackCtx, Json, RouteInfo } from '@ayepi/core';
import { cache as cacheDef, memoryCache, cacheKey, cacheHeaders, isCacheableResult, stableStringify } from './index';
import type { CacheStore, CacheControl, CacheEntry } from './index';

/** The `requires` chain of a middleware def. */
type ReqOf<M extends AnyMiddleware> = M['__req'];

/** The argument passed to `key`/`vary`/`skip`/`shouldCache` — the request plus accumulated context. */
export interface CacheIO<Ctx extends object> {
  readonly req: Request;
  readonly ctx: Ctx;
}

/** The default methods whose responses are cached. */
const DEFAULT_METHODS = ['GET'] as const;
/** Replayed responses are served as JSON. */
const JSON_CONTENT_TYPE = 'application/json';

/**
 * Server-side options for binding a {@link cache} def — the caching policy, with
 * `key`/`vary`/`skip`/`shouldCache` typed against the def's `requires` context. Extends
 * {@link MemoryCacheOptions}, whose bounds configure the default {@link memoryCache} when
 * no `store` is supplied.
 *
 * @typeParam M - the cache def being bound.
 */
export interface CacheServerOptions<M extends AnyMiddleware> {
  /** Freshness lifetime in milliseconds — a cached response is a `HIT` until it expires. */
  readonly ttl: number;
  /** Extra grace (ms) after `ttl` during which a stale entry is served immediately while it refreshes in the background. */
  readonly staleWhileRevalidate?: number;
  /** Which endpoint methods to cache (default `['GET']`) — keyed off the endpoint's declared method, so it governs HTTP and ws alike. */
  readonly methods?: readonly string[];
  /** An extra discriminator appended to the key (e.g. `io.ctx.user.id`) — for per-user/per-tenant caches. */
  readonly vary?: (io: CacheIO<StackCtx<ReqOf<M>>>) => Json;
  /** Replace the whole key derivation (default `method + path + query + body + vary`). Returns any JSON value. */
  readonly key?: (io: CacheIO<StackCtx<ReqOf<M>>>) => Json;
  /**
   * Shrink the (possibly large) key to a store key — e.g. `hash: hashKey` or a crypto
   * digest. Default: the full key is the store key. When set, {@link checkKey} defaults on.
   */
  readonly hash?: (fullKey: string) => string;
  /**
   * Store the full key in the entry and verify it on a hit, so a {@link hash} collision
   * falls through to a miss instead of serving the wrong body. Defaults to `true` when
   * `hash` is set; set `false` to drop the full key (leaner memory, accepts collision risk).
   */
  readonly checkKey?: boolean;
  /** Backend store (default an in-process {@link memoryCache} built from the bounds below). */
  readonly store?: CacheStore;
  /** Total cache capacity in bytes for the default store (default 64 MiB). */
  readonly maxBytes?: number;
  /** Per-response cap in bytes for the default store (default 1 MiB) — larger responses aren't cached. */
  readonly maxEntryBytes?: number;
  /** Entry-count cap for the default store (default 10 000). */
  readonly maxEntries?: number;
  /** Decide per-response whether to cache it (runs on a miss, after the handler). */
  readonly shouldCache?: (io: CacheIO<StackCtx<ReqOf<M>>>, result: unknown) => boolean;
  /** Emit `X-Cache` / `Age` / `Cache-Control` response headers (default `true`). */
  readonly headers?: boolean;
  /** Bypass the cache for some requests (neither read nor write). */
  readonly skip?: (io: CacheIO<StackCtx<ReqOf<M>>>) => boolean;
  /**
   * Observe an error the cache **swallowed** to stay fail-open — to log it, count a metric,
   * etc. Not called by default (errors are silent). `phase` is where it happened: `'read'`
   * (key/lookup → request served uncached), `'write'` (storing the result), or `'revalidate'`
   * (a background stale refresh). It must not throw; if it does, the throw is ignored.
   */
  readonly onError?: (err: unknown, phase: 'read' | 'write' | 'revalidate') => void;
  /** Clock injection (default `Date.now`) — for tests. */
  readonly now?: () => number;
}

/** Internal mutable backing of the {@link CacheControl} handed to handlers. */
interface MutableControl extends CacheControl {
  store: boolean;
  ttlOverride?: number;
}

/** Parse the request `Cache-Control` directives we honor. */
function parseCacheControl(header: string | null): { noStore: boolean; noCache: boolean } {
  if (!header) {return { noStore: false, noCache: false };}
  const directives = header.toLowerCase().split(',').map((d) => d.trim());
  return { noStore: directives.includes('no-store'), noCache: directives.includes('no-cache') };
}

/** Bind a {@link cache} def to its runtime policy. */
function cacheServer<M extends AnyMiddleware>(def: M, opts: CacheServerOptions<M>): BoundMiddleware<M> {
  const store = opts.store ?? memoryCache(opts);
  const ttl = opts.ttl;
  const swr = opts.staleWhileRevalidate ?? 0;
  const methods = new Set((opts.methods ?? DEFAULT_METHODS).map((m) => m.toUpperCase()));
  const emitHeaders = opts.headers !== false;
  const now = opts.now ?? Date.now;
  const checkKey = opts.checkKey ?? opts.hash !== undefined; // verify the full key on a hit when hashing
  const inflight = new Set<string>(); // single-flight guard for stale-while-revalidate refreshes

  /** Hand a swallowed error to `onError` (best-effort — a throwing handler is itself ignored). */
  const reportError = (err: unknown, phase: 'read' | 'write' | 'revalidate'): void => {
    try {
      opts.onError?.(err, phase);
    } catch {
      /* error reporting must never break the request */
    }
  };

  type Ctx = StackCtx<ReqOf<M>>;
  type Io = MiddlewareIO<Ctx>;
  type EndpointRoute = Extract<RouteInfo, { readonly kind: 'endpoint' }>;

  const makeControl = (key: string): MutableControl => ({
    key,
    hit: false,
    store: true,
    noStore() {
      this.store = false;
    },
    ttl(ms: number) {
      this.ttlOverride = ms;
    },
  });

  /** The full (pre-hash) key — endpoint identity + the request's query/body (or ws args) + `vary`. */
  const keyOf = (io: Io, route: EndpointRoute): string => {
    const kio: CacheIO<Ctx> = { req: io.req, ctx: io.ctx };
    if (opts.key) {return stableStringify(opts.key(kio));}
    const vary = opts.vary?.(kio);
    if (io.transport === 'ws') {
      return cacheKey({ method: route.method, path: route.path, body: io.ws?.data as Json, vary }); // ws args carry everything
    }
    const url = new URL(io.req.url);
    return cacheKey({ method: route.method, path: route.path, query: url.searchParams, body: io.body as Json, vary });
  };

  const replay = (entry: CacheEntry, marker: string, at: number): Response => {
    const headers = new Headers(entry.headers as [string, string][]);
    if (emitHeaders) {
      headers.set('x-cache', marker);
      for (const [k, v] of Object.entries(cacheHeaders(entry, at))) {headers.set(k, v);}
    }
    return new Response(entry.body, { status: entry.status, headers });
  };

  /** Serialize + store a handler result, honoring the handler's `io.ctx.cache` opt-out and the store's bounds. */
  const persist = async (io: Io, storeKey: string, fullKey: string, control: MutableControl, result: unknown, route: EndpointRoute): Promise<void> => {
    if (!control.store) {return;} // handler called io.ctx.cache.noStore()
    if (!isCacheableResult(result)) {return;}
    if (opts.shouldCache && !opts.shouldCache({ req: io.req, ctx: io.ctx }, result)) {return;}
    const body = JSON.stringify(result);
    const bytes = new TextEncoder().encode(body).length;
    const at = now();
    const expires = at + (control.ttlOverride ?? ttl);
    const entry: CacheEntry = {
      body,
      status: 200,
      headers: [['content-type', JSON_CONTENT_TYPE]],
      storedAt: at,
      expires,
      staleUntil: expires + swr,
      bytes,
      method: route.method,
      path: route.path,
      key: checkKey ? fullKey : storeKey, // keep the full key only when we'll verify it
    };
    await store.set(storeKey, entry);
  };

  /** Background refresh for a stale entry — single-flight per store key; failures leave the stale entry in place. */
  const revalidate = (io: Io, storeKey: string, fullKey: string, route: EndpointRoute): void => {
    if (inflight.has(storeKey)) {return;}
    inflight.add(storeKey);
    const control = makeControl(fullKey);
    void Promise.resolve(io.next({ cache: control }))
      .then((result) => persist(io, storeKey, fullKey, control, result, route))
      .catch((err: unknown) => reportError(err, 'revalidate')) // stale was already served; a failed refresh just retries next time
      .finally(() => inflight.delete(storeKey));
  };

  /** Outcome of the read phase: serve a cached response, run the handler then cache it, or bypass. */
  type Decision =
    | { readonly serve: Response }
    | { readonly proceed: true; readonly storeKey: string; readonly fullKey: string; readonly route: EndpointRoute; readonly control: MutableControl }
    | { readonly bypass: true };

  /** The read phase — key derivation + store lookup. Runs no handler, so any throw here is a pure cache failure. */
  const decide = async (io: Io): Promise<Decision> => {
    const kio: CacheIO<Ctx> = { req: io.req, ctx: io.ctx };
    const route = io.route;
    const cc = parseCacheControl(io.req.headers.get('cache-control'));
    // multipart is the only path carrying file uploads (and it's always HTTP) — never cache it
    const multipart = io.transport === 'http' && (io.req.headers.get('content-type') ?? '').toLowerCase().includes('multipart/form-data');
    if (route.kind !== 'endpoint' || !methods.has(route.method) || opts.skip?.(kio) || cc.noStore || multipart) {
      return { bypass: true };
    }
    const fullKey = keyOf(io, route);
    const storeKey = opts.hash ? opts.hash(fullKey) : fullKey;
    const control = makeControl(fullKey);
    if (!cc.noCache) {
      const entry = await store.get(storeKey);
      if (entry && (!checkKey || entry.key === fullKey)) {
        const at = now();
        if (at < entry.expires) {return { serve: replay(entry, 'HIT', at) };} // fresh
        if (at < entry.staleUntil) {
          revalidate(io, storeKey, fullKey, route); // serve stale now, refresh behind it
          return { serve: replay(entry, 'STALE', at) };
        }
        await store.delete(storeKey); // dead → drop and recompute below
      } else if (entry) {
        await store.delete(storeKey); // hash collision (different full key) → drop and recompute
      }
    }
    return { proceed: true, storeKey, fullKey, route, control };
  };

  const run = async (io: Io): Promise<unknown> => {
    // The cache is **best-effort**: if any cache bookkeeping throws (key derivation, the store,
    // a hash/serialize step), fall through to the handler as if uncached. The handler runs via
    // `io.next()` **outside** these try/catches, so its own errors always propagate to the client.
    let decision: Decision;
    try {
      decision = await decide(io);
    } catch (err) {
      reportError(err, 'read');
      return io.next({ cache: makeControl('') }); // read phase failed → serve uncached
    }
    if ('serve' in decision) {return decision.serve;}
    if ('bypass' in decision) {return io.next({ cache: makeControl('') });}

    const result = await io.next({ cache: decision.control }); // miss: handler errors propagate
    try {
      if (emitHeaders) {io.setHeader('x-cache', 'MISS');}
      await persist(io, decision.storeKey, decision.fullKey, decision.control, result, decision.route);
    } catch (err) {
      reportError(err, 'write'); // caching the result is best-effort; the response stands regardless
    }
    return result;
  };

  return { def, impl: run as unknown as ImplFor<M> }; // internal cast: the precise typed run presented as the def's bound impl
}

/**
 * The {@link cache} def factory, augmented with a `.server(def, opts)` binder. Import
 * from `@ayepi/cache/server` in your server entry to bind a def created in a
 * frontend-safe spec.
 */
export const cache = Object.assign(cacheDef, { server: cacheServer });
