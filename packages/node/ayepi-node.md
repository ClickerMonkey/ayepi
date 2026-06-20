<!--
ayepi-node.md — reference for `@ayepi/node`, written for coding agents.

Copy this file into any project that depends on `@ayepi/node` (e.g. into your repo's
`docs/` or `.claude/` directory) and reference it from your agents and slash commands.
It documents the public API, the patterns the package expects, and how it works under the
hood, with copy-pasteable examples. Keep it in sync with the installed package version.
-->

# `@ayepi/node`

`@ayepi/node` is a thin Node.js adapter for an [`@ayepi/core`](./ayepi-core.md)
`Server`. It bridges the `node:http` `IncomingMessage`/`ServerResponse` world to
the web-standard `Request`/`Response` that ayepi core speaks, and serves
WebSocket upgrades via the [`ws`](https://github.com/websockets/ws) package wired
to `app.ws.open`/`message`/`close`. Reach for it when you have an ayepi app
(built with `server(...)` from core) and want to run it on a real Node HTTP port
— with streaming bodies, backpressure, client-disconnect aborts, and WebSocket
transport all handled for you. This doc only covers **serving on Node**; for the
API itself (`spec`, `endpoint`, `server`, `client`, the `Server` surface), see
[`ayepi-core.md`](./ayepi-core.md).

```sh
pnpm add @ayepi/node @ayepi/core ws
```

`ws` is a direct runtime dependency of `@ayepi/node` (it ships in its
`dependencies`), so `pnpm add @ayepi/node` already pulls it in transitively.
Listing `ws` explicitly is only needed if your own code imports it (the tests do,
e.g. `import WebSocket from 'ws'` for a client). `@ayepi/core` is a peer
dependency you must install. Requires Node `>=18`. HTTP/1.1 only for v0.

## Public API

The package exports three functions and one options interface. Everything below
is the complete public surface — internal bridging helpers (`toRequest`,
`sendResponse`, `whenWritable`) are not exported.

### `serve(app, opts)`

Boot an ayepi app on a real HTTP + WebSocket port. This is the one function most
apps need.

```ts
function serve(app: Server<AnySpec>, opts: ServeOptions): () => Promise<void>
```

- `app` — an ayepi `Server` (the return value of `server(spec, handlers)` from
  `@ayepi/core`).
- `opts` — see [`ServeOptions`](#serveoptions) below.
- **Returns** a `close()` function: `() => Promise<void>`. Calling it stops
  accepting new connections, **terminates** every live WebSocket
  (`ws.terminate()`), closes the `WebSocketServer`, then closes the HTTP server,
  and resolves once shutdown completes (rejects if `server.close` errors).

Internally `serve` wires `createRequestListener(app)` as the HTTP listener and
`handleUpgrade(app, server, opts.path)` for WebSocket upgrades, then calls
`server.listen(opts.port, hostname, …)`.

### `ServeOptions`

```ts
interface ServeOptions {
  /** TCP port to listen on. */
  readonly port: number;
  /** Interface to bind (default: all interfaces). */
  readonly hostname?: string;
  /**
   * Restrict WebSocket upgrades to this pathname (e.g. '/ws'). When omitted,
   * upgrades are accepted on any path.
   */
  readonly path?: string;
  /** Called once the server is listening. */
  readonly onListen?: (info: { port: number; hostname: string }) => void;
}
```

| Option     | Type                                                  | Required | Default              | Notes |
|------------|-------------------------------------------------------|----------|----------------------|-------|
| `port`     | `number`                                              | yes      | —                    | Pass `0` to let the OS pick a free port; read the real port from `onListen`. |
| `hostname` | `string`                                              | no       | `'0.0.0.0'`          | The interface to bind. `'127.0.0.1'` for localhost-only. |
| `path`     | `string`                                              | no       | (any path)           | When set, only WebSocket upgrades on this exact pathname are accepted; others have their socket destroyed. Does **not** affect HTTP routing. |
| `onListen` | `(info: { port: number; hostname: string }) => void` | no       | —                    | Fires once the server is listening. `info.port` is the **actual** bound port (resolved from `server.address()`), which matters when `port: 0`. `info.hostname` echoes the bound hostname. |

### `createRequestListener(app)`

Create a `node:http` request listener for an ayepi app — useful for mounting on
an existing server, behind a proxy, or alongside other (non-ayepi) routes.

```ts
function createRequestListener(
  app: Server<AnySpec>,
): (req: http.IncomingMessage, res: http.ServerResponse) => void
```

Each request gets an `AbortController` whose signal aborts when the client
disconnects before the response finishes; that signal is the `signal` your
handlers receive. On a thrown error it responds `500` with
`{ error: { code: 'INTERNAL', message } }` if headers haven't been sent yet,
otherwise it just ends the (already-started) response.

### `handleUpgrade(app, server, path?)`

Attach an ayepi app's WebSocket handling to an existing `http.Server`'s
`upgrade` event.

```ts
function handleUpgrade(
  app: Server<AnySpec>,
  server: http.Server,
  path?: string,
): WebSocketServer
```

- Creates a `WebSocketServer({ noServer: true })` and listens on the server's
  `'upgrade'` event.
- `path` — when set, only upgrades whose pathname equals `path` are accepted;
  others have their socket destroyed.
- **Returns** the underlying `ws` `WebSocketServer` — call `.close()` to stop
  accepting upgrades.

Use `createRequestListener` + `handleUpgrade` together when you need to build the
`http.Server` yourself (custom TLS, mounting alongside other routes, etc.); use
`serve` when you don't.

## Examples

### Minimal serve

```ts
import { serve } from '@ayepi/node'
import { app } from './app' // your `server(spec, handlers)` from @ayepi/core

const close = serve(app, { port: 3000 })
```

### Custom port, hostname, and a WebSocket path

```ts
const close = serve(app, {
  port: 8080,
  hostname: '127.0.0.1', // localhost only
  path: '/ws',           // WS upgrades only on /ws
  onListen: ({ port, hostname }) => console.log(`listening on http://${hostname}:${port}`),
})
```

### Ephemeral port (let the OS choose)

```ts
serve(app, {
  port: 0,
  onListen: ({ port }) => {
    // `port` here is the real bound port, not 0
    console.log(`http://127.0.0.1:${port}`)
  },
})
```

### Graceful shutdown

```ts
const close = serve(app, { port: 3000, path: '/ws' })
process.on('SIGTERM', () => void close())
process.on('SIGINT', () => void close())
```

`close()` returns a promise, so you can `await` it before exiting:

```ts
process.on('SIGTERM', async () => {
  await close()
  process.exit(0)
})
```

### Mount on an existing `http.Server`

```ts
import http from 'node:http'
import { createRequestListener, handleUpgrade } from '@ayepi/node'

const server = http.createServer(createRequestListener(app))
const wss = handleUpgrade(app, server, '/ws')
server.listen(3000)

// to stop:
// wss.close(); server.close()
```

### Talking to it over WebSocket

The upgraded socket carries ayepi's own wire protocol. With the core client +
`wsTransport`, point it at the same `path`:

```ts
import { client, wsTransport } from '@ayepi/core'

const sdk = client<typeof api>({
  baseUrl: 'http://127.0.0.1:3000',
  manifest: api,
  ws: wsTransport('ws://127.0.0.1:3000/ws'),
})

await sdk.call('getUser', { id: 'u9' }, { transport: 'ws' })
```

Raw frames work too — a unary call frame looks like
`{ id, type: '/getUser/:id', method: 'POST', data: { id: 'u1' } }` and the reply
echoes the `id`. See the core docs for the full WS protocol.

## How it works under the hood

### `IncomingMessage` → `Request`

`toRequest(req, signal)` builds a web `Request`:

- **URL** is reconstructed as `${proto}://${host}${req.url}`, where `proto` is
  `https` if the socket is encrypted (`socket.encrypted`) else `http`, and `host`
  comes from the `host` header (falling back to `localhost`).
- **Headers** are copied into a `Headers` object; array-valued Node headers are
  `append`ed entry-by-entry so repeats survive.
- **Body** is attached only for methods other than `GET`/`HEAD`. It's wired as a
  streaming `ReadableStream` via `Readable.toWeb(req)`, with `duplex: 'half'`
  set on the `RequestInit` (required by undici when streaming a request body).
  This means request bodies are **not buffered** — they stream into your handler
  as the client sends them (e.g. a `MediaRecorder` → `fetch` audio upload, or an
  NDJSON frame stream).
- The per-request **`AbortSignal`** is passed through, so a client disconnect
  surfaces as the `signal` your handler sees.

### `Response` → `ServerResponse`

`sendResponse(res, response)` streams the fetch `Response` back out:

- Sets `res.statusCode` from `response.status`.
- Copies response headers, with special handling for **`set-cookie`**: it uses
  `response.headers.getSetCookie()` so multiple `Set-Cookie` values are preserved
  as separate headers rather than being folded into one comma-joined value.
- If there's no body, calls `res.end()` immediately.
- Otherwise reads `response.body` chunk-by-chunk and writes each to `res`,
  honoring **backpressure**: when `res.write(value)` returns `false`, it awaits
  `whenWritable(res)` (which resolves on the next `'drain'` or on socket
  `'close'`) before continuing. This keeps memory flat on large streamed
  downloads.
- If the socket closes mid-stream, the reader is cancelled
  (`res.once('close', …) => reader.cancel()`). If the upstream stream throws
  mid-flight, the response is truncated (the error is swallowed and `res.end()`
  is called in `finally`).

Because the body is streamed, all of core's streaming response shapes work over
the wire: NDJSON (`application/x-ndjson`) item streams, SSE (`text/event-stream`),
raw byte downloads with `Content-Length`/`Content-Disposition`, and HTTP `Range`
→ `206` partial responses — all handled by core; the adapter just pumps bytes.

### Client-disconnect → abort

In `createRequestListener`, each request gets an `AbortController`. A
`res.on('close')` listener fires `ac.abort()` **only if** the response didn't
finish normally (`!res.writableFinished`). That aborted signal is the same
`signal` core hands your handler, so a handler awaiting a long operation (or a
generator producing a stream) can observe the disconnect and stop.

### WebSocket upgrades (`ws`)

`handleUpgrade` listens on the HTTP server's `'upgrade'` event:

- If `path` is set and the request pathname doesn't match, the socket is
  `destroy()`ed (the upgrade is refused).
- Otherwise `wss.handleUpgrade(...)` completes the handshake, and for each opened
  socket:
  - The upgrade request is converted with `toRequest(req, …)` and handed to
    `app.ws.open(send, request)`. Because the **upgrade `Request` (with its
    headers) is passed through**, subscription guards / auth in core can
    authenticate from it.
  - `send` writes a frame back via `ws.send(frame)` only when
    `ws.readyState === ws.OPEN`.
  - Inbound `'message'` frames are stringified (`String(data)`) and forwarded to
    `app.ws.message(conn, …)`.
  - `'close'` and `'error'` both call `app.ws.close(conn)`.

WebSocket inbound frames are treated as **text** (`String(data)`) — the protocol
is JSON text frames, not binary.

## Gotchas / constraints

- **HTTP/1.1 only** for v0. No HTTP/2 / HTTP/3.
- **`ws` is required for WebSockets.** Node is the one runtime without a built-in
  WebSocket server, which is why this adapter depends on `ws`. It ships as a
  direct dependency, so you don't normally install it yourself.
- **Default bind is `0.0.0.0`** (all interfaces). For localhost-only, set
  `hostname: '127.0.0.1'` explicitly.
- **`path` only gates WebSocket upgrades**, not HTTP routing. HTTP requests are
  always routed by core regardless of `path`.
- **`close()` is hard on WebSockets**: it calls `ws.terminate()` on every live
  client (immediate, no close handshake), not `ws.close()`. In-flight WS work is
  cut off.
- **`port: 0` picks an ephemeral port** — read the actual port from
  `onListen({ port })`, not from your config. `serve` resolves it via
  `server.address()`.
- **Request bodies are skipped for `GET`/`HEAD`** (per spec). Any other method
  gets a streaming body with `duplex: 'half'`.
- **Errors after headers are sent** can't become a `500` — the response is
  already in flight, so the adapter just ends it (truncating). Only pre-header
  errors produce the `{ error: { code: 'INTERNAL', … } }` body.
- **`set-cookie` relies on `Headers.getSetCookie()`** (Node 18.14+/undici). On
  the supported Node `>=18` range this is available; on very old 18.x patch
  versions multiple cookies could fold incorrectly.

## See also

- [`ayepi-core.md`](./ayepi-core.md) — the API itself: `spec`, `endpoint`,
  `implement`, `server`, `client`, `wsTransport`, the `Server` surface
  (`fetch`, `ws.open`/`message`/`close`, `emit`), streaming, and the WS wire
  protocol. This `@ayepi/node` doc is only about running that `Server` on Node.
