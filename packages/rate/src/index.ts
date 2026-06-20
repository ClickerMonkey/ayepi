/**
 * # @ayepi/rate
 *
 * Rate-limiting middleware for ayepi. {@link rateLimit} builds a middleware that
 * derives a **key from the request context** (e.g. the authenticated user, an IP,
 * an API token), checks it against a **store + algorithm**, and — when the limit
 * is exceeded — **short-circuits with a 429 `Response`** (which also maps to a ws
 * error frame). Successful requests expose `ratelimit` info in the handler
 * context.
 *
 * ```ts
 * // shared.ts (frontend-safe): the def declares what it contributes
 * import { rateLimit } from '@ayepi/rate'
 * const limit = rateLimit({ requires: [auth] })          // provides { ratelimit }
 * spec({ endpoints: { ...limit.group({ … }) } })
 *
 * // server.ts: bind the policy (key, limit, window, store)
 * import { rateLimit } from '@ayepi/rate/server'
 * implement(api).middleware(rateLimit.server(limit, {
 *   key: (io) => io.ctx.user.id,                          // io.ctx.user typed via `requires: [auth]`
 *   limit: 100,
 *   window: 60_000,
 *   algorithm: 'sliding-window',
 * }))
 * ```
 *
 * - **Pluggable store** — in-memory by default ({@link memoryStore}); pass a
 *   distributed store (see `@ayepi/rate/redis`) to limit across instances.
 * - **Algorithms** — `fixed-window`, `sliding-window`, `token-bucket`.
 * - **Customizable response** — status, message (text or JSON), and headers
 *   (draft `RateLimit-*` + `Retry-After` by default, or your own).
 *
 * @module
 */

import { middleware, ctx } from '@ayepi/core';
import type { AnyMiddleware, Json, MaybePromise } from '@ayepi/core';
import { unlimitedDoer, type Doer, type DoerTaskOptions } from '@ayepi/core/doer';

/* ---- tunable constants ---- */
/** Default over-limit HTTP status. */
const DEFAULT_STATUS = 429;
/** Default key namespace. */
const DEFAULT_PREFIX = 'rl:';
/** Default algorithm. */
const DEFAULT_ALGORITHM: Algorithm = 'fixed-window';
/** Tokens consumed per request (token-bucket). */
const TOKEN_COST = 1;
/** Milliseconds per second — `Retry-After` / `RateLimit-Reset` are expressed in seconds. */
const MS_PER_SECOND = 1000;
/** Amortized cleanup: sweep expired in-memory entries once every this many `consume` calls. */
const SWEEP_EVERY = 1000;
/** Drop an idle in-memory token bucket after this long with no activity (it refills to full anyway). */
const BUCKET_IDLE_MS = 10 * 60 * 1000;

/** The rate-limiting algorithm. */
export type Algorithm = 'fixed-window' | 'sliding-window' | 'token-bucket';

/** Limiter state for one key, exposed to handlers (via `ctx.ratelimit`) and response headers. */
export interface RateLimitInfo {
  /** The configured request limit for the window. */
  readonly limit: number;
  /** Requests (or tokens) remaining before the limit is hit. */
  readonly remaining: number;
  /** Milliseconds until the window/bucket resets. */
  readonly reset: number;
  /** Milliseconds to wait before retrying (0 when allowed). */
  readonly retryAfter: number;
}

/** A store's decision for one key. */
export interface RateLimitResult extends RateLimitInfo {
  /** Whether this request is within the limit. */
  readonly allowed: boolean;
}

/** The rule a store evaluates a key against. */
export interface RateLimitRule {
  readonly limit: number;
  readonly window: number;
  readonly algorithm: Algorithm;
  /**
   * Whether a request that is **itself rejected** (over the limit) still counts
   * against the limit. Default `false` — rejected requests are not recorded, so a
   * client cannot extend its own block by continuing to hammer the endpoint. Set
   * `true` for the stricter behavior where every attempt consumes budget.
   * (No effect on `token-bucket`, which never charges a request it can't admit.)
   */
  readonly countRejected?: boolean;
}

/**
 * Pluggable backend that atomically records a hit and decides the outcome.
 * Implementing the algorithm in the store keeps it correct across instances
 * (the in-memory store is single-process; `@ayepi/rate/redis` is distributed).
 */
export interface RateLimitStore {
  /** Record a hit for `key` under `rule` at time `now` (ms) and return the decision. */
  consume(key: string, rule: RateLimitRule, now: number): MaybePromise<RateLimitResult>;
  /** Clear all state for `key` (optional). */
  reset?(key: string): MaybePromise<void>;
}

/** The argument passed to `key`/`skip`/`message` — the request plus accumulated context. */
export interface RateKeyIO<Ctx extends object> {
  readonly req: Request;
  readonly ctx: Ctx;
}

/** Configuration for a standalone {@link limiter} — the base of {@link RateLimitOptions}. */
export interface LimiterOptions {
  /** Max requests (or token-bucket capacity) per window. */
  readonly limit: number;
  /** Window length in milliseconds (also the token refill period). */
  readonly window: number;
  /** Algorithm (default `'fixed-window'`). */
  readonly algorithm?: Algorithm;
  /** Backend store (default an in-process {@link memoryStore}). */
  readonly store?: RateLimitStore;
  /** Key prefix/namespace (default `'rl:'`). */
  readonly prefix?: string;
  /**
   * Count requests that are themselves rejected (over-limit) against the limit.
   * Default `false` — see {@link RateLimitRule.countRejected}.
   */
  readonly countRejected?: boolean;
}

/** Response customization shared by {@link rateLimitResponse} and {@link rateLimit}. */
export interface RateLimitResponseOptions {
  /** Over-limit status code (default `429`). */
  readonly status?: number;
  /** Over-limit body — a string, a JSON value, or a function of the limiter info. */
  readonly message?: string | Json | ((info: RateLimitInfo) => string | Json);
  /**
   * Response headers. `true` (default) emits draft `RateLimit-Limit`/`-Remaining`/
   * `-Reset` — plus `Retry-After` **only when the request was rejected**; `false`
   * emits none; a function returns your own map.
   */
  readonly headers?: boolean | ((info: RateLimitInfo) => Record<string, string>);
}

/**
 * Options for the {@link rateLimit} **def** — frontend-safe only.
 *
 * @typeParam R - middleware this one depends on (their context is typed in the
 *   server-side `key`/`skip`).
 */
export interface RateLimitDefOptions<R extends readonly AnyMiddleware[]> {
  /** Middleware this one depends on — their context is available (and typed) in `key`/`skip`. */
  readonly requires?: R;
  /** Middleware name for docs/debugging (default `'rateLimit'`). */
  readonly name?: string;
}

/** A reusable rate limiter bound to a rule + store — usable anywhere, not just middleware. */
export interface Limiter {
  /** Record a hit for `key` (at `now`, default `Date.now()`) and return the decision. */
  check(key: string, now?: number): MaybePromise<RateLimitResult>;
  /** Clear all state for `key`. */
  reset(key: string): MaybePromise<void>;
  /** The rule this limiter enforces. */
  readonly rule: RateLimitRule;
}

/**
 * Create a standalone {@link Limiter} — the rate-limit primitive the
 * {@link rateLimit} middleware is built on. Use it anywhere you have a key: a
 * plain handler, a queue/cron worker, a CLI, a different framework.
 *
 * ```ts
 * const lim = limiter({ limit: 100, window: 60_000, algorithm: 'token-bucket' })
 * const { allowed, retryAfter } = await lim.check(userId)
 * if (!allowed) throw reject(429, 'RATE_LIMITED', `retry in ${retryAfter}ms`)
 * ```
 */
export function limiter(opts: LimiterOptions): Limiter {
  const store = opts.store ?? memoryStore();
  const rule: RateLimitRule = {
    limit: opts.limit,
    window: opts.window,
    algorithm: opts.algorithm ?? DEFAULT_ALGORITHM,
    countRejected: opts.countRejected ?? false,
  };
  const prefix = opts.prefix ?? DEFAULT_PREFIX;
  return {
    rule,
    check: (key, now) => store.consume(prefix + key, rule, now ?? Date.now()),
    reset: (key) => Promise.resolve(store.reset?.(prefix + key)),
  };
}

/**
 * Compute the rate-limit response headers for `info`. `true` (default) emits the
 * draft `RateLimit-Limit`/`-Remaining`/`-Reset` headers — plus `Retry-After` **only
 * when the request was rejected** (`retryAfter > 0`); `false` emits none; a function
 * returns your own map (which **replaces** the defaults).
 *
 * Shared by {@link rateLimitResponse} (the 429) and the middleware's `alwaysHeaders`
 * option (informational headers on allowed responses).
 */
export function rateLimitHeaders(
  info: RateLimitInfo,
  headers: boolean | ((info: RateLimitInfo) => Record<string, string>) = true,
): Record<string, string> {
  if (headers === false) {return {};}
  if (typeof headers === 'function') {return { ...headers(info) };}
  const out: Record<string, string> = {
    'ratelimit-limit': String(info.limit),
    'ratelimit-remaining': String(info.remaining),
    'ratelimit-reset': String(Math.ceil(info.reset / MS_PER_SECOND)),
  };
  if (info.retryAfter > 0) {out['retry-after'] = String(Math.ceil(info.retryAfter / MS_PER_SECOND));}
  return out;
}

/**
 * Build a rate-limit (429) `Response` from limiter info — usable on its own,
 * outside any middleware (e.g. from a handler that called {@link limiter} directly).
 */
export function rateLimitResponse(info: RateLimitInfo, opts: RateLimitResponseOptions = {}): Response {
  const status = opts.status ?? DEFAULT_STATUS;
  const headers: Record<string, string> = rateLimitHeaders(info, opts.headers);
  const body = typeof opts.message === 'function' ? opts.message(info) : (opts.message ?? 'Too many requests');
  if (typeof body === 'string') {
    if (!('content-type' in headers)) {headers['content-type'] = 'text/plain; charset=utf-8';}
    return new Response(body, { status, headers });
  }
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}

/**
 * Create a rate-limiting middleware **def**. The def declares what the middleware
 * contributes (`{ ratelimit: RateLimitInfo }`) and its dependencies — but **no**
 * policy. Bind the key/limit/window/store with
 * [`rateLimit.server(def, { key, limit, window })`](./server).
 *
 * @typeParam R - inferred from `requires`; their context types flow into the
 *   server-side `key`/`skip`/`message`.
 */
export function rateLimit<const R extends readonly AnyMiddleware[] = readonly []>(opts?: RateLimitDefOptions<R>) {
  const name = opts?.name ?? 'rateLimit';
  return middleware(name, { provides: ctx<{ ratelimit: RateLimitInfo }>(), requires: (opts?.requires ?? []) as R });
}

/** The def type a {@link rateLimit} call produces — what `rateLimit.server` binds against. */
export type RateLimitDef<R extends readonly AnyMiddleware[] = readonly []> = ReturnType<typeof rateLimit<R>>;

/* ============================================================================
 * Rate-limited doer — gates task starts through a {@link limiter}.
 * ==========================================================================*/

/** Minimum re-check delay when a deferred task has no explicit retry hint (ms). */
const DOER_RETRY_FLOOR = 50;

/** Options for {@link rateLimitedDoer} — a {@link LimiterOptions} plus doer-specific knobs. */
export interface RateLimitedDoerOptions extends LimiterOptions {
  /** Limit key — a single shared bucket by default (`'doer'`), or derived per task. */
  readonly key?: string | ((opts: DoerTaskOptions) => string);
  /** Floor on the re-check delay for deferred tasks (ms, default 50). */
  readonly retryFloor?: number;
  /** Clock injection (default `Date.now`). */
  readonly now?: () => number;
  /** The doer that actually runs admitted tasks (default {@link unlimitedDoer}). Compose policies. */
  readonly doer?: Doer;
  /**
   * Observe a store error during admission (e.g. a distributed store hiccup). The drain loop
   * never crashes on it — the task stays pending and admission is retried shortly. Off by
   * default; it must not throw — if it does, the throw is ignored.
   */
  readonly onError?: (err: unknown) => void;
}

interface DoerPending {
  readonly run: () => Promise<void>;
  readonly opts?: DoerTaskOptions;
  readonly createdAt: number;
  readonly seq: number;
}

/**
 * A {@link Doer} (see `@ayepi/core/doer`) that caps the **start rate** of tasks using a
 * standalone {@link limiter} — the same primitive (and pluggable {@link RateLimitStore}/
 * algorithm) the {@link rateLimit} middleware uses. When the limiter admits a task it is
 * handed to an **inner doer** (default {@link unlimitedDoer}), so you can compose a rate
 * cap with a concurrency/ordering policy (e.g. `rateLimitedDoer({ …, doer: priorityDoer({ max: 4 }) })`).
 * Excess tasks wait, oldest-first; a distributed store rate-limits **across a fleet**.
 *
 * ```ts
 * import { rateLimitedDoer } from '@ayepi/rate'
 * import { createWork } from '@ayepi/work'
 *
 * const doer = rateLimitedDoer({ limit: 100, window: 60_000, algorithm: 'token-bucket' })
 * const w = createWork({ work: [sendEmail] as const, doer })
 * ```
 */
export function rateLimitedDoer(opts: RateLimitedDoerOptions): Doer {
  const lim = limiter(opts);
  const inner = opts.doer ?? unlimitedDoer();
  const now = opts.now ?? Date.now;
  const floor = opts.retryFloor ?? DOER_RETRY_FLOOR;
  const keyOf = (o: DoerTaskOptions | undefined): string => (typeof opts.key === 'function' ? opts.key(o ?? {}) : (opts.key ?? 'doer'));

  const pending: DoerPending[] = [];
  const idle: (() => void)[] = [];
  let seq = 0;
  let draining = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const arm = (ms: number): void => {
    if (timer) {return;}
    timer = setTimeout(() => {
      timer = null;
      void drain();
    }, Math.max(floor, ms))
    ;(timer as { unref?: () => void }).unref?.();
  };
  const drain = async (): Promise<void> => {
    if (draining) {return;}
    draining = true;
    try {
      while (pending.length > 0) {
        if (inner.available() <= 0) {
          arm(floor); // inner doer saturated — re-check soon
          break;
        }
        let best = 0;
        for (let i = 1; i < pending.length; i++) {
          const a = pending[i]!;
          const b = pending[best]!;
          if (a.createdAt < b.createdAt || (a.createdAt === b.createdAt && a.seq < b.seq)) {best = i;}
        }
        const task = pending[best]!;
        let res;
        try {
          res = await lim.check(keyOf(task.opts), now());
        } catch (err) {
          try {
            opts.onError?.(err);
          } catch {
            /* error reporting must never crash the drain loop */
          }
          arm(floor); // a store hiccup must not strand pending tasks — retry admission shortly
          break;
        }
        if (!res.allowed) {
          arm(res.retryAfter); // wait until the limiter would allow again
          break;
        }
        pending.splice(best, 1);
        inner.do(task.run, task.opts); // admitted → hand off to the inner doer
      }
      if (pending.length === 0) {for (const r of idle.splice(0)) {r();}}
    } finally {
      draining = false;
    }
  };

  return {
    available: () => Math.min(Math.max(0, lim.rule.limit - pending.length), inner.available()),
    do(task, o) {
      pending.push({ run: task, opts: o, createdAt: o?.createdAt ?? now(), seq: seq++ });
      void drain();
    },
    done: () => (pending.length === 0 ? inner.done() : new Promise<void>((r) => idle.push(() => void inner.done().then(r)))),
  };
}

/* ============================================================================
 * In-memory store — all three algorithms, single process, zero dependencies.
 * ==========================================================================*/

interface Counter {
  count: number;
  reset: number;
}
interface Bucket {
  tokens: number;
  ts: number;
}

function fixedWindow(counters: Map<string, Counter>, key: string, rule: RateLimitRule, now: number): RateLimitResult {
  let e = counters.get(key);
  if (!e || e.reset <= now) {
    e = { count: 0, reset: now + rule.window };
    counters.set(key, e);
  }
  const allowed = e.count < rule.limit;
  if (allowed || rule.countRejected) {e.count++;} // by default a rejected hit doesn't consume budget
  const reset = e.reset - now;
  return { allowed, limit: rule.limit, remaining: Math.max(0, rule.limit - e.count), reset, retryAfter: allowed ? 0 : reset };
}

function slidingWindow(counters: Map<string, Counter>, key: string, rule: RateLimitRule, now: number): RateLimitResult {
  const windowStart = Math.floor(now / rule.window) * rule.window;
  const curKey = `${key}|${windowStart}`;
  const prevKey = `${key}|${windowStart - rule.window}`;
  let cur = counters.get(curKey);
  if (!cur || cur.reset <= now) {
    cur = { count: 0, reset: windowStart + rule.window };
    counters.set(curKey, cur);
  }
  // prevKey already encodes the immediately-previous window, so its count always applies
  const prevCount = counters.get(prevKey)?.count ?? 0;
  const weight = (rule.window - (now - windowStart)) / rule.window;
  // would admitting this request stay within the limit?
  const allowed = prevCount * weight + cur.count + 1 <= rule.limit;
  if (allowed || rule.countRejected) {cur.count++;} // by default a rejected hit doesn't carry into the next window
  const weighted = prevCount * weight + cur.count;
  const reset = windowStart + rule.window - now;
  return { allowed, limit: rule.limit, remaining: Math.max(0, Math.floor(rule.limit - weighted)), reset, retryAfter: allowed ? 0 : reset };
}

function tokenBucket(buckets: Map<string, Bucket>, key: string, rule: RateLimitRule, now: number): RateLimitResult {
  const cap = rule.limit;
  const refillPerMs = rule.limit / rule.window;
  let b = buckets.get(key);
  if (!b) {b = { tokens: cap, ts: now };}
  b.tokens = Math.min(cap, b.tokens + (now - b.ts) * refillPerMs);
  b.ts = now;
  const cost = TOKEN_COST;
  let allowed = false;
  if (b.tokens >= cost) {
    b.tokens -= cost;
    allowed = true;
  } // a rejected request never has the tokens to charge, so `countRejected` is moot here
  buckets.set(key, b);
  const remaining = Math.floor(b.tokens);
  const retryAfter = allowed ? 0 : Math.ceil((cost - b.tokens) / refillPerMs);
  const reset = Math.ceil((cap - b.tokens) / refillPerMs);
  return { allowed, limit: cap, remaining, reset, retryAfter };
}

/**
 * An in-process {@link RateLimitStore} implementing all three algorithms. The
 * default store — fine for a single instance; use a distributed store (e.g.
 * `@ayepi/rate/redis`) to share limits across pods. Expired entries are swept
 * lazily.
 */
export function memoryStore(): RateLimitStore {
  const counters = new Map<string, Counter>();
  const buckets = new Map<string, Bucket>();
  let ops = 0;
  const sweep = (now: number) => {
    if (++ops % SWEEP_EVERY !== 0) {return;}
    for (const [k, e] of counters) {if (e.reset <= now) {counters.delete(k);}}
    for (const [k, b] of buckets) {if (now - b.ts > BUCKET_IDLE_MS) {buckets.delete(k);}}
  };
  return {
    consume(key, rule, now) {
      sweep(now);
      switch (rule.algorithm) {
        case 'sliding-window':
          return slidingWindow(counters, key, rule, now);
        case 'token-bucket':
          return tokenBucket(buckets, key, rule, now);
        default:
          return fixedWindow(counters, key, rule, now);
      }
    },
    reset(key) {
      counters.delete(key);
      for (const k of counters.keys()) {if (k.startsWith(`${key}|`)) {counters.delete(k);}}
      buckets.delete(key);
    },
  };
}
