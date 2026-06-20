# @ayepi/deno

[Deno](https://deno.com) adapter for [`@ayepi/core`](https://www.npmjs.com/package/@ayepi/core).
Deno is fetch-native and upgrades WebSockets with the built-in
`Deno.upgradeWebSocket`, so this adapter has **zero dependencies** — HTTP goes
straight to `app.fetch` and the upgraded socket is wired to `app.ws.*`.

```ts
import { serve } from 'npm:@ayepi/deno'
import { server } from 'npm:@ayepi/core'

const close = serve(app, { port: 3000, path: '/ws' })
```

## License

MIT © Philip Diffenderfer
