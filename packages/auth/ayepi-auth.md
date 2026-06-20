<!--
ayepi-auth.md — reference for `@ayepi/auth`, written for coding agents.

Copy this file into any project that depends on `@ayepi/auth` (e.g. into your repo's
`docs/` or `.claude/` directory) and reference it from your agents and slash commands.
It documents the public API, the patterns the package expects, and how it works under the
hood, with copy-pasteable examples. Keep it in sync with the installed package version.
-->

# `@ayepi/auth` — Bearer (JWT) & Basic authentication

Authentication middleware for [`@ayepi/core`](https://www.npmjs.com/package/@ayepi/core).
Two guards, fully typed, each contributing its own OpenAPI **security scheme** to every
operation it protects:

- **`bearerAuth`** — verify a `Authorization: Bearer <jwt>` token (HS256), validate its
  custom claims with a zod schema, map them to a user, and expose
  `{ user, jwt, signToken }` to the handler.
- **`basicAuth`** — verify `Authorization: Basic <base64(user:pass)>` credentials and
  expose `{ user }`.
- **`signJwt` / `verifyJwt`** — standalone HS256 primitives (the bearer middleware is built
  on them) for use anywhere: queue workers, CLIs, other frameworks.

## Def / impl split & the two entry points

Each guard is a **def** + an **impl**, following the `@ayepi/core` middleware model:

- A **def** is the frontend-safe *contract*: the middleware's name, the context it
  contributes, its `requires` chain, and its OpenAPI security scheme. It holds **no** secret
  and pulls in **no** `node:crypto`. You declare it in your shared spec.
- An **impl** is the runtime binding: the secret, the claims schema, the `toUser` / `verify`
  mappers, and the actual verification + 401 logic. You bind it server-side.

These map onto two entry points:

| import                  | exports                                                                       | frontend-safe? |
| ----------------------- | ----------------------------------------------------------------------------- | -------------- |
| `@ayepi/auth`           | `bearerAuth` / `basicAuth` **def factories** (no secrets, no `node:crypto`)    | **yes**        |
| `@ayepi/auth/server`    | the same `bearerAuth` / `basicAuth` augmented with `.server(def, cfg)` binders, plus `signJwt` / `verifyJwt` / `JwtError` | **no** (pulls `node:crypto`) |

The flow is always:

1. **`shared.ts`** — `const auth = bearerAuth<Claims, User>()` (a def), build the spec with
   `auth.group(...)` / `auth.endpoint(...)`.
2. **`server.ts`** — `implement(api).middleware(bearerAuth.server(auth, { secret, claims, toUser }))`
   binds the impl. `bearerAuth.server(def, cfg)` returns the `{ def, impl }` pair
   `implement(api).middleware(...)` expects, reading `User` / `Claims` off the def so the
   config stays type-aligned with the contract.

A spec that imports only `@ayepi/auth` is therefore **frontend-safe** — the `.server` binder
and JWT crypto stay in `@ayepi/auth/server`, out of any browser bundle.

The only runtime dependencies are `@ayepi/core` and `zod` (both peers). JWT crypto uses
**`node:crypto` only** — no external JWT library, **HS256 only**.

See `ayepi-core-middleware.md` for how middleware defs, `requires`, stacks,
`.group()` / `.endpoint()`, and `implement(api).middleware(...)` work — `bearerAuth` /
`basicAuth` produce ordinary middleware defs that compose exactly like any other.

```sh
pnpm add @ayepi/auth @ayepi/core zod
```

## Bearer (JWT)

The def is declared frontend-safe, with explicit `Claims` / `User` type args. `Claims` is the
`z.infer` of your claims schema; `User` is whatever the server-side `toUser` returns:

```ts
// shared.ts (frontend-safe)
import { z } from 'zod'
import { spec } from '@ayepi/core'
import { bearerAuth } from '@ayepi/auth'

const Claims = z.object({ userId: z.string(), role: z.enum(['admin', 'member']) })
type Claims = z.infer<typeof Claims>
type User = { id: string; role: string }

const auth = bearerAuth<Claims, User>()   // def only — no secret, no node:crypto

export const api = spec({
  endpoints: {
    ...auth.group({
      me: { response: z.object({ id: z.string(), role: z.string() }) },
    }),
  },
})
```

The runtime — the secret, the claims schema, and the mappers — is bound server-side via
`bearerAuth.server(def, cfg)` and attached with `implement(api).middleware(...)`. The binder
reads `User` / `Claims` off the def, so the config can't drift from the contract:

```ts
// server.ts
import { implement, server } from '@ayepi/core'
import { bearerAuth } from '@ayepi/auth/server'

const app = server(api, [
  implement(api)
    .middleware(bearerAuth.server(auth, {
      secret: process.env.JWT_SECRET!,                        // HMAC secret (sign + verify)
      claims: Claims,                                         // must validate the def's Claims
      toUser: async (claims) => db.users.find(claims.userId), // null/undefined ⇒ 401
      expiresIn: 900,                                         // default lifetime for signToken (sec)
      issuer: 'my-api',                                       // optional: verified + minted as `iss`
      audience: 'web',                                        // optional: verified + minted as `aud`
      clockToleranceSec: 5,                                   // optional: leeway on exp/nbf
    }))
    .handlers({
      me: ({ user, jwt, signToken }) => {
        // user  : whatever toUser returned (type inferred from its return)
        // jwt   : the full decoded payload — custom claims ∪ { iss, sub, aud, exp, nbf, iat, jti }
        // signToken: mint a fresh token for the same claim shape
        const { token } = signToken({ userId: user.id, role: 'admin' }, { expiresIn: 60 })
        return { id: user.id, role: user.role }
      },
    }),
])
```

### Context contributed to the handler

A `bearerAuth` middleware adds three root keys to the handler payload:

| key         | type                                                                 | notes                                                            |
| ----------- | -------------------------------------------------------------------- | --------------------------------------------------------------- |
| `user`      | inferred from `toUser`'s return                                      | never nullish — a nullish `toUser` result already became a 401  |
| `jwt`       | `Claims & StandardClaims`                                            | the full decoded payload (custom claims ∪ registered claims)    |
| `signToken` | `(claims, opts?) => { token: string; payload: JwtPayload<Claims> }`  | mints a new HS256 token using the middleware's secret/iss/aud   |

`signToken(claims, { expiresIn })` applies the middleware's configured `issuer`/`audience`
and `expiresIn` default; the per-call `expiresIn` overrides the default for that call only.
It returns both the encoded `token` and the full decoded `payload` it carries.

### `toUser` and `claims`

Both are **server-side** config (`bearerAuth.server(def, { claims, toUser })`); neither
appears on the frontend-safe def.

- `claims` is a zod schema for the token's **custom** claims — everything *except* the
  registered claims `iss / sub / aud / exp / nbf / iat / jti`. The middleware splits those
  off before parsing, so your schema only describes your own fields. It must validate the
  def's `Claims` type (the binder enforces this).
- `toUser(claims, fullPayload, ctx)` receives the **validated** custom claims (`z.infer` of
  your schema), the full decoded payload, and the upstream middleware context (typed via the
  def's `requires`). Return a user (matching the def's `User`), or `null`/`undefined` to
  reject with `401`.
- Throwing from `toUser` also rejects: a thrown `JwtError` becomes a `401`; any other error
  propagates (and surfaces as the framework's normal `500`). Use this to fail closed on,
  say, a transient DB error vs. an explicit "no such user".

### Verification & rejection

On every request the middleware, in order:

1. **extracts the token** (default: `Authorization: Bearer <token>` header; **over ws**, a
   `?access_token=<token>` query param on the upgrade URL — see below). Missing ⇒ 401,
2. verifies the HS256 signature against `secret`,
3. checks `exp` / `nbf` with `clockToleranceSec` leeway,
4. checks `iss` / `aud` when those options are set,
5. parses the custom claims with `claims` (parse failure ⇒ 401),
6. calls `toUser` (nullish / `JwtError` ⇒ 401).

Any failure **short-circuits** with a `401` whose body is
`{ error: { code: 'UNAUTHORIZED', message } }` and a `WWW-Authenticate: Bearer` header.

### Authenticating over WebSocket

A browser **can't set headers on a WebSocket handshake**, so the bearer token can't ride
`Authorization` over ws. The default extractor therefore also reads a **`?access_token=`
query param** off the upgrade request when `io.transport === 'ws'`, and the client passes the
token there (`wsTransport(() => \`wss://…/ws?access_token=${token}\`)`, see
`ayepi-core-client.md`). `getToken` is a **server-side** option — override extraction entirely
with **`getToken(io)`** in the `.server` config, e.g. to read a subprotocol
(`io.req.headers.get('sec-websocket-protocol')`) or a cookie instead:

```ts
bearerAuth.server(auth, { secret, claims, toUser, getToken: (io) => io.req.headers.get('sec-websocket-protocol') ?? null })
```

This is what lets the **same** `bearerAuth` def protect HTTP endpoints *and* ws calls /
**event subscriptions** (`events: { ev: { …, guard: [auth] } }`). Mint tokens server-side at a
public REST `login` endpoint (`signJwt`); the client never signs.

## Basic

The def is frontend-safe (just `{ user }` + the `basicAuth` scheme); the `verify` credential
check and `realm` are bound server-side:

```ts
// shared.ts (frontend-safe)
import { spec } from '@ayepi/core'
import { basicAuth } from '@ayepi/auth'

const auth = basicAuth<{ id: string }>()   // def only

export const api = spec({
  endpoints: { ...auth.group({ stats: { response: StatsOut } }) },
})

// server.ts
import { implement } from '@ayepi/core'
import { basicAuth } from '@ayepi/auth/server'

implement(api).middleware(basicAuth.server(auth, {
  realm: 'Admin',                                  // shown in the browser dialog (default 'Restricted')
  verify: (username, password) =>
    username === 'root' && password === env.PW ? { id: 'root' } : null, // null/undefined ⇒ 401
}))
```

`basicAuth` exposes only `{ user }`. The header is decoded as
`base64(username:password)`; a password may itself contain `:` (only the first `:` splits).
Missing header, non-`Basic` scheme, a value with no `:`, a nullish `verify`, **or a throwing
`verify`** all reject with `401` + `WWW-Authenticate: Basic realm="<realm>"`. (Unlike
`bearerAuth`, a thrown `verify` does *not* propagate — Basic treats every failure as a 401.)

## Standalone JWT utilities

The HS256 primitives the bearer middleware is built on, usable anywhere. They live in
`@ayepi/auth/server` (the only entry pulling `node:crypto`) — **not** the frontend-safe
`@ayepi/auth` def entry:

```ts
import { signJwt, verifyJwt, JwtError } from '@ayepi/auth/server'

const { token, payload } = signJwt(
  { userId: 'u1', role: 'admin' },                 // custom claims
  { secret, expiresIn: 900, issuer: 'api', audience: 'web' },
)
// payload === { userId, role, iat, exp, iss, aud }  (iat = now, exp = iat + expiresIn)

try {
  const claims = verifyJwt<{ userId: string; role: string }>(token, {
    secret,
    issuer: 'api',          // optional: require matching iss
    audience: 'web',        // optional: require aud to equal / contain this
    clockToleranceSec: 5,   // optional: leeway on exp/nbf (default 0)
  })
} catch (err) {
  if (err instanceof JwtError) { /* malformed / mis-signed / expired / claim mismatch */ }
}
```

- `signJwt(claims, opts)` always sets `iat` to now and `exp` to `iat + (expiresIn ?? 3600)`.
  Caller-supplied registered claims (e.g. `sub`) are preserved; `iat`/`exp` always win. The
  default lifetime is **3600 seconds (1 hour)**.
- `verifyJwt(token, opts)` returns the decoded payload (`Claims & StandardClaims`) or throws
  a `JwtError`. It validates structure (3 segments), the `HS256` header `alg`, the signature
  (constant-time compare), then `exp` / `nbf` (with tolerance) and `iss` / `aud` when given.
  It does **not** run your zod schema — pair it with one when you need claim validation
  (the middleware does this for you).
- `verifyJwt` is the **only** thing that throws `JwtError`; signature compare is constant
  time via `crypto.timingSafeEqual`.

## OpenAPI security docs

Each middleware contributes a security scheme through `doc.security`, so every guarded
operation documents the requirement automatically:

```ts
const doc = app.openapi({ title: 'API', version: '1.0.0' })

doc.components.securitySchemes.bearerAuth // { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' }
doc.components.securitySchemes.basicAuth  // { type: 'http', scheme: 'basic' }
doc.paths['/me'].post.security            // [{ bearerAuth: [] }]
```

The scheme name is fixed (`bearerAuth` / `basicAuth`) and matches the `name` the framework
emits under `components.securitySchemes` + per-operation `security`. Because the scheme lives
on the **def**, these docs are available frontend-side too (no impl / secret needed to render
them). See `ayepi-core-middleware.md` (`MiddlewareDoc.security`) for the underlying mechanism.

## API reference

The **def factories** are on the main entry; the **`.server` binders** and the JWT primitives
are on `@ayepi/auth/server`.

### Def factories — `@ayepi/auth`

#### `bearerAuth<Claims, User, R>(opts?) => BearerAuthDef<Claims, User, R>`

Frontend-safe. Declares the `{ user, jwt, signToken }` context, the `requires` chain, and the
`bearerAuth` security scheme. `Claims` / `User` are supplied as explicit type args (`Claims` =
`z.infer` of your claims schema, `User` = the server-side `toUser`'s return); `opts` is
contract-only — **no** `secret`, `claims`, or `toUser` here.

| option     | type                          | default        | notes                                                  |
| ---------- | ----------------------------- | -------------- | ------------------------------------------------------ |
| `requires` | `readonly AnyMiddleware[]`    | `[]`           | upstream context, typed in the server-side `toUser`    |
| `name`     | `string`                      | `'bearerAuth'` | middleware name (debugging) + security-scheme name     |
| `doc`      | `MiddlewareDoc`               | bearer scheme  | override/extend the OpenAPI contribution               |

#### `basicAuth<User, R>(opts?) => BasicAuthDef<User, R>`

Frontend-safe. Declares the `{ user }` context, the `requires` chain, and the `basicAuth`
security scheme. `verify` / `realm` are **not** here.

| option     | type                          | default        | notes                                                  |
| ---------- | ----------------------------- | -------------- | ------------------------------------------------------ |
| `requires` | `readonly AnyMiddleware[]`    | `[]`           | upstream context, typed in the server-side `verify`    |
| `name`     | `string`                      | `'basicAuth'`  | middleware name (debugging) + security-scheme name     |
| `doc`      | `MiddlewareDoc`               | basic scheme   | override/extend the OpenAPI contribution               |

### Server binders — `@ayepi/auth/server`

#### `bearerAuth.server(def, cfg) => { def, impl }`

Binds a `bearerAuth` def to its runtime impl, returning the `{ def, impl }` pair for
`implement(api).middleware(...)`. `cfg`'s `claims`/`toUser` are type-aligned to the def's
`Claims`/`User`.

| option              | type                                                          | default        | notes                                            |
| ------------------- | ------------------------------------------------------------ | -------------- | ------------------------------------------------ |
| `secret`            | `string`                                                     | —              | HMAC secret for sign + verify (required)         |
| `claims`            | `z.ZodType<Claims>`                                          | —              | schema for the **custom** claims (required)      |
| `toUser`            | `(claims, payload, ctx) => User \| null \| undefined \| Promise<…>` | —        | nullish / `JwtError` ⇒ 401 (required)            |
| `expiresIn`         | `number` (seconds)                                          | `3600`         | default lifetime used by `signToken`             |
| `issuer`            | `string`                                                     | —              | verified on input, minted as `iss`              |
| `audience`          | `string`                                                     | —              | verified on input, minted as `aud`              |
| `clockToleranceSec` | `number`                                                     | `0`            | leeway on `exp` / `nbf`                          |
| `getToken`          | `(io) => string \| null \| undefined`                       | header → ws `?access_token=` | override token extraction (subprotocol, cookie, …) |

(`requires` and `name` come from the **def**, not this config.)

#### `basicAuth.server(def, cfg) => { def, impl }`

Binds a `basicAuth` def. `verify`'s return is type-aligned to the def's `User`.

| option     | type                                                       | default        | notes                                   |
| ---------- | ---------------------------------------------------------- | -------------- | --------------------------------------- |
| `verify`   | `(username, password, ctx) => User \| null \| undefined \| Promise<…>` | — | nullish / throw ⇒ 401 (required) |
| `realm`    | `string`                                                   | `'Restricted'` | advertised in `WWW-Authenticate`        |

#### `signJwt(claims, opts)` / `verifyJwt(token, opts)` / `JwtError`

See [Standalone JWT utilities](#standalone-jwt-utilities). Imported from `@ayepi/auth/server`.
`JwtPayload<Claims>` is `Claims & StandardClaims`; `StandardClaims` covers the seven
registered claims.

## Gotchas

- **Def vs. impl entry points.** Import the def factories from `@ayepi/auth` and the
  `.server` binders + JWT primitives from `@ayepi/auth/server`. A spec that imports only
  `@ayepi/auth` is frontend-safe; `@ayepi/auth/server` pulls `node:crypto` and must stay out
  of any browser bundle. `signJwt` / `verifyJwt` / `JwtError` moved to `@ayepi/auth/server` —
  they are **no longer** exported from the main entry.
- **HS256 only.** There is no RS256/ES256/`none` support — `signJwt` always signs HS256 and
  `verifyJwt` rejects any other (or missing) `alg`. The header is the single source of
  truth for the algorithm; an attacker cannot downgrade it.
- **Secret management.** The same `secret` signs and verifies, and lives only in the
  `.server` config — never in the def, never in a browser bundle. Keep it server-side and
  rotate deliberately (old tokens stop verifying when the secret changes — there is no
  built-in key-id / rotation window).
- **Custom vs. registered claims.** Your `claims` schema must describe only your own fields.
  The registered claims (`iss / sub / aud / exp / nbf / iat / jti`) are split off before
  parsing — putting them in your schema is redundant and `exp`/`iat` you set are overwritten
  by `signToken` / `signJwt`.
- **Reserved context keys.** The middleware context (`user`, `jwt`, `signToken` /
  `user`) must not collide with framework-owned payload names (`data`, `stream`, `headers`,
  `cookies`, `out`, `download`, `length`, `fail`, `status`, `header`, `cookie`, `req`,
  `signal`, `emit`). The chosen keys are clear of those; if you wrap or rename them, avoid
  the reserved set — the server throws at assembly time on a collision.
- **`WWW-Authenticate`.** A `401` is emitted as a short-circuit `Response` (not via
  `reject(...)`) precisely so the challenge header can be attached. Don't expect a thrown
  `ApiError` here — the chain returns a `Response` and skips the handler.
- **Header whitespace.** `Headers` already trims surrounding whitespace, so a bare `Bearer`
  (no token) fails the prefix check and 401s; you never receive an empty token.
- **No refresh / revocation.** This package verifies and mints stateless tokens. Refresh
  rotation, denylists, and session revocation are your application's concern — build them on
  top of `signToken` / `verifyJwt`.

## License

MIT © Philip Diffenderfer
