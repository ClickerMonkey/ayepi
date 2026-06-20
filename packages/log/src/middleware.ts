/**
 * # @ayepi/log/middleware
 *
 * The frontend-safe **def** for a trace-context middleware. It declares a
 * no-context middleware (it establishes the log context for the downstream chain +
 * handler, but contributes nothing to the payload), with no `node:async_hooks` —
 * that lives in the impl bound via [`logMiddleware.server`](../server) from
 * `@ayepi/log/server`.
 *
 * ```ts
 * // shared.ts (frontend-safe)
 * import { logMiddleware } from '@ayepi/log/middleware';
 * const trace = logMiddleware({ requires: [auth] });
 * spec({ endpoints: { ...trace.group({ … }) } });
 *
 * // server.ts
 * import { logMiddleware } from '@ayepi/log/server';
 * implement(api).middleware(logMiddleware.server(trace, {
 *   context: (ctx, req) => ({ userId: ctx.user.id, path: new URL(req.url).pathname }),
 * }));
 * ```
 *
 * @module
 */

import { middleware } from '@ayepi/core';
import type { AnyMiddleware } from '@ayepi/core';

/**
 * Options for the {@link logMiddleware} **def** — frontend-safe only.
 *
 * @typeParam R - middleware this one depends on (their context is typed in the
 *   server-side `context`).
 */
export interface LogMiddlewareDefOptions<R extends readonly AnyMiddleware[]> {
  /** Middleware this one depends on — their context is available (and typed) in `context`. */
  readonly requires?: R;
  /** Middleware name for docs/debugging (default `'log'`). */
  readonly name?: string;
}

/**
 * Create a trace-context middleware **def** — a no-context, frontend-safe contract.
 * Bind the context builder with [`logMiddleware.server(def, { context })`](../server).
 *
 * @typeParam R - inferred from `requires`.
 */
export function logMiddleware<const R extends readonly AnyMiddleware[] = readonly []>(opts?: LogMiddlewareDefOptions<R>) {
  const name = opts?.name ?? 'log';
  return middleware(name, { requires: (opts?.requires ?? []) as R });
}

/** The def type a {@link logMiddleware} call produces — what `logMiddleware.server` binds against. */
export type LogMiddlewareDef<R extends readonly AnyMiddleware[] = readonly []> = ReturnType<typeof logMiddleware<R>>;
