# @ayepi/plugin

A plugin system for [`@ayepi/core`](../core). Compose an API from independent
**plugins** — each a frontend-safe spec, its server implementation, an exported
**state** service, lifecycle hooks, and a `requires` list — and install/uninstall
them **into a running server**.

```sh
pnpm add @ayepi/plugin @ayepi/core zod
```

## What a plugin is

A plugin bundles five things:

- **`spec`** — the frontend-safe API contract (a normal `spec()`).
- **`.handlers` / `.middleware`** — its handlers + middleware bindings (chained on the builder).
- **`state`** — a service object (functions + data) that *dependent* plugins call
  directly, with no HTTP and no middleware (the "better private functions").
- **`.lifecycle`** — `up` / `down` (drain) / `stop` (teardown) hooks.
- **`requires`** — the plugins it depends on, available in its **context**.

`plugin({ name, requires, spec, state })` returns a **builder**; chain ctx-aware
`.middleware` / `.handlers` / `.lifecycle` (mirroring core's `implement()`). Each
callback receives a dependency **context** (`ctx`): `ctx.deps.<name>` exposes each
required plugin's `state` service, a typed in-process `call` for its endpoints, and an
`emit` for its events; `ctx.state` is this plugin's own computed state; `ctx.emit`
publishes its own events. So a plugin uses its dependencies with just a data payload —
no manual context threading.

## Quick start

```ts
import { spec, endpoint, server } from '@ayepi/core';
import { plugin, createPluginHost } from '@ayepi/plugin';
import { z } from 'zod';

const authSpec = spec({ endpoints: { login: endpoint({ body: z.object({ user: z.string() }), response: z.object({ token: z.string() }) }) } });
const auth = plugin({
  name: 'auth',
  spec: authSpec,
  state: () => ({ verify: (t: string) => (t.startsWith('tok-') ? t.slice(4) : null) }),
}).handlers(() => ({ login: ({ data }) => ({ token: `tok-${data.user}` }) }));

const notesSpec = spec({ endpoints: { add: endpoint({ body: z.object({ token: z.string(), text: z.string() }), response: z.object({ ok: z.boolean() }) }) } });
const notes = plugin({
  name: 'notes',
  requires: [auth] as const,
  spec: notesSpec,
}).handlers((ctx) => ({
  add: ({ data }) => ({ ok: ctx.deps.auth.state.verify(data.token) !== null }), // ← dep's state service
}));

const app = server(spec({ endpoints: {} }), []); // boot (nearly) empty
const host = createPluginHost(app);
await host.install(auth);   // base plugin
await host.install(notes);  // requires auth → installed after it
// ... app.fetch(...) now serves /login and /add — added while the server is live ...
await host.shutdown();      // tears every plugin down in dependency order
```

## How it works

It builds on three core primitives:

- **`Server.install` / `uninstall`** — hot-mount/unmount a spec + builders on a live
  server (routes, events, middleware, manifest, docs all refresh).
- **`localClient(app, spec)`** — the in-process, no-serialization caller behind
  `ctx.deps.<dep>.call`.
- **`provide`** — inject typed values onto context.

The host installs in dependency order, builds each plugin's context from the
registry, runs `lifecycle.up`, then mounts it. `uninstall` reverses that (drain →
remove → teardown) and **refuses while a live dependent remains**.

## Handlers in other files

For larger codebases, capture the builder in its own `const` and type handlers/
middleware in other files against `typeof builder` (non-circular, since the builder's
config carries no implementation), then fold them in with the chain methods:

```ts
// notes.ts
export const notesDef = plugin({ name: 'notes', requires: [auth] as const, spec, state });
import { addNote } from './notes.handlers';
export const notes = notesDef.handlers((ctx) => ({ addNote: addNote(ctx) }));

// notes.handlers.ts
import type { notesDef } from './notes'; // type-only — no runtime cycle
export const addNote: PluginHandlers<typeof notesDef>['addNote'] =
  (ctx) => ({ data }) => ctx.deps.auth.state.verify(data.token) ? ctx.state.add(…) : reject(401, 'UNAUTHORIZED');
```

See **[`ayepi-plugin.md`](./ayepi-plugin.md)** for the full reference, and
[`examples/08-plugins`](../../examples/08-plugins) for a runnable demo (auth → notes
→ stats, with hot uninstall/reinstall).

## For AI coding agents

This package ships dense, machine-oriented reference docs written for **AI coding agents**
(Claude Code, Cursor, and the like) to understand and drive the package — point your agent at them:

- [`ayepi-plugin.md`](./ayepi-plugin.md)

They live next to the source in the [repo](https://github.com/ClickerMonkey/ayepi/tree/main/packages/plugin) and are **not** shipped in the npm tarball.

