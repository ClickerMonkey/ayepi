<!--
ayepi-deno.md — reference for `@ayepi/deno`, written for coding agents.

Copy this file into any project that depends on `@ayepi/deno` (e.g. into your repo's
`docs/` or `.claude/` directory) and reference it from your agents and slash commands.
It documents the public API, the patterns the package expects, and how it works under the
hood, with copy-pasteable examples. Keep it in sync with the installed package version.
-->

# `@ayepi/deno`

`@ayepi/deno` is a thin [Deno](https://deno.com) adapter that boots an
[`@ayepi/core`](./ayepi-core.md) `Server` on Deno's built-in HTTP and WebSocket
runtime. Deno is fetch-native and upgrades WebSockets with the built-in
`Deno.upgradeWebSocket`, so this adapter has **zero dependencies** — plain HTTP
requests go straight to `app.fetch(req)`, and an upgraded socket is wired to the
`app.ws.open` / `message` / `close` lifecycle hooks. Use it when your ayepi server
runs under Deno (Deploy, `deno run`, etc.). It does **not** define your API — you
build the `Server` with `@ayepi/core` and hand it to `serve`.

Import it under Deno via the `npm:` specifier (see the package README):

```ts
import { serve } from 'npm:@ayepi/deno'
import { server } from 'npm:@ayepi/core'
```

The `Deno` global is read at runtime, so this package typechecks under plain
`tsc` in a Node toolchain but must be **executed under Deno** (>= 1.40.0).

## Public API

The package exports exactly two symbols: the `serve` function and its
`ServeOptions` type. Nothing else is public.

### `serve(app, opts)`

```ts
export function serve(app: Server<AnySpec>, opts: ServeOptions): () => Promise<void>
```

Boots `app` on Deno's built-in HTTP + WebSocket server (`Deno.serve`). Throws
immediately if there is no global `Deno` (i.e. you are not running under Deno):

```
@ayepi/deno: not running under Deno (no global `Deno`)
```

- `app` — any `@ayepi/core` `Server` (`Server<AnySpec>`). See
  [`ayepi-core.md`](./ayepi-core.md) for how to build one with `server(...)`.
- `opts` — a `ServeOptions` object (below).

**Returns** a `close()` function: `() => Promise<void>`. Calling it invokes the
underlying `Deno.serve` handle's `shutdown()` and resolves once the server has
finished shutting down. Use it for graceful shutdown.

### `ServeOptions`

```ts
export interface ServeOptions {
  /** TCP port to listen on. */
  readonly port: number
  /** Interface to bind. */
  readonly hostname?: string
  /** Restrict WebSocket upgrades to this pathname (e.g. '/ws'). */
  readonly path?: string
  /** Called once the server is listening. */
  readonly onListen?: (info: { port: number; hostname: string }) => void
}
```

| Option     | Type                                                  | Required | Behavior |
| ---------- | ----------------------------------------------------- | -------- | -------- |
| `port`     | `number`                                              | yes      | TCP port passed to `Deno.serve`. Use `0` to let the OS pick a free port. |
| `hostname` | `string`                                              | no       | Interface to bind. Passed through to `Deno.serve`; Deno's default applies when omitted. |
| `path`     | `string`                                              | no       | If set, only requests whose `URL.pathname` equals this value are upgraded to WebSocket; all other requests fall through to `app.fetch`. If omitted, **any** request carrying an `upgrade: websocket` header is upgraded, regardless of path. |
| `onListen` | `(info: { port: number; hostname: string }) => void`  | no       | Forwarded to `Deno.serve`'s `onListen`. Fires once when the server is listening; `info.port` reflects the actual bound port (useful with `port: 0`). |

## Examples

### Minimal serve

```ts
import { serve } from 'npm:@ayepi/deno'
import { server, spec, endpoint, implement } from 'npm:@ayepi/core'
import { z } from 'npm:zod'

const api = spec({
  endpoints: {
    getUser: endpoint({
      params: z.object({ id: z.string() }),
      response: z.object({ id: z.string(), name: z.string() }),
    }),
  },
})

const app = server(api, [
  implement(api).handlers({
    getUser: ({ data }) => ({ id: data.id, name: `u-${data.id}` }),
  }),
])

serve(app, { port: 3000 })
```

### Options: bind a host, restrict WS path, log on listen

```ts
serve(app, {
  port: 8080,
  hostname: '0.0.0.0',
  path: '/ws', // only /ws upgrades; everything else → app.fetch
  onListen: ({ hostname, port }) => {
    console.log(`listening on http://${hostname}:${port}`)
  },
})
```

### Ephemeral port

```ts
serve(app, {
  port: 0, // OS picks a free port
  onListen: ({ port }) => console.log('bound to', port),
})
```

### Graceful shutdown

```ts
const close = serve(app, { port: 3000, path: '/ws' })

// e.g. on SIGINT/SIGTERM
Deno.addSignalListener('SIGINT', async () => {
  await close() // resolves once the server has fully shut down
  Deno.exit(0)
})
```

### WebSocket

WebSocket handling is entirely automatic — there is no WS-specific API on the
adapter. Define your events/streams in the spec and connect from any client; the
adapter routes frames through `app.ws.*` for you:

```ts
// server: just enable WS upgrades on a path
serve(app, { port: 3000, path: '/ws' })
```

```ts
// client (browser / Deno): connect to the same path
const ws = new WebSocket('ws://localhost:3000/ws')
// ayepi call frames are sent/received as JSON text frames; use the
// @ayepi/core client to drive this — see ayepi-core.md.
```

## How it works under the hood

`serve` is glue between Deno's runtime and the `@ayepi/core` `Server` interface
(`app.fetch` plus the `app.ws` lifecycle hooks). The full flow:

1. **Reads the `Deno` global** at call time. If absent, it throws
   `@ayepi/deno: not running under Deno`.
2. **Registers one `Deno.serve` handler** with `{ port, hostname, onListen }`.
   The `onListen` callback is forwarded straight through.
3. **Per-request branch.** The handler inspects the incoming `Request`:
   - It is treated as a WebSocket upgrade when the `upgrade` header equals
     `websocket` (case-insensitive) **and** (`opts.path` is unset **or**
     `new URL(req.url).pathname === opts.path`).
   - Otherwise the request is forwarded to `app.fetch(req)`, which returns the
     `Promise<Response>` (this is the entire HTTP surface — REST endpoints,
     streaming responses, OpenAPI, etc., all handled by core).
4. **WebSocket upgrade.** For an upgrade, it calls `Deno.upgradeWebSocket(req)`,
   which yields `{ socket, response }`. The adapter returns `response` (the 101
   switching-protocols response) and wires the native socket's events:
   - `socket.onopen` → `conn = app.ws.open(send, req)`, where `send` writes a
     frame back via `socket.send(frame)` — but only while
     `socket.readyState === 1` (`WebSocket.OPEN`), so frames emitted after the
     socket closes are silently dropped.
   - `socket.onmessage` → `app.ws.message(conn, String(ev.data))`. The frame data
     is coerced to a string; the returned promise is fire-and-forgotten (`void`).
   - `socket.onclose` and `socket.onerror` → both call `app.ws.close(conn)`,
     which tears down the connection's subscriptions in core. An error is treated
     as a close.
   - All four handlers guard on `conn` being non-null, so events that race ahead
     of `onopen` are ignored.
5. **Streaming.** The adapter does nothing special for streaming — it returns the
   `Response` from `app.fetch` verbatim. Streaming response bodies (e.g.
   `ReadableStream`) are produced by core and streamed by Deno's HTTP server
   natively.
6. **Shutdown.** The returned `close()` awaits the `Deno.serve` handle's
   `shutdown()`.

## Gotchas / constraints

- **Must run under Deno.** Importing the package is fine anywhere, but calling
  `serve` without a global `Deno` throws. There is no Node fallback — use the
  Node adapter for Node.
- **`npm:` specifier.** Under Deno, import as `npm:@ayepi/deno` (and
  `npm:@ayepi/core`), not a bare specifier, unless you have an import map.
- **`path` is an exact pathname match.** `path: '/ws'` matches only `/ws`, not
  `/ws/` or `/ws/foo`. Query strings are ignored (only `URL.pathname` is
  compared). Omit `path` to upgrade any path that sends an upgrade header.
- **Upgrade detection is header-based.** A request is upgraded purely on the
  `upgrade: websocket` header (plus the optional path filter). A request to your
  WS path *without* that header falls through to `app.fetch`.
- **Text frames only.** Inbound frame data is passed through `String(...)`; the
  adapter assumes ayepi's JSON text-frame protocol. Binary frames are stringified,
  which is not meaningful for this protocol.
- **Post-close sends are dropped, not errors.** Because `send` checks
  `readyState === OPEN`, a late `app.ws` emit after the socket closed is a no-op
  rather than a throw.
- **`onerror` closes the connection.** A socket error is treated identically to a
  clean close (`app.ws.close(conn)`); there is no separate error callback exposed.
- **No CORS/middleware here.** Those live in `@ayepi/core`'s `server(...)` options
  — this adapter is transport only.

## See also

- [`ayepi-core.md`](./ayepi-core.md) — the actual API: `spec`, `endpoint`,
  `implement`, `server`, the `Server` interface (`fetch`, `ws`, `emit`,
  `openapi`, `asyncapi`), and the WebSocket call-frame protocol. This adapter
  only transports what core defines.
