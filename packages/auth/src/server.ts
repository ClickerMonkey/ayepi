/**
 * # @ayepi/auth/server — middleware **impl** binders (node)
 *
 * The server half of `@ayepi/auth`: it binds a frontend-safe auth **def** (from
 * `@ayepi/auth`) to its runtime implementation, supplying secrets, the claims
 * schema, and the user mapper. This is the only entry that pulls `node:crypto`
 * (via {@link signJwt}/{@link verifyJwt}), so it must never be imported by a spec
 * a frontend build consumes.
 *
 * - {@link bearerAuth.server | bearerAuth.server(def, { secret, claims, toUser })}
 *   binds a {@link bearerAuth} def, reading its `User`/`Claims` types so the config
 *   stays aligned with the contract.
 * - {@link basicAuth.server | basicAuth.server(def, { verify, realm })} binds a
 *   {@link basicAuth} def.
 * - {@link signJwt} / {@link verifyJwt} — the standalone HS256 primitives.
 *
 * @module
 */

import type {
  AnyMiddleware,
  BoundMiddleware,
  ImplFor,
  MiddlewareIO,
  MiddlewareResult,
  StackCtx,
} from '@ayepi/core';
import type { z } from 'zod';
import { bearerAuth as bearerAuthDef } from './bearer';
import type { BearerContext, SignTokenOptions } from './bearer';
import { basicAuth as basicAuthDef } from './basic';
import type { BasicContext } from './basic';
import { signJwt, verifyJwt, customClaimsOf, JwtError } from './jwt';
import type { JwtPayload, JwtError as JwtErrorType } from './jwt';

/* ---- shared constants ---- */
/** HTTP status used for every authentication failure. */
const UNAUTHORIZED = 401;
/** Stable machine code attached to auth rejections. */
const UNAUTHORIZED_CODE = 'UNAUTHORIZED';
/** Length of the `'Bearer '` prefix in an `Authorization` header value. */
const BEARER_PREFIX = 'Bearer ';
/** The `WWW-Authenticate` challenge sent on a bearer 401. */
const WWW_AUTHENTICATE = 'Bearer';
/** Query-param name the default extractor reads over ws (browsers can't set the upgrade's `Authorization` header). */
const QUERY_TOKEN_PARAM = 'access_token';
/** The `Authorization` scheme prefix basic auth accepts. */
const BASIC_PREFIX = 'Basic ';
/** Default realm advertised in the basic `WWW-Authenticate` challenge. */
const DEFAULT_REALM = 'Restricted';

/* ---- type extractors: read a def's contributed types so the config aligns ---- */
/** The `requires` chain of a middleware def. */
type ReqOf<M extends AnyMiddleware> = M['__req'];
/** The `User` type a {@link bearerAuth} def contributes. */
type BearerUserOf<M> = M extends { readonly __p: BearerContext<infer U, infer _C extends object> } ? U : never;
/** The custom-`Claims` type a {@link bearerAuth} def contributes. */
type BearerClaimsOf<M> = M extends { readonly __p: BearerContext<infer _U, infer C extends object> } ? C : never;
/** The `User` type a {@link basicAuth} def contributes. */
type BasicUserOf<M> = M extends { readonly __p: BasicContext<infer U> } ? U : never;

/* ---- bearer ---- */
/**
 * Server-side options for binding a {@link bearerAuth} def — the secrets and
 * runtime mappers, typed against the def's own `User`/`Claims`.
 *
 * @typeParam M - the bearer def being bound.
 */
export interface BearerServerOptions<M extends AnyMiddleware> {
  /** HMAC secret for signing and verifying tokens. Keep it server-side and rotate carefully. */
  readonly secret: string;
  /** Zod schema for the token's custom (non-registered) claims — must validate the def's `Claims`. */
  readonly claims: z.ZodType<BearerClaimsOf<M>>;
  /**
   * Map validated custom claims (and the full payload) to a user. Returning a
   * nullish value — or throwing — yields a 401.
   */
  readonly toUser: (
    claims: BearerClaimsOf<M>,
    payload: JwtPayload<BearerClaimsOf<M>>,
    ctx: StackCtx<ReqOf<M>>,
  ) => BearerUserOf<M> | null | undefined | Promise<BearerUserOf<M> | null | undefined>;
  /** Default token lifetime in seconds for `signToken` (default 1h). */
  readonly expiresIn?: number;
  /** Expected/issued `iss` claim. When set, verification requires a matching issuer. */
  readonly issuer?: string;
  /** Expected/issued `aud` claim. When set, verification requires a matching audience. */
  readonly audience?: string;
  /** Leeway in seconds for `exp`/`nbf` checks (default `0`). */
  readonly clockToleranceSec?: number;
  /**
   * Extract the raw token from a request. Default: `Authorization: Bearer <t>`
   * header, with a `?access_token=<t>` query-param fallback over **ws** (browsers
   * can't header-authenticate a ws handshake). Return `null`/`undefined` for "no
   * token" → a 401.
   */
  readonly getToken?: (io: MiddlewareIO<StackCtx<ReqOf<M>>>) => string | null | undefined;
}

/** Build the 401 short-circuit response, advertising the `Bearer` challenge. */
function bearerUnauthorized(message: string): Response {
  return new Response(JSON.stringify({ error: { code: UNAUTHORIZED_CODE, message } }), {
    status: UNAUTHORIZED,
    headers: { 'content-type': 'application/json', 'www-authenticate': WWW_AUTHENTICATE },
  });
}

/**
 * Default token extractor: an `Authorization: Bearer <token>` header (any
 * transport) and, over **ws**, a `?access_token=<token>` query param on the
 * upgrade URL — because browsers can't set headers on a WebSocket handshake.
 */
function defaultGetToken(io: MiddlewareIO<object>): string | null {
  const header = io.req.headers.get('authorization');
  if (header !== null && header.startsWith(BEARER_PREFIX)) {return header.slice(BEARER_PREFIX.length);}
  if (io.transport === 'ws') {
    const value = new URL(io.req.url, 'http://ws.local').searchParams.get(QUERY_TOKEN_PARAM);
    if (value) {return value;}
  }
  return null;
}

/** Bind a {@link bearerAuth} def to its runtime impl. */
function bearerServer<M extends AnyMiddleware>(def: M, cfg: BearerServerOptions<M>): BoundMiddleware<M> {
  type Claims = BearerClaimsOf<M>;
  type User = BearerUserOf<M>;

  const makeSignToken = (): BearerContext<User, Claims>['signToken'] => {
    return (claims: Claims, signOpts?: SignTokenOptions) =>
      signJwt<Claims>(claims, {
        secret: cfg.secret,
        expiresIn: signOpts?.expiresIn ?? cfg.expiresIn,
        issuer: cfg.issuer,
        audience: cfg.audience,
      });
  };

  const run = async (io: MiddlewareIO<StackCtx<ReqOf<M>>>): Promise<Response | MiddlewareResult<BearerContext<User, Claims>>> => {
    const token = (cfg.getToken ?? defaultGetToken)(io);
    if (token === null || token === undefined) {return bearerUnauthorized('missing or malformed credentials');}

    let payload: JwtPayload<Claims> & Record<string, unknown>;
    try {
      payload = verifyJwt<Claims>(token, {
        secret: cfg.secret,
        issuer: cfg.issuer,
        audience: cfg.audience,
        clockToleranceSec: cfg.clockToleranceSec,
      }) as JwtPayload<Claims> & Record<string, unknown>;
    } catch (err) {
      // verifyJwt only ever throws JwtError — every failure here is an auth failure.
      return bearerUnauthorized((err as JwtErrorType).message);
    }

    const parsed = cfg.claims.safeParse(customClaimsOf(payload));
    if (!parsed.success) {return bearerUnauthorized('invalid token claims');}
    const claims = parsed.data;
    const full: JwtPayload<Claims> = { ...payload, ...claims };

    let user: User | null | undefined;
    try {
      user = await cfg.toUser(claims, full, io.ctx);
    } catch (err) {
      if (err instanceof JwtError) {return bearerUnauthorized(err.message);}
      throw err;
    }
    if (user === null || user === undefined) {return bearerUnauthorized('user not found');}

    return io.next({ user, jwt: full, signToken: makeSignToken() });
  };

  return { def, impl: run as unknown as ImplFor<M> }; // internal cast: the precise typed run presented as the def's bound impl
}

/**
 * The {@link bearerAuth} def factory, augmented with a `.server(def, cfg)` binder.
 * Import from `@ayepi/auth/server` in your server entry to bind a def created in a
 * frontend-safe spec.
 */
export const bearerAuth = Object.assign(bearerAuthDef, { server: bearerServer });

/* ---- basic ---- */
/**
 * Server-side options for binding a {@link basicAuth} def.
 *
 * @typeParam M - the basic def being bound.
 */
export interface BasicServerOptions<M extends AnyMiddleware> {
  /**
   * Validate a username/password pair. Returning a nullish value — or throwing —
   * yields a 401.
   */
  readonly verify: (
    username: string,
    password: string,
    ctx: StackCtx<ReqOf<M>>,
  ) => BasicUserOf<M> | null | undefined | Promise<BasicUserOf<M> | null | undefined>;
  /** Realm shown in the browser auth dialog / `WWW-Authenticate` header (default `'Restricted'`). */
  readonly realm?: string;
}

/** Build the 401 short-circuit response, advertising the `Basic` challenge with its realm. */
function basicUnauthorized(realm: string, message: string): Response {
  return new Response(JSON.stringify({ error: { code: UNAUTHORIZED_CODE, message } }), {
    status: UNAUTHORIZED,
    headers: { 'content-type': 'application/json', 'www-authenticate': `Basic realm="${realm}"` },
  });
}

/** Decode an `Authorization: Basic …` header into `[username, password]`, or `null`. */
function readBasicCredentials(req: Request): [string, string] | null {
  const header = req.headers.get('authorization');
  if (header === null || !header.startsWith(BASIC_PREFIX)) {return null;}
  const encoded = header.slice(BASIC_PREFIX.length).trim();
  // Buffer's base64 decoder is lenient and never throws on malformed input.
  const decoded = Buffer.from(encoded, 'base64').toString('utf8');
  const sep = decoded.indexOf(':');
  if (sep === -1) {return null;}
  return [decoded.slice(0, sep), decoded.slice(sep + 1)];
}

/** Bind a {@link basicAuth} def to its runtime impl. */
function basicServer<M extends AnyMiddleware>(def: M, cfg: BasicServerOptions<M>): BoundMiddleware<M> {
  type User = BasicUserOf<M>;
  const realm = cfg.realm ?? DEFAULT_REALM;

  const run = async (io: MiddlewareIO<StackCtx<ReqOf<M>>>): Promise<Response | MiddlewareResult<BasicContext<User>>> => {
    const creds = readBasicCredentials(io.req);
    if (creds === null) {return basicUnauthorized(realm, 'missing or malformed Authorization header');}

    let user: User | null | undefined;
    try {
      user = await cfg.verify(creds[0], creds[1], io.ctx);
    } catch {
      return basicUnauthorized(realm, 'invalid credentials');
    }
    if (user === null || user === undefined) {return basicUnauthorized(realm, 'invalid credentials');}

    return io.next({ user });
  };

  return { def, impl: run as unknown as ImplFor<M> }; // internal cast: the precise typed run presented as the def's bound impl
}

/**
 * The {@link basicAuth} def factory, augmented with a `.server(def, cfg)` binder.
 * Import from `@ayepi/auth/server` in your server entry.
 */
export const basicAuth = Object.assign(basicAuthDef, { server: basicServer });

/* ---- standalone JWT primitives (node:crypto) ---- */
export { signJwt, verifyJwt, JwtError } from './jwt';
export type { SignJwtOptions, VerifyJwtOptions, JwtPayload, StandardClaims } from './jwt';
