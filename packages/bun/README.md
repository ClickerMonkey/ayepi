# @ayepi/bun

[Bun](https://bun.sh) adapter for [`@ayepi/core`](https://www.npmjs.com/package/@ayepi/core).
Bun is fetch-native with a **built-in WebSocket server**, so this adapter has
**zero dependencies** — HTTP goes straight to `app.fetch` and Bun's websocket
handlers are wired to `app.ws.*`.

```sh
bun add @ayepi/bun @ayepi/core zod
```

```ts
import { serve } from '@ayepi/bun'

const close = serve(app, { port: 3000, path: '/ws' })
```

## For AI coding agents

This package ships dense, machine-oriented reference docs written for **AI coding agents**
(Claude Code, Cursor, and the like) to understand and drive the package — point your agent at them:

- [`ayepi-bun.md`](./ayepi-bun.md)

They live next to the source in the [repo](https://github.com/ClickerMonkey/ayepi/tree/main/packages/bun) and are **not** shipped in the npm tarball.

## License

MIT © Philip Diffenderfer
