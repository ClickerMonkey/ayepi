/**
 * # Errors
 *
 * The error envelope used on both sides of the wire. This module is deliberately
 * **zod-free** so it can be imported by the browser client without pulling zod
 * into the bundle.
 *
 * @module
 */

/**
 * A transport-level API error.
 *
 * Thrown server-side to short-circuit a request with a status + machine code,
 * and re-constructed client-side from an HTTP error envelope (`{ error: { code,
 * message } }`) or a ws response frame whose `$status` is not 2xx (`$error`/`$code`
 * + an optional typed `data` body), so the same `instanceof ApiError` check works
 * everywhere.
 *
 * @example
 * ```ts
 * try {
 *   await sdk.call('getUser', { id: 'nope' })
 * } catch (err) {
 *   if (err instanceof ApiError && err.status === 404) showNotFound()
 * }
 * ```
 */
export class ApiError extends Error {
  /**
   * @param status  HTTP (or ws-mapped) status code.
   * @param code    Stable machine-readable error code (e.g. `'UNAUTHORIZED'`).
   * @param message Optional human-readable message; defaults to `code`.
   * @param data    Optional structured payload — the parsed error body for
   *                declared typed errors, or the raw envelope otherwise.
   */
  constructor(
    readonly status: number,
    readonly code: string,
    message?: string,
    readonly data?: unknown,
  ) {
    super(message ?? code);
    this.name = 'ApiError';
  }
}

/**
 * Internal control-flow signal thrown by a handler's `fail()`.
 *
 * Carries an **already-validated** declared-error body so the server can emit it
 * verbatim with the declared status. Not part of the public surface.
 *
 * @internal
 */
export class ApiFailure extends Error {
  constructor(
    readonly status: number,
    readonly data: unknown,
  ) {
    super(`declared error ${status}`);
    this.name = 'ApiFailure';
  }
}

/**
 * Construct an {@link ApiError} to `throw` from a handler or middleware.
 *
 * @example
 * ```ts
 * const auth = middleware('auth', async (io) => {
 *   if (!io.req.headers.get('authorization')) throw reject(401, 'UNAUTHORIZED')
 *   return io.next()
 * })
 * ```
 */
export function reject(status: number, code: string, message?: string): ApiError {
  return new ApiError(status, code, message);
}
