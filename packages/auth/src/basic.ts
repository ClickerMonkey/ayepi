/**
 * # Basic auth — middleware **def**
 *
 * The frontend-safe contract for HTTP `Basic` authentication: its name, the
 * `{ user }` context it contributes, its dependencies, and the `basicAuth` OpenAPI
 * security scheme. The credential check (`verify`) and the 401 challenge live in
 * the implementation bound via [`basicAuth.server`](../server) from
 * `@ayepi/auth/server`.
 *
 * @module
 */

import { middleware, ctx } from '@ayepi/core';
import type { AnyMiddleware, MiddlewareDoc } from '@ayepi/core';

/**
 * The context a {@link basicAuth} middleware contributes to the handler payload.
 *
 * @typeParam User - the user type produced by `verify`.
 */
export interface BasicContext<User> {
  /** The authenticated user, as returned by `verify`. */
  readonly user: User;
}

/** The OpenAPI security scheme contributed by {@link basicAuth}. */
const BASIC_DOC: MiddlewareDoc = { security: { basicAuth: { type: 'http', scheme: 'basic' } } };

/**
 * Options for the {@link basicAuth} **def** — frontend-safe only.
 *
 * @typeParam R - middleware this one depends on (their context is typed in the
 *   server-side `verify`).
 */
export interface BasicDefOptions<R extends readonly AnyMiddleware[]> {
  /** Middleware this one depends on — their context is available (and typed) in `verify`. */
  readonly requires?: R;
  /** Middleware name for docs/debugging (default `'basicAuth'`). */
  readonly name?: string;
  /** Override/extend the OpenAPI contributions (defaults to the `basicAuth` HTTP-basic scheme). */
  readonly doc?: MiddlewareDoc;
}

/**
 * Create a Basic authentication middleware **def**.
 *
 * The def declares what the middleware contributes (`{ user }`), its dependencies,
 * and the OpenAPI security scheme. Bind the runtime with
 * [`basicAuth.server(def, { verify, realm })`](../server).
 *
 * @typeParam User - the authenticated user type `verify` produces.
 * @typeParam R    - inferred from `requires`.
 *
 * @example
 * ```ts
 * // shared.ts (frontend-safe)
 * const auth = basicAuth<{ id: string }>();
 * const api = spec({ endpoints: { ...auth.group({ stats: { response: StatsOut } }) } });
 *
 * // server.ts
 * implement(api).middleware(basicAuth.server(auth, {
 *   realm: 'Admin',
 *   verify: (user, pass) => (user === 'root' && pass === env.PW ? { id: 'root' } : null),
 * }));
 * ```
 */
export function basicAuth<User, const R extends readonly AnyMiddleware[] = readonly []>(opts?: BasicDefOptions<R>) {
  const name = opts?.name ?? 'basicAuth';
  const doc = opts?.doc ?? BASIC_DOC;
  return middleware(name, { provides: ctx<BasicContext<User>>(), requires: (opts?.requires ?? []) as R, doc });
}

/** The def type a {@link basicAuth} call produces — what `basicAuth.server` binds against. */
export type BasicAuthDef<User, R extends readonly AnyMiddleware[] = readonly []> = ReturnType<typeof basicAuth<User, R>>;
