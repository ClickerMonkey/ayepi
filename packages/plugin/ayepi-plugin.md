# @ayepi/plugin — reference

A plugin system layered on `@ayepi/core`: compose an API from independent **plugins**
and install/uninstall them into a **running** server, in dependency order, with each
plugin's dependency context, state service, and lifecycle wired up.

This doc is the authoritative reference. For the core primitives it builds on, see
`ayepi-core.md` (`Server.install`/`uninstall`, `localClient`, `provide`).

## Mental model

A **plugin** is a self-contained slice of an API:

| field / method | what it is |
| --- | --- |
| `name` | unique id; the key dependents reference it by (config) |
| `spec` | the frontend-safe API contract (a normal `spec()`) (config) |
| `state(ctx)?` | a **service object** (functions + data) that dependents call directly (config) |
| `requires?` | the plugins it depends on (config) |
| `.handlers((ctx) => …)` | a (partial) handler bag — multiple calls merge |
| `.middleware(def, (ctx) => impl)` / `.middleware(bound)` | bind this plugin's own middleware |
| `.lifecycle((ctx) => …)` | `up` / `down` (drain) / `stop` (teardown) hooks |

`plugin({ name, requires, spec, state })` returns a **builder**; chain the ctx-aware
`.handlers` / `.middleware` / `.lifecycle` methods (mirroring core's `implement()`).
Each returns a new builder, so a plugin is just `plugin(config).handlers(…)….lifecycle(…)`.

A **host** (`createPluginHost(app)`) installs plugins into one running `Server`. It
resolves dependencies, builds each plugin's **context**, runs `lifecycle.up`, then
hot-mounts its spec + handlers via `Server.install`.

```
 plugin({ name, requires, spec, state }).middleware(…).handlers(…).lifecycle(…)   ── a builder value
 createPluginHost(app)
   .install(p)   → require deps installed → build ctx → state(ctx) → up() → app.install(spec, [impl(ctx)])
   .uninstall(n) → refuse if a live dependent → down() → app.uninstall(handle) → stop()
   .shutdown()   → uninstall all, dependents first
```

## `plugin(config)` → a builder

```ts
const users = plugin({
  name: 'users',
  requires: [auth] as const,         // typed dependency plugins
  spec: usersSpec,
  state: (ctx) => ({ find: (id: string) => store.get(id) }),  // ctx: { deps, emit }
})
  .middleware(localMw, (ctx) => localImpl) // ctx: { deps, emit, state }; binds only this plugin's own middleware
  .handlers((ctx) => ({
    me: ({ data }) => ctx.deps.auth.state.requireUser(data.token), // a dep's state service
    list: () => ctx.state.allUsers(),                              // this plugin's own state
  }))
  .lifecycle((ctx) => ({ up: () => store.connect(), stop: () => store.close() }));
```

`plugin()` is pure — it packages the config and the chained factories. The plugin is
inert until a host installs it. All type parameters are inferred
(`Name`/`Spec`/`State`/`Deps`). Because the builder carries no implementation in its
*config*, `typeof users` is non-circular — so handlers/middleware can be typed against
it in other files (see below).

### The context (`ctx`)

Every callback receives a context built from the host's registry:

- **`ctx.deps.<name>`** — for each plugin in `requires`, a `{ state, call, emit }`
  handle:
  - `state` — that dependency's exported state service (its functions/data).
  - `call(name, data, opts?)` — call one of its endpoints **in-process** (full chain
    + validation, no HTTP), typed against its spec. Backed by core's `localClient`.
  - `emit(event, …)` — emit one of its events, typed against its spec.
- **`ctx.emit(event, …)`** — emit **this** plugin's own events.
- **`ctx.state`** — this plugin's own computed `state` (on `.handlers`/`.middleware`/
  `.lifecycle`; the `state` factory itself runs with just `{ deps, emit }`).

Handlers close over `ctx` lexically, so they reach deps/state with no middleware
plumbing. (If *middleware* — not just handlers — needs the context, inject it with
core's `provide`.)

### State: the "better private functions"

`state(ctx)` returns a service object that dependents consume via `ctx.deps.<you>.state`.
It is computed **once** at install and memoized; a plugin installed later gets the live
reference. Use it for internal logic dependents should call directly (no endpoint, no
auth) — the typed replacement for ad-hoc private exports. Use **endpoint calls**
(`ctx.deps.<dep>.call`) when you genuinely want the dependency's public endpoint
behavior (its validation + middleware run; pass `opts.headers` if it needs auth).

## Defining handlers & middleware in other files

In a larger codebase you won't write every handler inline. Because `plugin(config)`
returns a builder that carries **no implementation in its config**, `typeof builder` is
non-circular — so you can type out-of-line handlers and middleware impls against it and
fold them in with the chain methods. (Capture the builder in its own `const` first, so
the handler files import a stable `typeof`.)

```ts
// notes.ts
export const notesDef = plugin({
  name: 'notes',
  requires: [auth] as const,
  spec: notesSpec,
  state: (): NotesService => ({ count: …, add: …, all: … }),  // encapsulate state here
});
import { addNote, listNotes } from './notes.handlers';
export const notes = notesDef
  .middleware(mw, mwImpl)                                       // (ctx) => impl, typed via PluginMiddleware
  .handlers((ctx) => ({ addNote: addNote(ctx), listNotes: listNotes(ctx) }))
  .lifecycle(() => ({ up, stop }));

// notes.handlers.ts
import type { notesDef } from './notes';                    // type-only → no runtime cycle
import type { PluginHandlers } from '@ayepi/plugin';
type H = PluginHandlers<typeof notesDef>;

export const addNote: H['addNote'] = (ctx) => ({ data }) => {
  const author = ctx.deps.auth.state.verify(data.token);    // ← the `auth` dependency, fully typed
  const note = ctx.state.add(data.text, author!);           // ← this plugin's own state
  ctx.emit('noteAdded', note);                              // ← this plugin's own event
  return note;
};
export const listNotes: H['listNotes'] = (ctx) => () => ctx.state.all();
```

The helper types:

| type | what it is |
| --- | --- |
| `PluginHandlers<typeof def>` | a record `{ [endpoint]: (ctx) => Handler }` — index it: `['addNote']` |
| `PluginHandler<typeof def, 'addNote'>` | a single handler factory `(ctx) => Handler` |
| `PluginMiddleware<typeof def, typeof mw>` | a middleware-impl factory `(ctx) => ImplFor<mw>` for the def `mw` |
| `CtxOf<typeof def>` | the plugin's context type (`{ deps, emit, state }`) |

A handler/middleware factory takes the plugin's `ctx` and returns the actual
handler/impl; you apply it (`addNote(ctx)`) inside `.handlers`, or hand a
`PluginMiddleware` factory straight to `.middleware(def, …)`. The same types work on a
finished plugin value too (`PluginHandlers<typeof notes>`). Keep encapsulated state
(stores, clients) inside `state(ctx)` and reach it from handlers via `ctx.state`.

## `createPluginHost(app)`

```ts
const app = server(spec({ endpoints: {} }), []);   // boot (nearly) empty, or carry a core spec
const host = createPluginHost(app);

await host.install(auth);
await host.install(users);          // requires auth → must be installed first (else throws)
host.installed();                   // ['auth', 'users']
await host.uninstall('users');
await host.shutdown();              // uninstall everything, dependents before deps
```

| method | behavior |
| --- | --- |
| `install(plugin)` | requires deps installed; builds ctx + `state`; runs `up`; `app.install`s the spec. On a mount error, runs `stop` to roll back. Throws on duplicate name or missing dependency. |
| `uninstall(name)` | refuses while a live dependent remains; runs `down` → `app.uninstall` → `stop`. Throws if not installed. |
| `installed()` | the installed plugin names, in install order. |
| `shutdown()` | uninstalls every plugin in dependency-safe order (dependents first). |

Install/uninstall are `async` (lifecycle hooks may be async).

**Teardown is isolated.** A `down`/`stop` hook (or route removal) that throws during
`uninstall`/`shutdown` can't strand a plugin half-removed or abort teardown of the others —
each step runs and the plugin is always removed from the registry. An install rollback
surfaces the **original mount error** even if the rollback `stop` throws. Pass an observer to
notice these swallowed failures: `createPluginHost(app, { onError: (err, phase, plugin) => … })`
where `phase` is `'down' | 'stop' | 'remove'` (off by default; it must not throw).

## Hot install/uninstall

Installing/uninstalling happens on the **live** server: `Server.install` adds the
plugin's endpoints, events, routes, and middleware and refreshes the manifest +
OpenAPI/AsyncAPI caches; `uninstall` removes exactly them and clears their ws
subscriptions. A request to an uninstalled route gets a normal `404`. The rest of the
server keeps serving throughout.

## Shared middleware across plugins

If two plugins share a middleware (e.g. a common `auth` def), **import the same def
object** and **bind it once** — in the owning plugin's `implement`. A dependent
plugin that uses the shared def in its chain does **not** re-bind it; the server's
global impl map resolves it. Re-binding the same def throws `duplicate implementation`.

## Events

`ctx.emit` and `ctx.deps.<dep>.emit` both delegate to the server's runtime `emit`
(global by event name). The host guarantees event-name uniqueness across plugins via
the install-time collision check. Uninstalling a plugin clears its event channels'
subscriptions.

## Collisions & failure modes

`install` throws on: a duplicate plugin name, a missing dependency, or a spec that
collides with the live server — a duplicate **endpoint name**, **`METHOD path`**,
**ws id**, or **event channel**. `uninstall` throws if the plugin isn't installed or
still has a live dependent. A plugin whose `lifecycle.up` succeeds but whose mount
fails has its `stop` run (rollback) and is not registered.

> Namespacing across plugins is by convention for now — choose distinct endpoint
> names/paths (e.g. prefix a module's paths with `.path('/billing')`). Auto-prefixing
> mounts are a possible future addition.

## What it builds on (core)

- **`Server.install(spec, builders) → MountHandle` / `Server.uninstall(handle)`** —
  hot registry mutation with collision checks and cache invalidation.
- **`localClient(app, spec) → LocalClient<S>`** and **`Server.call`** — the
  in-process, no-serialization caller (transport `'local'`) behind `ctx.deps.*.call`.
- **`provide(name, value|factory)`** — inject a typed value onto context; the
  primitive for handing services/data to handlers and middleware.

## Example

[`examples/08-plugins`](../../examples/08-plugins) — `auth` → `notes` → `stats`
(a two-level dependency chain). `notes` authenticates via `auth`'s `state.verify`,
emits its own `noteAdded`, and exports a `count()` service that `stats` reads. The
server hot-uninstalls/reinstalls `stats` on a timer (the `/stats` route blinks) and
the host refuses to uninstall `auth` while `notes` depends on it.
