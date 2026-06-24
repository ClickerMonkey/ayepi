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

## For AI coding agents

This package ships dense, machine-oriented reference docs written for **AI coding agents**
(Claude Code, Cursor, and the like) to understand and drive the package — point your agent at them:

- [`ayepi-deno.md`](./ayepi-deno.md)

They ship with this package and also live in the [repo](https://github.com/ClickerMonkey/ayepi/tree/main/packages/deno).

## License

MIT © Philip Diffenderfer
