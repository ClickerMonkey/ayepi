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
import type { AnyMiddleware, Json, MaybePromise, MiddlewareDef } from '@ayepi/core';
import { unlimitedDoer, type Doer, type DoerTaskOptions } from '@ayepi/core/doer';

/* ---- tunable constants ---- */
/** Default over-limit HTTP status. */
const DEFAULT_STATUS = 429;
/** Default key namespace. */
export const DEFAULT_PREFIX = 'rl:';
/** Default algorithm. */
export const DEFAULT_ALGORITHM: Algorithm = 'fixed-window';
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
export function rateLimit<const R extends readonly AnyMiddleware[] = readonly []>(opts?: RateLimitDefOptions<R>): RateLimitDef<R> {
  const name = opts?.name ?? 'rateLimit';
  return middleware(name, { provides: ctx<{ ratelimit: RateLimitInfo }>(), requires: (opts?.requires ?? []) as R });
}

/** The def type a {@link rateLimit} call produces — what `rateLimit.server` binds against. */
export type RateLimitDef<R extends readonly AnyMiddleware[] = readonly []> = MiddlewareDef<{ ratelimit: RateLimitInfo }, R>;

/* ============================================================================
 * Rate-limited doer — gates task starts through a {@link limiter}.
 * ==========================================================================*/

/** Minimum re-check delay when a deferred task has no explicit retry hint (ms). */
const DOER_RETRY_FLOOR = 50;

/** Details of a sustained backlog, passed to {@link RateLimitedDoerOptions.onBacklog}. */
export interface RateLimitedBacklogInfo {
  /** Tasks waiting on the rate limit to admit them (the queue depth). */
  readonly pending: number;
  /** How long the queue has been *continuously* non-empty (ms). */
  readonly nonEmptyForMs: number;
}

/**
 * Per-task options for a {@link rateLimitedDoer} — {@link DoerTaskOptions} (`group`/`priority`/
 * `createdAt`) plus a per-request **group limit** override. When a `group` and a group limit are
 * present, the task must clear both the global limit **and** its group's limit to be admitted.
 */
export interface RateTaskOptions extends DoerTaskOptions {
  /** Per-task group rate limit (a second gate, bucketed by `group`). Overrides {@link RateLimitedDoerOptions.groupLimit}. */
  readonly groupLimit?: number;
  /** Window for the group limit (ms; default: the global `window`). */
  readonly groupWindow?: number;
  /** Algorithm for the group limit (default: the global `algorithm`). */
  readonly groupAlgorithm?: Algorithm;
}

/** A {@link Doer} whose `do` accepts {@link RateTaskOptions} — i.e. a per-task group limit. */
export interface RateLimitedDoer extends Doer {
  /** Accept a task; `opts` may carry a per-task `group` + `groupLimit` (a second, per-group gate). */
  do(task: () => Promise<void>, opts?: RateTaskOptions): void;
}

/** Options for {@link rateLimitedDoer} — a {@link LimiterOptions} plus doer-specific knobs. */
export interface RateLimitedDoerOptions extends LimiterOptions {
  /** Limit key for the **global** bucket — a single shared bucket by default (`'doer'`), or derived per task. */
  readonly key?: string | ((opts: DoerTaskOptions) => string);
  /**
   * Default **group** limit — a second gate bucketed by a task's `group`, on top of the global limit.
   * A per-task {@link RateTaskOptions.groupLimit} overrides it. Omit for no group gate (global only).
   * The group window/algorithm default to the global ones unless overridden per task.
   */
  readonly groupLimit?: number;
  /** Derive a task's group bucket key (default: `opts.group`). Return `undefined` to skip the group gate for a task. */
  readonly groupKey?: (opts: DoerTaskOptions) => string | undefined;
  /**
   * Store for the group buckets (default: the global `store`). A distributed store limits groups
   * across a fleet. Groups need not be known up front — bucket state is per-group and **auto-evicted
   * when idle** (the {@link memoryStore} sweeps expired/idle keys; `@ayepi/rate/redis` sets TTLs), so
   * an unbounded, dynamic group space (per-user/per-model) won't grow without bound. For high churn,
   * pass a tuned store, e.g. `groupStore: memoryStore({ sweepEvery: 200, idleMs: 30_000 })`.
   */
  readonly groupStore?: RateLimitStore;
  /** Floor on the re-check delay for deferred tasks (ms, default 50). */
  readonly retryFloor?: number;
  /** Clock injection (default `Date.now`). */
  readonly now?: () => number;
  /** The doer that actually runs admitted tasks (default {@link unlimitedDoer}). Compose policies. */
  readonly doer?: Doer;
  /**
   * Notified when the pending queue stays **continuously non-empty** past
   * {@link RateLimitedDoerOptions.backlogAfterMs} — a sustained backlog of tasks the rate limit can't
   * admit fast enough. Purely observational (for alerting/autoscaling); it must not throw — if it
   * does, the throw is ignored. Requires `backlogAfterMs`.
   */
  readonly onBacklog?: (info: RateLimitedBacklogInfo) => void;
  /** How long the queue must stay non-empty before {@link RateLimitedDoerOptions.onBacklog} first fires (ms). */
  readonly backlogAfterMs?: number;
  /** Re-fire `onBacklog` every this many ms while still backed up. Omit to fire once per backlog episode. */
  readonly backlogEveryMs?: number;
  /**
   * Observe a store error during admission (e.g. a distributed store hiccup). The drain loop
   * never crashes on it — the task stays pending and admission is retried shortly. Off by
   * default; it must not throw — if it does, the throw is ignored.
   */
  readonly onError?: (err: unknown) => void;
}

interface DoerPending {
  readonly run: () => Promise<void>;
  readonly opts?: RateTaskOptions;
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
 *
 * **Two-tier limiting.** Set a `groupLimit` (default, or per task via {@link RateTaskOptions}) and a
 * task must clear both the global limit **and** its `group`'s limit — e.g. a global API cap plus a
 * per-user / per-model cap. The group gate is checked first (a denied group check consumes nothing),
 * so a task whose group is at its limit is **skipped** rather than blocking other groups, and the
 * shared global bucket isn't spent on it. `group`/`groupLimit` are read at admission time.
 */
export function rateLimitedDoer(opts: RateLimitedDoerOptions): RateLimitedDoer {
  const store = opts.store ?? memoryStore();
  const lim = limiter({ ...opts, store }); // global gate — shares `store` so groups can reuse it
  const inner = opts.doer ?? unlimitedDoer();
  const now = opts.now ?? Date.now;
  const floor = opts.retryFloor ?? DOER_RETRY_FLOOR;
  const keyOf = (o: DoerTaskOptions | undefined): string => (typeof opts.key === 'function' ? opts.key(o ?? {}) : (opts.key ?? 'doer'));

  /* ---- group gate (optional): a second per-`group` limit on top of the global one ---- */
  const groupStore = opts.groupStore ?? store;
  const groupPrefix = (opts.prefix ?? DEFAULT_PREFIX) + 'grp:'; // namespaced apart from global keys
  const groupKeyOf = (o: RateTaskOptions | undefined): string | undefined => (opts.groupKey ? opts.groupKey(o ?? {}) : o?.group);
  const groupRuleFor = (o: RateTaskOptions | undefined): RateLimitRule | undefined => {
    const limit = o?.groupLimit ?? opts.groupLimit;
    if (limit === undefined) {return undefined;} // no group limit → global gate only
    return {
      limit,
      window: o?.groupWindow ?? opts.window,
      algorithm: o?.groupAlgorithm ?? opts.algorithm ?? DEFAULT_ALGORITHM,
      countRejected: false, // a denied group check must NOT consume — the skip depends on it
    };
  };
  const report = (err: unknown): void => {
    try {
      opts.onError?.(err);
    } catch {
      /* error reporting must never crash the drain loop */
    }
  };

  const pending: DoerPending[] = [];
  const idle: (() => void)[] = [];
  let seq = 0;
  let draining = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  /* ---- sustained-backlog watch (optional): fire while tasks stay queued on the rate limit ---- */
  const backlogWatch = opts.onBacklog !== undefined && opts.backlogAfterMs !== undefined;
  let nonEmptySince: number | null = null;
  let backlogTimer: ReturnType<typeof setTimeout> | null = null;
  const armBacklog = (ms: number): void => {
    backlogTimer = setTimeout(fireBacklog, ms)
    ;(backlogTimer as { unref?: () => void }).unref?.();
  };
  function fireBacklog(): void {
    try {
      opts.onBacklog!({ pending: pending.length, nonEmptyForMs: now() - nonEmptySince! });
    } catch {
      /* an observer must never disrupt the doer */
    }
    if (opts.backlogEveryMs !== undefined) {armBacklog(opts.backlogEveryMs);} // keep notifying while backed up
    else {backlogTimer = null;} // fire-once per episode
  }
  const syncBacklog = (): void => {
    if (!backlogWatch) {return;}
    if (pending.length > 0) {
      if (nonEmptySince === null) {
        nonEmptySince = now();
        armBacklog(opts.backlogAfterMs!);
      }
    } else {
      // queue drained — `do()` always calls this with a task queued, so an empty queue means
      // the backlog cleared; reset (idempotent) and cancel any pending alarm.
      nonEmptySince = null;
      if (backlogTimer) {
        clearTimeout(backlogTimer);
        backlogTimer = null;
      }
    }
  };

  const arm = (ms: number): void => {
    if (timer) {return;}
    timer = setTimeout(() => {
      timer = null;
      void drain();
    }, Math.max(floor, ms))
    ;(timer as { unref?: () => void }).unref?.();
  };
  /**
   * The oldest pending task not skipped this round (a fresh scan, so tasks queued mid-drain are
   * seen). `pending` is in insertion (seq) order, so equal `createdAt` ties keep the earliest.
   */
  const nextPending = (skipped: ReadonlySet<DoerPending>): DoerPending | undefined => {
    let best: DoerPending | undefined;
    for (const t of pending) {
      if (skipped.has(t)) {continue;}
      if (!best || t.createdAt < best.createdAt) {best = t;}
    }
    return best;
  };
  const drain = async (): Promise<void> => {
    if (draining) {return;}
    draining = true;
    try {
      // Oldest-first, but SKIP tasks whose group is at its limit so a hot group can't block others;
      // stop when the shared global bucket is exhausted (nothing more can be admitted this round).
      const skipped = new Set<DoerPending>();
      let soonest = Infinity;
      for (;;) {
        if (inner.available() <= 0) {
          soonest = Math.min(soonest, floor); // inner doer saturated — re-check soon
          break;
        }
        const task = nextPending(skipped);
        if (!task) {break;} // everything left is capped on its group (all skipped) — nothing to admit
        const o = task.opts;
        // group gate first — a denied check consumes nothing, so skipping wastes no global token
        const groupRule = groupRuleFor(o);
        const gk = groupKeyOf(o);
        if (groupRule && gk !== undefined) {
          let gr;
          try {
            gr = await groupStore.consume(groupPrefix + gk, groupRule, now());
          } catch (err) {
            report(err);
            soonest = Math.min(soonest, floor); // group-store hiccup — back off the whole round
            break;
          }
          if (!gr.allowed) {
            soonest = Math.min(soonest, gr.retryAfter); // this group is capped → try other groups
            skipped.add(task);
            continue;
          }
        }
        // global gate (shared) — if it's out, no further task can be admitted this round
        let res;
        try {
          res = await lim.check(keyOf(o), now());
        } catch (err) {
          report(err);
          soonest = Math.min(soonest, floor);
          break;
        }
        if (!res.allowed) {
          soonest = Math.min(soonest, res.retryAfter);
          break;
        }
        pending.splice(pending.indexOf(task), 1);
        inner.do(task.run, task.opts); // both gates passed → hand off to the inner doer
      }
      if (pending.length === 0) {for (const r of idle.splice(0)) {r();}}
      else {arm(soonest);} // pending remains → re-check when the soonest gate would allow again (soonest is finite here)
      syncBacklog(); // pending shrank (admitted) or held (rate-limited) — update the backlog clock
    } finally {
      draining = false;
    }
  };

  return {
    available: () => Math.min(Math.max(0, lim.rule.limit - pending.length), inner.available()),
    do(task, o) {
      pending.push({ run: task, opts: o, createdAt: o?.createdAt ?? now(), seq: seq++ });
      syncBacklog(); // a new task queued — start the backlog clock if this is the first
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

/** Options for {@link memoryStore}. */
export interface MemoryStoreOptions {
  /**
   * Sweep expired/idle entries once every this many `consume` calls (default 1000). Lower bounds
   * memory tighter when keys churn — e.g. many short-lived rate-limit **groups** (per-user/per-model)
   * that aren't known up front — at a little more periodic scan cost.
   */
  readonly sweepEvery?: number;
  /**
   * Drop an idle **token-bucket** key after this long with no activity (ms, default 10 min).
   * Windowed (`fixed-window`/`sliding-window`) counters are always dropped once their window has
   * elapsed, regardless of this.
   */
  readonly idleMs?: number;
}

/**
 * An in-process {@link RateLimitStore} implementing all three algorithms. The default store — fine
 * for a single instance; use a distributed store (e.g. `@ayepi/rate/redis`, which sets key TTLs) to
 * share limits across pods.
 *
 * **Bounded memory for dynamic keys.** Entries are swept lazily so an unbounded, not-known-in-advance
 * key space (per-user/per-model rate-limit **groups**) doesn't grow without bound: a windowed counter
 * is dropped once its window elapses, and an idle token-bucket after {@link MemoryStoreOptions.idleMs}.
 * Active keys live long enough to enforce the limit; idle ones go away. Tune {@link MemoryStoreOptions}
 * for high churn.
 */
export function memoryStore(opts: MemoryStoreOptions = {}): RateLimitStore {
  const sweepEvery = opts.sweepEvery ?? SWEEP_EVERY;
  const idleMs = opts.idleMs ?? BUCKET_IDLE_MS;
  const counters = new Map<string, Counter>();
  const buckets = new Map<string, Bucket>();
  let ops = 0;
  const sweep = (now: number) => {
    if (++ops % sweepEvery !== 0) {return;}
    for (const [k, e] of counters) {if (e.reset <= now) {counters.delete(k);}}
    for (const [k, b] of buckets) {if (now - b.ts > idleMs) {buckets.delete(k);}}
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
