# @ayepi/auth

Authentication middleware for [`@ayepi/core`](https://www.npmjs.com/package/@ayepi/core):
**Bearer (JWT, HS256)** and **Basic** auth, fully typed, each contributing its own OpenAPI
security scheme. JWT crypto is dependency-free (`node:crypto`, HS256 only).

Each guard is split into a **def** (a frontend-safe contract you declare in your spec) and an
**impl** (the server-side binding that supplies secrets and crypto):

- **`@ayepi/auth`** — frontend-safe def factories `bearerAuth` / `basicAuth`. No secrets, no
  `node:crypto`. Safe to import from a spec a browser build consumes.
- **`@ayepi/auth/server`** — the same `bearerAuth` / `basicAuth` augmented with a
  `.server(def, cfg)` binder, plus the `signJwt` / `verifyJwt` / `JwtError` primitives. This
  is the **only** entry that pulls in `node:crypto`; keep it out of the frontend bundle.

```sh
pnpm add @ayepi/auth @ayepi/core zod
```

## Bearer (JWT)

In your shared (frontend-safe) module you declare the **def** with explicit `Claims` / `User`
type args, then build the spec around it:

```ts
import { z } from 'zod'
import { spec } from '@ayepi/core'
import { bearerAuth } from '@ayepi/auth'

const Claims = z.object({ userId: z.string(), role: z.enum(['admin', 'member']) })
type Claims = z.infer<typeof Claims>
type User = { id: string; role: string }

const auth = bearerAuth<Claims, User>()   // def only — no secret, frontend-safe

export const api = spec({ endpoints: { ...auth.group({ me: { response: UserOut } }) } })
```

On the server you bind the **impl** via `bearerAuth.server(def, cfg)` and attach it with
`implement(api).middleware(...)`. The binder reads `User` / `Claims` from the def, so the
config stays type-aligned with the contract:

```ts
import { implement, server } from '@ayepi/core'
import { bearerAuth } from '@ayepi/auth/server'

const app = server(api, [
  implement(api)
    .middleware(bearerAuth.server(auth, {
      secret: process.env.JWT_SECRET!,
      claims: Claims,
      toUser: (c) => db.users.find(c.userId),   // null/undefined ⇒ 401
      expiresIn: 900,
      issuer: 'my-api',
    }))
    .handlers({
      me: ({ user, jwt, signToken }) => {
        const { token } = signToken({ userId: user.id, role: 'admin' }, { expiresIn: 60 })
        return { id: user.id, role: user.role }
      },
    }),
])
```

The middleware verifies the HS256 signature + `exp`/`nbf` (with tolerance) + `iss`/`aud`,
validates the custom claims, and resolves a user — then the handler gets `{ user, jwt, signToken }`.

`signToken` mints a fresh HS256 token (applying the configured secret/issuer/audience and
expiry default, with an optional per-call `expiresIn` override) and returns the token plus
the full decoded payload. `jwt` is the full payload: custom claims ∪ the registered claims
(`iss / sub / aud / exp / nbf / iat / jti`).

Failures (missing/malformed header, bad signature, expired, claim mismatch, nullish/throwing
`toUser`) short-circuit with `401` + `WWW-Authenticate: Bearer`.

## Basic

The def is frontend-safe; the credential check is bound server-side:

```ts
// shared.ts (frontend-safe)
import { basicAuth } from '@ayepi/auth'

const auth = basicAuth<{ id: string }>()
export const api = spec({ endpoints: { ...auth.group({ stats: { response: StatsOut } }) } })

// server.ts
import { basicAuth } from '@ayepi/auth/server'

implement(api).middleware(basicAuth.server(auth, {
  realm: 'Admin',
  verify: (user, pass) => (user === 'root' && pass === env.PW ? { id: 'root' } : null),
}))
```

The handler gets `{ user }`. Bad/missing/non-`Basic` credentials (or a nullish/throwing
`verify`) yield `401` + `WWW-Authenticate: Basic realm="…"`.

## Standalone JWT utils

The HS256 primitives the bearer middleware is built on, usable anywhere — imported from the
**`/server`** entry (they pull in `node:crypto`):

```ts
import { signJwt, verifyJwt, JwtError } from '@ayepi/auth/server'

const { token, payload } = signJwt({ userId: 'u1' }, { secret, expiresIn: 900, issuer: 'api' })
const claims = verifyJwt<{ userId: string }>(token, { secret, issuer: 'api', clockToleranceSec: 5 })
// verifyJwt throws JwtError on malformed / mis-signed / expired / claim-mismatch tokens
```

`signJwt` sets `iat` to now and `exp` to `iat + (expiresIn ?? 3600)`. `verifyJwt` checks
structure, the `HS256` alg, the signature (constant-time), then `exp`/`nbf`/`iss`/`aud`.

## OpenAPI security docs

Each def contributes a scheme automatically (the contract lives on the def, so the docs are
available frontend-side too):

```ts
const doc = app.openapi({ title: 'API', version: '1.0.0' })
doc.components.securitySchemes.bearerAuth // { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' }
doc.components.securitySchemes.basicAuth  // { type: 'http', scheme: 'basic' }
doc.paths['/me'].post.security           // [{ bearerAuth: [] }]
```

## Notes

- **Def vs. impl.** A spec that imports `@ayepi/auth` is frontend-safe — the `.server` binder
  and JWT crypto stay in `@ayepi/auth/server`, out of the browser bundle.
- **HS256 only**, **`node:crypto` only** — no external JWT library.
- Keep `secret` server-side; rotating it invalidates existing tokens (no key-id window).
- Your `claims` schema describes only custom claims — registered claims are handled for you.

For the full reference (typed context, every rejection branch, gotchas), see
[`ayepi-auth.md`](./ayepi-auth.md) and `ayepi-core-middleware.md`.

## License

MIT © Philip Diffenderfer
