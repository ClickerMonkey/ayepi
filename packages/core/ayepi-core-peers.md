<!--
ayepi-core-peers.md — reference for `@ayepi/core`, written for coding agents.

Copy this file into any project that depends on `@ayepi/core` (e.g. into your repo's
`docs/` or `.claude/` directory) and reference it from your agents and slash commands.
It documents the public API, the patterns the package expects, and how it works under the
hood, with copy-pasteable examples. Keep it in sync with the installed package version.
-->

# `@ayepi/core` — peers: two-way calls on one socket

A WebSocket connection carries calls in **both directions**. The connecting side (a `client`) calls the
server's spec as usual, and it also **serves a spec of its own** that the server calls back on the same
connection. Each direction is ordinary ayepi request/response: typed data and results, declared errors,
validation, middleware, typed item streams both ways, multi-status results, cancellation, and events.

Use it when the side that connects is the one that does the work: an agent hub calling the systems that
connected to it, a coordinator calling its workers, a server pushing jobs to a client that can't be dialled.

```
            connecting side                           accepting side
   ┌──────────────────────────────┐         ┌──────────────────────────────┐
   │ client<HubLink>({ ws, serve })│  one ws │ server(hubLink, [impl],       │
   │   sdk.call('hello', …)  ─────────────────▶   { peers: systems })         │
   │ serve: server(systemLink, …) ◀───────────── systems.of(conn).call('run')│
   └──────────────────────────────┘         └──────────────────────────────┘
```

Events stay what they are: notifications that need no reply (`app.emit` → `sdk.on`, and in the other
direction, the served spec's `emit` → `peer.on`).

## The pieces

| Side | What | Role |
|---|---|---|
| both | two specs, e.g. `hubLink` and `systemLink` | plain `spec()` declarations (frontend-safe); one per direction |
| accepting | `peers(systemLink)` → `Peers<typeof systemLink>` | the registry: one typed `Peer` per open connection |
| accepting | `server(hubLink, [impl], { peers })` | routes the reverse frames to the registry and opens/closes peers with connections |
| connecting | `server(systemLink, [impl])` | the served spec's handlers; it needs no listener |
| connecting | `client<typeof hubLink>({ ws, serve })` | calls the hub, and runs the hub's calls through `serve` |

## A complete example

```ts
// link.ts — shared, frontend-safe
import { z } from 'zod'
import { spec, endpoint } from '@ayepi/core'

export const hubLink = spec({ endpoints: {
  hello: endpoint({ body: z.object({ name: z.string() }), response: z.object({ welcome: z.string() }) }),
  progress: endpoint({ body: z.object({ run: z.string(), pct: z.number() }) }),
} })

export const systemLink = spec({ endpoints: {
  run: endpoint({
    body: z.object({ fn: z.string(), args: z.record(z.string(), z.unknown()) }),
    response: z.object({ out: z.string() }),
    errors: { 422: z.object({ reason: z.string() }) },
  }),
  tail: endpoint({ body: z.object({ path: z.string() }), streamOut: z.object({ line: z.string() }) }),
}, events: {
  changed: { params: z.object({ uri: z.string() }), data: z.object({ version: z.number() }) },
} })
```

```ts
// hub.ts — the accepting side
import { implement, server, peers } from '@ayepi/core'
import { serve } from '@ayepi/node'
import { hubLink, systemLink } from './link'

const systems = peers(systemLink)            // typed against the spec the systems serve

const app = server(hubLink, [implement(hubLink).handlers({
  hello: async ({ data, conn }) => {
    const peer = systems.of(conn!)           // the caller, ready to be called back
    void peer.call('run', { fn: 'warmup', args: {} })
    return { welcome: `hi ${data.name}` }
  },
  progress: ({ data }) => console.log(data.run, data.pct),
})], { peers: systems })

systems.onOpen((peer) => console.log('connected', peer.conn.id))
systems.onClose((peer) => console.log('gone', peer.conn.id))   // its open calls have already settled

serve(app, { port: 4000, path: '/link', heartbeat: 15_000 })
```

```ts
// system.ts — the connecting side
import WebSocket from 'ws'
import { client, implement, server, wsTransport, type WebSocketCtor } from '@ayepi/core'
import { hubLink, systemLink } from './link'

let hub: ReturnType<typeof client<typeof hubLink>>

const local = server(systemLink, [implement(systemLink).handlers({
  run: async ({ data, fail, signal }) => {
    if (data.fn === 'nope') fail(422, { reason: 'unknown fn' })
    await hub.call('progress', { run: data.fn, pct: 50 })     // call back while serving
    return { out: `ran ${data.fn}` }
  },
  tail: async function* ({ data, signal }) {
    yield { line: `start ${data.path}` }
  },
})])

const ws = wsTransport('ws://hub:4000/link', { WebSocket: WebSocket as unknown as WebSocketCtor })
hub = client<typeof hubLink>({ baseUrl: 'http://hub:4000', manifest: hubLink, ws, serve: local, prefer: 'ws' })

ws.onState((s) => { if (s === 'open') void hub.call('hello', { name: 'fs' }) })   // greet on every (re)connect
```

## `peers(remote, options?)` and `Peers<R>`

```ts
function peers<R extends AnySpec>(remote: R | Manifest, options?: PeersOptions): Peers<R>

interface PeersOptions {
  /** Parse every result and stream item with the spec's schemas (default true when given the spec). */
  readonly validate?: boolean
}

class Peers<R extends AnySpec> {
  of(conn: WsConn): Peer<R>                    // throws when the connection is closed or unknown
  get(conn: WsConn): Peer<R> | undefined
  readonly size: number                        // open connections
  [Symbol.iterator](): IterableIterator<Peer<R>>
  onOpen(listener: (peer: Peer<R>) => void): () => void
  onClose(listener: (peer: Peer<R>) => void): () => void
}
```

- Pass the **spec** (results are validated, the hub trusts nothing it didn't parse) or its **manifest**
  with `R` given explicitly: `peers<typeof systemLink>(manifest)`.
- A spec with HTTP-only endpoints (file uploads, raw byte streams) is a **compile error** naming them,
  and throws: a peer call can only travel over the socket.
- One registry serves any number of connections, and may be shared by several servers.

## `Peer<R>`

```ts
interface Peer<R extends AnySpec> {
  readonly conn: WsConn
  readonly open: boolean
  readonly signal: AbortSignal                 // aborts (reason: ApiError(0, 'DISCONNECTED')) on close
  call<K extends PeerKeys<R>>(name: K, ...args: PeerCallArgs<R['endpoints'][K]>): CallReturn<R['endpoints'][K]>
  on: ApiClient<R>['on']                       // subscribe to the connecting side's events
}

type PeerCallOpts<E> = { readonly signal?: AbortSignal } & /* `stream` for streaming-input endpoints */
```

`peer.call` has exactly the argument and result types of `sdk.call` (`PeerCallArgs` and `CallArgs` share
one derivation), minus the options that only make sense over HTTP: there is no `transport`, `headers` or
`onUploadProgress`.

```ts
const peer = systems.of(conn)
await peer.call('run', { fn: 'read', args: {} })                  // Promise<{ out: string }>
for await (const l of peer.call('tail', { path: 'a.log' })) …     // typed item stream
await peer.call('run', data, { signal: AbortSignal.timeout(30_000) })
peer.on('changed', { uri: 'fs://a' }, (d) => d.version)
```

Errors reject exactly as for `sdk.call`: a declared error is an `ApiError` whose `data` is the typed
body (`err.status === 422`, `err.data.reason`), a thrown error is `500 INTERNAL`, bad input is
`400 VALIDATION`, and with `validate` on a result that does not match the spec rejects with the
`ZodError`.

## The handler's `conn`

Every handler receives `conn?: WsConn`, the connection the call arrived on (absent over HTTP and for
in-process calls). `peers.of(conn)` turns it into the caller's `Peer`. Middleware sees the same
connection as `io.ws.conn`.

## `ClientOptions.serve`

```ts
interface ClientOptions {
  // …
  readonly ws?: ClientWs
  readonly serve?: Serves      // { readonly ws: Server<AnySpec>['ws'] } — any assembled server
}
```

The client hands every frame of a call the server makes to `serve` on **one virtual connection**. It
opens on the first such frame and closes whenever the transport leaves `'open'` (via
`ClientWs.onState`), which aborts the served handlers' `signal`s and clears the served spec's
subscriptions. The virtual connection's `req` is a `GET` of `baseUrl`. A client without `serve` answers
each call the server makes with `501 NOT_SERVED`, so the server's `peer.call` rejects at once.

The `serve` option is a type-only port: the `@ayepi/core/client` entry stays zod-free (the served
server, which you build, brings zod).

## Connections, drops and reconnects

A call lives on **one connection** and settles **exactly once**: with its result, its error, or, when the
connection closes first, with `ApiError(0, 'DISCONNECTED')`.

| Event | Accepting side | Connecting side |
|---|---|---|
| connection opens | `onOpen(peer)` | the transport reports `'open'` |
| connection drops | every open `peer.call` rejects `DISCONNECTED`; `peer.signal` aborts; handlers serving the client's calls see their `signal` abort; `onClose(peer)` | every open `sdk.call` over ws rejects `DISCONNECTED` (from `wsTransport`); handlers serving the server's calls see their `signal` abort, and their late replies are dropped |
| a call on a closed peer | rejects `DISCONNECTED` at once | (fail-fast or queued, per `wsTransport({ whileDisconnected })`) |
| reconnect | a **new** connection with a **new** `Peer`; the old one stays closed | a new served connection; greet again (e.g. on `onState('open')`) |

Nothing is replayed across connections: what a dropped call was doing is the application's to resume
(by an id it chose). Pair the accepting side with a heartbeat (`@ayepi/node`'s `serve({ heartbeat })`)
so a peer that vanished without closing is noticed within two intervals; the connecting side's
`wsTransport` heartbeat covers the other direction.

## Wire format

Frames of calls the **connecting** side makes carry `id`; frames of calls the **accepting** side makes
carry `rid` (`REVERSE_ID`). Each side numbers only its own calls, so the two can never collide. A `rid`
frame is otherwise the ordinary frame of the ws protocol:

```jsonc
// accepting → connecting
{ "rid": "c1", "type": "/run", "method": "POST", "data": { "fn": "read" } }   // a call
{ "rid": "c2", "chunk": { "v": 1 } }   { "rid": "c2", "end": true }          // item-stream upload
{ "rid": "c1", "abort": true }                                                // cancel
{ "rid": "c3", "sub": "changed", "params": { "uri": "fs://a" } }              // subscribe

// connecting → accepting
{ "rid": "c1", "$status": 200, "data": { "out": "…" } }                       // reply (errors: $status/$code/$error)
{ "rid": "c2", "chunk": { "v": 10 } }  { "rid": "c2", "end": true }           // item-stream reply
{ "rid": null, "type": "changed", "params": { "uri": "fs://a" }, "data": { "version": 2 } }   // pushed event
```

A server without `peers` answers a `rid` frame `400 BAD_FRAME`. `DISCONNECTED_STATUS` (`0`) is the status
of every locally settled call.

## Exported symbols

`peers`, `Peers`, `peerHost`, `REVERSE_ID`, `DISCONNECTED_STATUS`, and the types `Peer`, `PeerKeys`,
`PeersOptions`, `PeerListener`, `PeerHost` (the port a server drives), `PeerSource`, `Serves`,
`PeerCallOpts`, `PeerCallArgs`. `Serves` is also exported from `@ayepi/core/client`.
