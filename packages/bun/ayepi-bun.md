<!--
ayepi-bun.md — reference for `@ayepi/bun`, written for coding agents.

Copy this file into any project that depends on `@ayepi/bun` (e.g. into your repo's
`docs/` or `.claude/` directory) and reference it from your agents and slash commands.
It documents the public API, the patterns the package expects, and how it works under the
hood, with copy-pasteable examples. Keep it in sync with the installed package version.
-->

# `@ayepi/bun`

A thin [Bun](https://bun.sh) adapter that boots an [`@ayepi/core`](./ayepi-core.md) `Server`
on Bun's built-in HTTP + WebSocket server. Bun is fetch-native and ships a native WebSocket
server, so this adapter has **zero dependencies**: HTTP requests go straight to `app.fetch`,
and Bun's `websocket` handlers are wired to `app.ws.open` / `message` / `close`. Use it when
your runtime is Bun and you want the smallest possible glue between an ayepi app and a live
listening socket. The app itself (endpoints, events, validation) is defined entirely with
`@ayepi/core` — see [`ayepi-core.md`](./ayepi-core.md); this package only owns the transport.

```sh
bun add @ayepi/bun @ayepi/core zod
```

```ts
import { serve } from '@ayepi/bun'

const close = serve(app, { port: 3000, path: '/ws' })
```

## Public API

The package exports exactly two symbols: the `serve` function and its `ServeOptions` type.

### `serve(app, opts)`

```ts
export function serve(app: Server<AnySpec>, opts: ServeOptions): () => void
```

- **`app`** — any `@ayepi/core` `Server` (i.e. `Server<AnySpec>`), the value returned by
  core's `server(...)`. The adapter only touches its `fetch` and `ws` surface.
- **`opts`** — see [`ServeOptions`](#serveoptions) below.
- **Returns** a `close()` function. Calling it stops the server via
  `server.stop(true)` — i.e. Bun is told to close **active connections** too, not just stop
  accepting new ones. Call it for graceful shutdown.

`serve` reads the ambient `Bun` global at runtime. If it is missing (you are not running
under Bun), it throws immediately:

```
@ayepi/bun: not running under Bun (no global `Bun`)
```

### `ServeOptions`

```ts
export interface ServeOptions {
  /** TCP port to listen on. */
  readonly port: number;
  /** Interface to bind. */
  readonly hostname?: string;
  /** Restrict WebSocket upgrades to this pathname (e.g. `'/ws'`). */
  readonly path?: string;
  /** Called once the server is listening. */
  readonly onListen?: (info: { port: number; hostname: string }) => void;
}
```

| Option     | Type                                                   | Required | Meaning |
| ---------- | ------------------------------------------------------ | -------- | ------- |
| `port`     | `number`                                               | yes      | TCP port to listen on. Use `0` to let the OS pick a free port (the real port is reported to `onListen` and is the `port` field of the value Bun returns internally). |
| `hostname` | `string`                                               | no       | Interface to bind (e.g. `'0.0.0.0'`, `'127.0.0.1'`). Defaults to Bun's default when omitted. |
| `path`     | `string`                                               | no       | Restrict WebSocket upgrades to this exact pathname (e.g. `'/ws'`). When omitted, **any** path with an `Upgrade: websocket` header is upgraded. Non-WS requests are never affected by this. |
| `onListen` | `(info: { port: number; hostname: string }) => void`  | no       | Invoked once, synchronously, right after the server starts. Receives the **actual** bound `port` and `hostname` (resolved from Bun, so a `port: 0` request reports the chosen port). |

## Examples

### Minimal serve

```ts
import { serve } from '@ayepi/bun'
import { app } from './app' // your @ayepi/core Server

serve(app, { port: 3000 })
```

### Options: bind address, fixed WS path, listen callback

```ts
serve(app, {
  port: 8080,
  hostname: '0.0.0.0',
  path: '/ws',
  onListen: ({ port, hostname }) => console.log(`listening on ${hostname}:${port}`),
})
```

### Ephemeral port + graceful shutdown

```ts
let actualPort = 0
const close = serve(app, {
  port: 0,
  onListen: ({ port }) => { actualPort = port },
})

// later, e.g. on SIGTERM:
process.on('SIGTERM', () => close()) // stops the server and closes active connections
```

### WebSocket

There is no extra wiring for WebSockets here — define the events on the core `spec` and the
adapter forwards frames automatically. Just point clients at the upgrade path:

```ts
serve(app, { port: 3000, path: '/ws' })

// browser / Bun client:
const ws = new WebSocket('ws://localhost:3000/ws')
ws.onmessage = (e) => console.log(e.data) // core call/event frames (JSON strings)
```

The frame protocol (call frames, event subscriptions, reply shape) is defined and validated
by `@ayepi/core` — see [`ayepi-core.md`](./ayepi-core.md). The adapter is transport-only.

## How it works under the hood

`serve` calls `Bun.serve({ port, hostname, fetch, websocket })` once and returns
`() => server.stop(true)`.

### `fetch` — HTTP and the upgrade gate

```ts
fetch(req, srv) {
  const isWs = req.headers.get('upgrade')?.toLowerCase() === 'websocket';
  if (isWs && (opts.path === undefined || new URL(req.url).pathname === opts.path)) {
    const data: ConnData = { req };
    if (srv.upgrade(req, { data })) { return undefined; } // upgraded — Bun takes over
    return new Response('WebSocket upgrade failed', { status: 400 });
  }
  return app.fetch(req);
}
```

- A request is treated as a WebSocket upgrade only when the `Upgrade` header equals
  `websocket` (case-insensitive) **and** the path matches `opts.path` (or `opts.path` is
  unset). When `opts.path` is set, the comparison is against `new URL(req.url).pathname` —
  an **exact** string match, no prefix or pattern matching.
- On a match it calls `srv.upgrade(req, { data })`, attaching a per-connection `ConnData`
  object (`{ req, conn? }`) that carries the original upgrade `Request` into the WS handlers.
  - If `upgrade` returns `true`, the handler returns `undefined` and Bun owns the socket.
  - If `upgrade` returns `false`, the handler returns `400 WebSocket upgrade failed`.
- Anything else (normal HTTP, or a `websocket` upgrade on a non-matching path) is handed
  straight to `app.fetch(req)` and the resulting `Response` is returned unchanged. Streaming
  responses produced by core flow through untouched — the adapter never buffers or rewrites
  the body.

### `websocket` — Bun's native handler object

The adapter supplies the three Bun WebSocket lifecycle handlers and bridges them to
`app.ws.*`. Each upgraded socket carries the `ConnData` set at upgrade time as `ws.data`.

```ts
websocket: {
  open(ws) {
    const data = ws.data as ConnData;
    data.conn = app.ws.open((frame) => {
      if (ws.readyState === WS_OPEN) { ws.send(frame); } // WS_OPEN === 1
    }, data.req);
  },
  message(ws, message) {
    const data = ws.data as ConnData;
    if (data.conn) {
      void app.ws.message(
        data.conn,
        typeof message === 'string' ? message : new TextDecoder().decode(message),
      );
    }
  },
  close(ws) {
    const data = ws.data as ConnData;
    if (data.conn) { app.ws.close(data.conn); }
  },
}
```

- **`open`** registers the connection with core via `app.ws.open(send, req)`, passing the
  original upgrade `Request` so core can read headers/URL for auth or context. The `send`
  callback writes a core frame back to the socket, but only when `ws.readyState === 1`
  (`WebSocket.OPEN`), guarding against sends to a closing/closed socket. The returned
  `WsConn` is stashed on `data.conn`.
- **`message`** forwards each inbound frame to `app.ws.message(conn, raw)`. Bun may deliver
  the payload as a `string`, `ArrayBuffer`, or `Uint8Array`; binary payloads are decoded to a
  UTF-8 string with `new TextDecoder()` before being handed to core, which always works on
  text frames. `app.ws.message` is async; its promise is intentionally fire-and-forget
  (`void`).
- **`close`** tears the connection down via `app.ws.close(conn)`, which cleans up its
  subscriptions in core. Both `message` and `close` no-op if `data.conn` was never set (i.e.
  a frame arrived before/without a successful `open`).

## Gotchas / constraints

- **Bun only.** `serve` throws synchronously if the `Bun` global is absent. Running it under
  Node, Deno, or the browser fails fast with `not running under Bun`. The package's own
  TypeScript typechecks under plain `tsc` (it declares minimal structural interfaces for the
  Bun APIs), but it only *runs* under Bun. (Tests mock the `Bun` global to exercise the glue
  under vitest.)
- **`path` is an exact match.** `path: '/ws'` upgrades only `/ws`, not `/ws/foo` or `/ws?x=1`
  query-stripped beyond the pathname. Omit `path` to accept upgrades on any route.
- **`onListen` is synchronous and one-shot.** It fires immediately after `Bun.serve` returns.
  There is no error callback; bind failures surface as a thrown error from `Bun.serve`.
- **`close()` is forceful.** It calls `server.stop(true)`, which closes active connections
  (including open WebSockets) rather than draining them. There is no "stop accepting, drain
  in-flight" mode exposed.
- **No options pass-through.** Only `port`, `hostname`, `path`, and `onListen` are accepted.
  Bun-specific `Bun.serve` features (TLS, `unix` sockets, `idleTimeout`, custom
  `websocket.perMessageDeflate`, etc.) are not surfaced by this adapter.
- **Binary frames are coerced to text.** Inbound binary WS messages are UTF-8 decoded before
  reaching core; core's frame protocol is text/JSON, so binary payloads must be valid UTF-8
  text frames.

## See also

- [`ayepi-core.md`](./ayepi-core.md) — the framework itself: `spec`, `endpoint`, `server`,
  the `Server` interface (`fetch`, `ws`, `emit`, `manifest`, `openapi`, `asyncapi`), the
  WebSocket frame protocol, and validation. This adapter documents only the Bun transport.
