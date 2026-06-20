/**
 * # @ayepi/log/server — trace-context middleware **impl** binder (node)
 *
 * The server half of [`@ayepi/log/middleware`](./middleware): it binds a frontend-safe
 * {@link logMiddleware} def to its runtime — wrapping the downstream `io.next()` in
 * `logWith(context(ctx, req))` so the whole chain + handler (and any error they
 * throw) run inside that trace context. This is the only place the middleware pulls
 * `node:async_hooks` (via `./internal`).
 *
 * ```ts
 * import { logMiddleware } from '@ayepi/log/server';
 * implement(api).middleware(logMiddleware.server(trace, {
 *   context: (ctx, req) => ({ userId: ctx.user.id, path: new URL(req.url).pathname }),
 * }));
 * ```
 *
 * @module
 */

import type { AnyMiddleware, BoundMiddleware, ImplFor, MiddlewareIO, StackCtx } from '@ayepi/core';
import { runWith } from './internal';
import { logMiddleware as logMiddlewareDef } from './middleware';

/** The `requires` chain of a middleware def. */
type ReqOf<M extends AnyMiddleware> = M['__req'];

/**
 * Server-side options for binding a {@link logMiddleware} def.
 *
 * @typeParam M - the def being bound (its `requires` type the `context` callback reads).
 */
export interface LogMiddlewareServerOptions<M extends AnyMiddleware> {
  /** Build the context object to push for the downstream chain + handler. */
  readonly context: (ctx: StackCtx<ReqOf<M>>, req: Request) => object;
  /** `logWith` to use (default the package's shared trace context). Pass a specific logger's `logWith` to scope it. */
  readonly logWith?: <T>(add: object, inner: () => T) => T;
  /**
   * Observe an error thrown while building or pushing the trace context. The middleware is
   * **fail-open**: such an error never breaks the request (the chain runs without the context).
   * Off by default. It must not throw; if it does, the throw is ignored.
   */
  readonly onError?: (err: unknown) => void;
}

/** Bind a {@link logMiddleware} def to its runtime impl. */
function logServer<M extends AnyMiddleware>(def: M, opts: LogMiddlewareServerOptions<M>): BoundMiddleware<M> {
  const wrap = opts.logWith ?? runWith;
  const report = (err: unknown): void => {
    try {
      opts.onError?.(err);
    } catch {
      /* error reporting must never break the request */
    }
  };
  // Building/pushing the trace context is best-effort: if it throws, run the chain without it
  // rather than failing the request. `io.next()` (the handler) runs outside the guard.
  const run = (io: MiddlewareIO<StackCtx<ReqOf<M>>>): Promise<unknown> => {
    let fields: object;
    try {
      fields = opts.context(io.ctx, io.req);
    } catch (err) {
      report(err);
      return Promise.resolve(io.next());
    }
    try {
      return Promise.resolve(wrap(fields, () => io.next()));
    } catch (err) {
      report(err);
      return Promise.resolve(io.next());
    }
  };
  return { def, impl: run as unknown as ImplFor<M> }; // internal cast: the precise typed run presented as the def's bound impl
}

/**
 * The {@link logMiddleware} def factory, augmented with a `.server(def, opts)` binder.
 * Import from `@ayepi/log/server` in your server entry to bind a def created in a
 * frontend-safe spec.
 */
export const logMiddleware = Object.assign(logMiddlewareDef, { server: logServer });
