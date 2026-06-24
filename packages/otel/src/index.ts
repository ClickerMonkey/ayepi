/**
 * # @ayepi/otel
 *
 * A telemetry middleware **def** for `@ayepi/core`. This entry is **frontend-safe**:
 * it declares a no-context middleware (it logs and establishes trace context, but
 * contributes nothing to the handler payload) with no `node:crypto` and no
 * `@ayepi/log` runtime import. All behaviour — field selection, the request/response
 * lines, the trace context, the logger — is configured server-side when you bind it
 * with [`telemetry.server`](./server) from `@ayepi/otel/server`.
 *
 * ```ts
 * // shared.ts (frontend-safe)
 * import { telemetry } from '@ayepi/otel';
 * const tel = telemetry();
 * spec({ endpoints: { ...tel.group({ … }) } });
 *
 * // server.ts
 * import { telemetry } from '@ayepi/otel/server';
 * implement(api).middleware(telemetry.server(tel, { echoRequestId: true }));
 * ```
 *
 * @module
 */

import { middleware } from '@ayepi/core';
import type { AnyMiddleware, MiddlewareDef, EmptyObject } from '@ayepi/core';

/**
 * Options for the {@link telemetry} **def** — frontend-safe only.
 *
 * @typeParam R - middleware this one depends on (their context is typed in the
 *   server-side `extra`).
 */
export interface TelemetryDefOptions<R extends readonly AnyMiddleware[]> {
  /** Middleware name for docs/debugging, and the default value for the `name` field (default `'otel'`). */
  readonly name?: string;
  /** Middleware this one depends on — their context is available (and typed) in the server-side `extra`. */
  readonly requires?: R;
}

/**
 * Create a telemetry middleware **def** — a no-context, frontend-safe contract.
 * Bind its behaviour with [`telemetry.server(def, opts)`](./server).
 *
 * @typeParam R - inferred from `requires`.
 *
 * @example
 * ```ts
 * const tel = telemetry();                              // default name 'otel'
 * spec({ endpoints: { ...tel.group({ getUser }) } });
 * ```
 */
export function telemetry<const R extends readonly AnyMiddleware[] = readonly []>(opts?: TelemetryDefOptions<R>): TelemetryDef<R> {
  const name = opts?.name ?? 'otel';
  return middleware(name, { requires: (opts?.requires ?? []) as R });
}

/** The def type a {@link telemetry} call produces — what `telemetry.server` binds against. */
export type TelemetryDef<R extends readonly AnyMiddleware[] = readonly []> = MiddlewareDef<EmptyObject, R>;
