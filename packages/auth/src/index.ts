/**
 * # @ayepi/auth
 *
 * Authentication middleware **defs** for [`@ayepi/core`](https://www.npmjs.com/package/@ayepi/core):
 * **Bearer (JWT, HS256)** and **Basic** auth. This entry is **frontend-safe** — it
 * declares the contracts (contributed context + OpenAPI security schemes) with no
 * secrets and no `node:crypto`, so it is importable by a spec a browser build
 * consumes. Bind the implementations from [`@ayepi/auth/server`](./server).
 *
 * - {@link bearerAuth} — a `Authorization: Bearer <jwt>` def contributing
 *   `{ user, jwt, signToken }`; bind with `bearerAuth.server(def, { secret, claims, toUser })`.
 * - {@link basicAuth} — a `Authorization: Basic …` def contributing `{ user }`;
 *   bind with `basicAuth.server(def, { verify })`.
 *
 * The HS256 primitives `signJwt`/`verifyJwt` and the `.server` binders live in
 * `@ayepi/auth/server` (the only place importing `node:crypto`).
 *
 * @module
 */

export { bearerAuth } from './bearer';
export type { BearerDefOptions, BearerContext, BearerAuthDef, SignTokenOptions } from './bearer';

export { basicAuth } from './basic';
export type { BasicDefOptions, BasicContext, BasicAuthDef } from './basic';

export type { JwtPayload, StandardClaims } from './jwt';
