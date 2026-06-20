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

## License

MIT © Philip Diffenderfer
