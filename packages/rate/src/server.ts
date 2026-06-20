/**
 * # @ayepi/rate/server — rate-limit **impl** binder
 *
 * The server half of `@ayepi/rate`: it binds a frontend-safe {@link rateLimit} def
 * to its policy — the key derivation, limit/window, algorithm, store, and the
 * over-limit response. (Rate limiting has no `node:*` deps, so this split is for
 * API symmetry with the other middleware, and to keep the policy/secrets out of a
 * frontend-importable spec.)
 *
 * ```ts
 * import { rateLimit } from '@ayepi/rate/server';
 * implement(api).middleware(rateLimit.server(limit, {
 *   key: (io) => io.ctx.user.id,
 *   limit: 100,
 *   window: 60_000,
 * }));
 * ```
 *
 * @module
 */

import type { AnyMiddleware, BoundMiddleware, ImplFor, MiddlewareIO, StackCtx, Json } from '@ayepi/core';
import { limiter, rateLimitResponse, rateLimitHeaders, rateLimit as rateLimitDef } from './index';
import type { Algorithm, RateKeyIO, RateLimitInfo, RateLimitResult, RateLimitStore } from './index';

/** The `requires` chain of a middleware def. */
type ReqOf<M extends AnyMiddleware> = M['__req'];

/**
 * Server-side options for binding a {@link rateLimit} def — the limiting policy and
 * response customization, with `key`/`skip`/`message` typed against the def's
 * `requires` context.
 *
 * @typeParam M - the rate-limit def being bound.
 */
export interface RateLimitServerOptions<M extends AnyMiddleware> {
  /** Derive the rate-limit key from the request context (e.g. `io.ctx.user.id`). */
  readonly key: (io: RateKeyIO<StackCtx<ReqOf<M>>>) => string;
  /** Max requests (or token-bucket capacity) per window. */
  readonly limit: number;
  /** Window length in milliseconds (also the token refill period). */
  readonly window: number;
  /** Algorithm (default `'fixed-window'`). */
  readonly algorithm?: Algorithm;
  /** Backend store (default an in-process memory store). */
  readonly store?: RateLimitStore;
  /** Key prefix/namespace (default `'rl:'`). */
  readonly prefix?: string;
  /** Over-limit status code (default `429`). */
  readonly status?: number;
  /** Over-limit body — a string, a JSON value, or a function of the limiter info and request. */
  readonly message?: string | Json | ((info: RateLimitInfo, io: RateKeyIO<StackCtx<ReqOf<M>>>) => string | Json);
  /** Response headers (draft `RateLimit-*` + `Retry-After` by default; `false` for none; a function for your own). */
  readonly headers?: boolean | ((info: RateLimitInfo) => Record<string, string>);
  /**
   * Also emit the `RateLimit-*` headers on **allowed** (and skipped) responses, not
   * just the over-limit 429 — so every response advertises the caller's remaining
   * budget. Default `false`. Uses the same {@link RateLimitServerOptions.headers}
   * formatting (`Retry-After` is omitted when not rate-limited).
   */
  readonly alwaysHeaders?: boolean;
  /** Bypass the limiter for some requests (e.g. an allow-list). */
  readonly skip?: (io: RateKeyIO<StackCtx<ReqOf<M>>>) => boolean;
  /**
   * What to do when the **store itself errors** (e.g. Redis is down) — `true` serves the
   * request through (as if allowed, full budget); `false` (default) is fail-**closed**: the
   * error propagates, so a store outage rejects requests rather than silently lifting the limit.
   */
  readonly failOpen?: boolean;
  /**
   * Observe a store error. Fires whether or not {@link failOpen} is set (with `failOpen` the
   * request is then allowed; without it the error still propagates). Off by default; it must
   * not throw — if it does, the throw is ignored.
   */
  readonly onError?: (err: unknown) => void;
}

/** Bind a {@link rateLimit} def to its runtime policy. */
function rateLimitServer<M extends AnyMiddleware>(def: M, opts: RateLimitServerOptions<M>): BoundMiddleware<M> {
  const lim = limiter(opts); // the standalone primitive does the actual limiting
  const message = opts.message;

  const run = async (io: MiddlewareIO<StackCtx<ReqOf<M>>>) => {
    const kio: RateKeyIO<StackCtx<ReqOf<M>>> = { req: io.req, ctx: io.ctx };
    // when `alwaysHeaders`, advertise the RateLimit-* headers on allowed/skipped responses too
    const advertise = (info: RateLimitInfo): void => {
      if (!opts.alwaysHeaders) {return;}
      for (const [name, value] of Object.entries(rateLimitHeaders(info, opts.headers))) {io.setHeader(name, value);}
    };
    const fullBudget = (): RateLimitInfo => ({ limit: lim.rule.limit, remaining: lim.rule.limit, reset: 0, retryAfter: 0 });
    if (opts.skip?.(kio)) {
      const skipped = fullBudget();
      advertise(skipped);
      return io.next({ ratelimit: skipped });
    }
    let result: RateLimitResult;
    try {
      result = await lim.check(opts.key(kio));
    } catch (err) {
      try {
        opts.onError?.(err);
      } catch {
        /* error reporting must never break the request */
      }
      if (!opts.failOpen) {throw err;} // default: fail-closed — a store outage rejects the request
      const allowed = fullBudget(); // failOpen → serve through as if under the limit
      advertise(allowed);
      return io.next({ ratelimit: allowed });
    }
    const info: RateLimitInfo = {
      limit: result.limit,
      remaining: result.remaining,
      reset: result.reset,
      retryAfter: result.retryAfter,
    };
    if (!result.allowed) {
      return rateLimitResponse(info, {
        status: opts.status,
        headers: opts.headers,
        // adapt the middleware's (info, io) message into the response helper's (info) form
        message: typeof message === 'function' ? (i) => message(i, kio) : message,
      });
    }
    advertise(info);
    return io.next({ ratelimit: info });
  };

  return { def, impl: run as unknown as ImplFor<M> }; // internal cast: the precise typed run presented as the def's bound impl
}

/**
 * The {@link rateLimit} def factory, augmented with a `.server(def, opts)` binder.
 * Import from `@ayepi/rate/server` in your server entry to bind a def created in a
 * frontend-safe spec.
 */
export const rateLimit = Object.assign(rateLimitDef, { server: rateLimitServer });
