# @ayepi/node

Node.js adapter for [`@ayepi/core`](https://www.npmjs.com/package/@ayepi/core).
Bridges `node:http` `IncomingMessage`/`ServerResponse` to the web-standard
`Request`/`Response` ayepi speaks, and serves WebSocket upgrades via the
[`ws`](https://github.com/websockets/ws) package. (Node is the one runtime
without a built-in WebSocket server, which is why this adapter needs `ws`.)

```sh
pnpm add @ayepi/node @ayepi/core ws
```

```ts
import { serve } from '@ayepi/node'

const close = serve(app, { port: 3000, path: '/ws' })
process.on('SIGTERM', () => void close())
```

Bodies stream both ways without buffering, response writes respect backpressure,
and a client disconnect aborts your handler's `signal`. Also exports
`createRequestListener(app)` and `handleUpgrade(app, server, path)` for mounting
on an existing server.

See the [full documentation](https://github.com/pdiffenderfer/ayepi#running-it).

## For AI coding agents

This package ships dense, machine-oriented reference docs written for **AI coding agents**
(Claude Code, Cursor, and the like) to understand and drive the package — point your agent at them:

- [`ayepi-node.md`](./ayepi-node.md)

They ship with this package and also live in the [repo](https://github.com/ClickerMonkey/ayepi/tree/main/packages/node).

## License

MIT © Philip Diffenderfer
