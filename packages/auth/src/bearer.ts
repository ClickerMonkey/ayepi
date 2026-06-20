/**
 * # Bearer (JWT) auth — middleware **def**
 *
 * The frontend-safe contract for a Bearer/JWT authentication middleware: its name,
 * the `{ user, jwt, signToken }` context it contributes, its dependencies, and the
 * `bearerAuth` OpenAPI security scheme. No secrets, no `node:crypto` — those live
 * in the implementation bound via [`bearerAuth.server`](../server) from
 * `@ayepi/auth/server`.
 *
 * Declare the def in your shared spec with explicit `Claims`/`User` type args:
 *
 * ```ts
 * const auth = bearerAuth<Claims, User>();
 * ```
 *
 * @module
 */

import { middleware, ctx } from '@ayepi/core';
import type { AnyMiddleware, MiddlewareDoc } from '@ayepi/core';
import type { JwtPayload, StandardClaims } from './jwt';

/** The OpenAPI security-scheme name this middleware registers. */
const SCHEME_NAME = 'bearerAuth';

/** The OpenAPI security scheme contributed by {@link bearerAuth}. */
const BEARER_DOC: MiddlewareDoc = {
  security: { [SCHEME_NAME]: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' } },
};

/**
 * Per-call options for {@link BearerContext.signToken}: override the lifetime of
 * the freshly minted token without touching the middleware-level defaults.
 */
export interface SignTokenOptions {
  /** Override the token lifetime in seconds for this call only. */
  readonly expiresIn?: number;
}

/**
 * The context a {@link bearerAuth} middleware contributes to the handler payload.
 *
 * @typeParam User   - the user type produced by `toUser`.
 * @typeParam Claims - the validated custom-claim shape.
 */
export interface BearerContext<User, Claims extends object> {
  /** The authenticated user, as returned by `toUser`. */
  readonly user: User;
  /** The full decoded JWT payload (custom claims ∪ standard claims). */
  readonly jwt: JwtPayload<Claims>;
  /**
   * Mint a fresh HS256 token for the given custom claims using the middleware's
   * configured secret/issuer/audience and (default or overridden) expiry.
   *
   * @returns the encoded token plus the full decoded payload it carries.
   */
  readonly signToken: (claims: Claims, opts?: SignTokenOptions) => { token: string; payload: JwtPayload<Claims> };
}

/**
 * Options for the {@link bearerAuth} **def** — frontend-safe only.
 *
 * @typeParam R - middleware this one depends on (their context is typed in the
 *   server-side `toUser`).
 */
export interface BearerDefOptions<R extends readonly AnyMiddleware[]> {
  /** Middleware this one depends on — their context is available (and typed) in `toUser`. */
  readonly requires?: R;
  /** Middleware name for docs/debugging (default `'bearerAuth'`). */
  readonly name?: string;
  /** Override/extend the OpenAPI contributions (defaults to the `bearerAuth` HTTP-bearer scheme). */
  readonly doc?: MiddlewareDoc;
}

/**
 * Create a Bearer/JWT authentication middleware **def**.
 *
 * The def declares what the middleware contributes (`{ user, jwt, signToken }`),
 * its dependencies, and the OpenAPI security scheme — but **no** secret or crypto.
 * Bind the runtime with [`bearerAuth.server(def, { secret, claims, toUser })`](../server).
 *
 * @typeParam Claims - the custom-claim shape (e.g. `z.infer<typeof Claims>`).
 * @typeParam User   - the authenticated user type `toUser` produces.
 * @typeParam R      - inferred from `requires`.
 *
 * @example
 * ```ts
 * // shared.ts (frontend-safe)
 * const auth = bearerAuth<Claims, User>();
 * const api = spec({ endpoints: { ...auth.group({ me: { response: UserOut } }) } });
 *
 * // server.ts
 * implement(api).middleware(bearerAuth.server(auth, {
 *   secret: process.env.JWT_SECRET!,
 *   claims: Claims,
 *   toUser: (c) => db.users.find(c.userId),
 * }));
 * ```
 */
export function bearerAuth<Claims extends object, User, const R extends readonly AnyMiddleware[] = readonly []>(
  opts?: BearerDefOptions<R>,
) {
  const name = opts?.name ?? SCHEME_NAME;
  const doc = opts?.doc ?? BEARER_DOC;
  return middleware(name, { provides: ctx<BearerContext<User, Claims>>(), requires: (opts?.requires ?? []) as R, doc });
}

/** The def type a {@link bearerAuth} call produces — what `bearerAuth.server` binds against. */
export type BearerAuthDef<Claims extends object, User, R extends readonly AnyMiddleware[] = readonly []> = ReturnType<
  typeof bearerAuth<Claims, User, R>
>;

export type { JwtPayload, StandardClaims };
