# 08 · plugins

A **plugin host** ([`@ayepi/plugin`](../../packages/plugin)). The server boots almost
empty, then installs three plugins **into the running server** in dependency order —
and hot-removes/re-adds one on a timer while everything else keeps serving.

- **`auth`** — a base plugin. Exposes a `login` endpoint and a **state** service
  (`verify(token) → user`) that dependents call directly (no HTTP, no middleware).
- **`notes`** (`requires: [auth]`) — `addNote` authenticates via
  `ctx.deps.auth.state.verify(...)`, emits its own `noteAdded` event, and exports a
  `count()` state service.
- **`stats`** (`requires: [notes]`) — a two-level chain (stats → notes → auth); its
  `/stats` endpoint reads `ctx.deps.notes.state.count()`.

The server **hot-uninstalls and reinstalls `stats`** every ~12s — `GET /stats` blinks
between a count and a `404` while `/login`, `/addNote`, `/listNotes` keep serving. The
host also **refuses** to uninstall `auth` while `notes` depends on it.

`@ayepi/plugin` is **server-only** — the client never imports it.

## Run

```sh
pnpm -r build
pnpm --filter @ayepi/examples plugins
```

→ http://localhost:3008

## Files

- `auth.ts` / `stats.ts` — plugins built inline: `plugin({ name, requires, spec,
  state }).handlers(…).lifecycle(…)`.
- `notes.ts` + `notes.handlers.ts` — the **split** form for larger codebases:
  `plugin({ name, requires, spec, state })` returns a builder whose `typeof` fixes the
  context type, the handlers live in `notes.handlers.ts` typed via
  `PluginHandlers<typeof notesDef>` (full access to `ctx.deps.auth` and `ctx.state`),
  and `notesDef.handlers(…).lifecycle(…)` folds them in.
- Each plugin exports its `spec` for the client to type against.
- `server.ts` — boots `server(spec({ endpoints: {} }), [])`, creates the host,
  installs the plugins, and runs the hot uninstall/reinstall loop.
- `client.ts` — a Vue app with **one typed client per plugin**, all sharing the app's
  manifest and a single login token (the seed of the "plugin clients linked to a core
  client" idea).

## Try it

```sh
TOKEN=$(curl -s -XPOST localhost:3008/login -H 'content-type: application/json' -d '{"user":"ada"}' | sed 's/.*"token":"\([^"]*\)".*/\1/')
curl -s -XPOST localhost:3008/addNote -H 'content-type: application/json' -d "{\"token\":\"$TOKEN\",\"text\":\"hi\"}"  # → the note
curl -s localhost:3008/listNotes
curl -i -XPOST localhost:3008/addNote -H 'content-type: application/json' -d '{"token":"bad","text":"x"}'             # → 401 (auth's verify)
curl -s localhost:3008/stats        # → {"notes":N} when the stats plugin is installed, 404 during its hot-removal window
```

Watch the server console: plugins log `up`/`stop` as they install and as `stats` is
hot-cycled, and the host prints the refusal when you'd remove a depended-on plugin.
