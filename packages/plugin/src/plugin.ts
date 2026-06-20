/**
 * # Plugins
 *
 * A **plugin** is a self-contained slice of an ayepi API: a frontend-safe `spec`, an
 * optional **state** service (functions + data that *dependent* plugins call directly
 * — the better "private functions"), its handlers + middleware, lifecycle hooks, and a
 * list of plugins it `requires`. Plugins are installed into a running server by a
 * {@link createPluginHost | host}, in dependency order, **while the server is live**.
 *
 * `plugin({ name, requires?, spec, state? })` returns a **builder**; chain ctx-aware
 * `.middleware(…)` / `.handlers(…)` / `.lifecycle(…)` (mirroring ayepi's `implement()`).
 * Every callback receives a dependency **context** (`ctx`): `ctx.deps.<name>` exposes
 * each required plugin's `state` service, a typed in-process `call` for its endpoints,
 * and an `emit`; `ctx.state` is this plugin's own state; `ctx.emit` its own events.
 *
 * Because `plugin({…})` carries no implementation, `typeof builder` is non-circular —
 * so you can type handlers and middleware impls **in other files**
 * (`PluginHandler<typeof p, 'name'>`, `PluginMiddleware<typeof p, mw>`) and fold them in.
 *
 * ```ts
 * const notes = plugin({ name: 'notes', requires: [auth] as const, spec: notesSpec, state: () => ({ add, count }) })
 *   .middleware(stamp, (ctx) => async (io) => io.next({ stamp: ctx.state.tag() }))
 *   .handlers((ctx) => ({ addNote: ({ data }) => ctx.state.add(data.text, ctx.deps.auth.state.verify(data.token)) }))
 *   .lifecycle((ctx) => ({ up: () => store.connect(), stop: () => store.close() }));
 * ```
 *
 * @module
 */

import type { AnySpec, AnyEndpoint, AnyMiddleware, BoundMiddleware, LocalClient, EmitFn, HandlerFor, ImplFor } from '@ayepi/core';
import { implement } from '@ayepi/core';

/** Loosest internal function type — replaces the banned `Function`. */
type AnyFn = (...args: never[]) => unknown;

/** Lifecycle hooks a plugin runs around install/uninstall, in dependency order. */
export interface Lifecycle {
  /** Start work — runs after the plugin's deps are up, before its endpoints serve. */
  readonly up?: () => void | Promise<void>;
  /** Drain — the pre-stop phase (stop accepting work, finish in-flight). */
  readonly down?: () => void | Promise<void>;
  /** Teardown — the post-stop phase (close resources). */
  readonly stop?: () => void | Promise<void>;
}

/**
 * The methods-free structural base every plugin builder satisfies — what the `*Of` /
 * `PluginHandlers` / `CtxOf` helpers match on. Keeping `AnyPlugin` to this shape (no
 * chain methods) is essential: comparing full builders would expand `.middleware`'s
 * `ImplFor<M>` into `ImplFor<AnyMiddleware>` and recurse infinitely.
 */
export interface PluginShape<Name extends string, Spec extends AnySpec, State, Deps extends readonly AnyPlugin[]> {
  readonly name: Name;
  readonly spec: Spec;
  readonly requires: Deps;
  /** @internal phantom carrier of the state-service type. */
  readonly __state?: State;
}

/** Any plugin, erased — the constraint for `requires` lists and the host registry. */
export type AnyPlugin = PluginShape<string, AnySpec, unknown, readonly AnyPlugin[]>;

/** Extract a plugin's exported state-service type. */
export type StateOf<P> = P extends { readonly __state?: infer S } ? S : never;
/** Extract a plugin's spec. */
export type SpecOf<P> = P extends { readonly spec: infer Sp extends AnySpec } ? Sp : never;
/** Extract a plugin's name. */
export type NameOf<P> = P extends { readonly name: infer N extends string } ? N : never;
/** Extract a plugin's `requires` tuple. */
export type DepsOf<P> = P extends { readonly requires: infer D extends readonly AnyPlugin[] } ? D : never;

/** The handle a plugin gets for one of its dependencies. */
export interface DepHandle<P extends AnyPlugin> {
  /** The dependency's exported **state** service (its functions + data). */
  readonly state: StateOf<P>;
  /** Call one of the dependency's endpoints in-process, with just a data payload. */
  readonly call: LocalClient<SpecOf<P>>['call'];
  /** Emit one of the dependency's events. */
  readonly emit: EmitFn<SpecOf<P>>;
}

/** The `deps` record on a plugin context — keyed by each required plugin's name. */
export type DepsRecord<Deps extends readonly AnyPlugin[]> = {
  readonly [P in Deps[number] as NameOf<P>]: DepHandle<P>;
};

/** The context passed to a plugin's `state` builder — its dependencies + an `emit` for its own events. */
export interface DepsCtx<Deps extends readonly AnyPlugin[], Spec extends AnySpec> {
  /** Each required plugin's `{ state, call, emit }` handle, keyed by name. */
  readonly deps: DepsRecord<Deps>;
  /** Emit one of this plugin's own events. */
  readonly emit: EmitFn<Spec>;
}

/** The context passed to a plugin's `.middleware` / `.handlers` / `.lifecycle` — {@link DepsCtx} plus this plugin's own `state`. */
export interface PluginCtx<Deps extends readonly AnyPlugin[], Spec extends AnySpec, State> extends DepsCtx<Deps, Spec> {
  /** This plugin's own computed `state` service. */
  readonly state: State;
}

/** The config for {@link plugin} — the type-defining half (no implementation). */
export interface PluginConfig<Name extends string, Spec extends AnySpec, State, Deps extends readonly AnyPlugin[]> {
  /** Unique plugin name (and the key dependents reference it by). */
  readonly name: Name;
  /** The plugins this one depends on — available in `ctx.deps` and installed first. */
  readonly requires?: Deps;
  /** The frontend-safe API contract this plugin contributes. */
  readonly spec: Spec;
  /** Build this plugin's exported **state** service from its dependency context (computed once at install). */
  readonly state?: (ctx: DepsCtx<Deps, Spec>) => State;
}

/** A partial handler bag for a spec — what a `.handlers((ctx) => …)` factory returns (multiple merge). */
export type PartialHandlers<Spec extends AnySpec> = {
  readonly [K in keyof Spec['endpoints'] & string]?: HandlerFor<Spec, Spec['endpoints'][K] & AnyEndpoint>;
};

// The `.middleware` impl/bound types resolve to the precise `ImplFor<M>` / `BoundMiddleware<M>` at a
// **concrete** `M`, but collapse to a loose function at the bare `AnyMiddleware` constraint. That guard is
// what lets `Plugin`'s type be materialized (by `typeof p` in the helper types) without TypeScript expanding
// `ImplFor<AnyMiddleware>` → `ListProvides<readonly AnyMiddleware[]>` → infinite.
/** The ctx-aware impl a `.middleware(def, …)` factory must return for def `M`. */
export type MwImpl<M extends AnyMiddleware> = [AnyMiddleware] extends [M] ? AnyFn : ImplFor<M>;
/** The prebuilt bound pair a `.middleware(bound)` accepts for def `M`. */
export type MwBound<M extends AnyMiddleware> = [AnyMiddleware] extends [M] ? { readonly def: AnyMiddleware; readonly impl: AnyFn } : BoundMiddleware<M>;

/**
 * A plugin builder — the value {@link plugin} returns and the host installs. Chain
 * `.middleware`/`.handlers`/`.lifecycle` (each ctx-aware, returning a new builder).
 * `typeof builder` types out-of-line handlers/middleware.
 *
 * @typeParam Name  - the plugin's unique name.
 * @typeParam Spec  - its API spec.
 * @typeParam State - its exported state-service type.
 * @typeParam Deps  - the plugins it requires.
 */
export interface Plugin<Name extends string, Spec extends AnySpec, State, Deps extends readonly AnyPlugin[]>
  extends PluginShape<Name, Spec, State, Deps> {
  /** Bind a middleware def to a ctx-aware impl factory (binds only this plugin's own new middleware). */
  middleware<M extends AnyMiddleware>(def: M, impl: (ctx: PluginCtx<Deps, Spec, State>) => MwImpl<M>): this;
  /** Bind a prebuilt `{ def, impl }` pair (e.g. a package binder like `bearerAuth.server`). */
  middleware<M extends AnyMiddleware>(bound: MwBound<M>): this;
  /** Add a (partial) handler bag built from `ctx` — multiple calls merge. */
  handlers(factory: (ctx: PluginCtx<Deps, Spec, State>) => PartialHandlers<Spec>): this;
  /** Set lifecycle hooks built from `ctx`. */
  lifecycle(factory: (ctx: PluginCtx<Deps, Spec, State>) => Lifecycle): this;
}

/** The dependency context type for a plugin `P` — `{ deps, emit, state }`. */
export type CtxOf<P> = PluginCtx<DepsOf<P>, SpecOf<P>, StateOf<P>>;

/**
 * The handler-factory record for a plugin `P` — one entry per endpoint, each a
 * `(ctx) => handler` closing over the plugin's context. Type out-of-line handlers with
 * `PluginHandlers<typeof p>['name']`.
 */
export type PluginHandlers<P> = {
  readonly [K in keyof SpecOf<P>['endpoints'] & string]: (ctx: CtxOf<P>) => HandlerFor<SpecOf<P>, SpecOf<P>['endpoints'][K] & AnyEndpoint>;
};

/** A single plugin handler factory — `PluginHandler<typeof p, 'addNote'>`. */
export type PluginHandler<P, K extends string> = K extends keyof PluginHandlers<P> ? PluginHandlers<P>[K] : never;

/**
 * A middleware-impl factory for a plugin `P` and middleware def `M` — a
 * `(ctx) => ImplFor<M>` closing over the plugin's context. Type out-of-line middleware
 * impls with `PluginMiddleware<typeof p, typeof mw>`.
 */
export type PluginMiddleware<P, M extends AnyMiddleware> = (ctx: CtxOf<P>) => ImplFor<M>;

/* ---- runtime ---- */

/** A recorded `.middleware()` binding — a ctx-aware factory or a prebuilt bound pair. */
interface MwEntry {
  readonly def?: AnyMiddleware;
  readonly implFactory?: (ctx: unknown) => AnyFn;
  readonly bound?: { readonly def: AnyMiddleware; readonly impl: AnyFn };
}
/** The accumulated, immutable builder state. */
interface BuilderState {
  readonly name: string;
  readonly spec: AnySpec;
  readonly requires: readonly AnyPlugin[];
  readonly stateFactory?: (ctx: unknown) => unknown;
  readonly mws: readonly MwEntry[];
  readonly handlerFactories: readonly ((ctx: unknown) => Record<string, AnyFn>)[];
  readonly lifecycleFactory?: (ctx: unknown) => Lifecycle;
}
/** Loosely-typed ayepi `implement()` builder, used to assemble the plugin's Implementor. */
interface LooseImpl {
  middleware(def: unknown, impl?: unknown): LooseImpl;
  handlers(bag: unknown): LooseImpl;
}
/** The erased runtime a plugin value carries — read by {@link createPluginHost | the host}. @internal */
export interface PluginInternals {
  readonly name: string;
  readonly spec: AnySpec;
  readonly requires: readonly AnyPlugin[];
  /** Compute the state service from the `{ deps, emit }` context. */
  __state(ctx: unknown): unknown;
  /** Assemble the ayepi Implementor (middleware + merged handlers) from the full context. */
  __implement(ctx: unknown): unknown;
  /** Build the lifecycle hooks from the full context. */
  __lifecycle(ctx: unknown): Lifecycle;
}

/** Build an immutable builder over the given state. */
function makeBuilder(s: BuilderState): PluginInternals & {
  middleware(defOrBound: unknown, impl?: unknown): unknown;
  handlers(factory: unknown): unknown;
  lifecycle(factory: unknown): unknown;
} {
  return {
    name: s.name,
    spec: s.spec,
    requires: s.requires,
    middleware(defOrBound: unknown, impl?: unknown) {
      const entry: MwEntry = impl
        ? { def: defOrBound as AnyMiddleware, implFactory: impl as (ctx: unknown) => AnyFn }
        : { bound: defOrBound as { def: AnyMiddleware; impl: AnyFn } };
      return makeBuilder({ ...s, mws: [...s.mws, entry] });
    },
    handlers(factory: unknown) {
      return makeBuilder({ ...s, handlerFactories: [...s.handlerFactories, factory as (ctx: unknown) => Record<string, AnyFn>] });
    },
    lifecycle(factory: unknown) {
      return makeBuilder({ ...s, lifecycleFactory: factory as (ctx: unknown) => Lifecycle });
    },
    __state: (ctx) => (s.stateFactory ? s.stateFactory(ctx) : undefined),
    __implement: (ctx) => {
      let b = implement(s.spec) as unknown as LooseImpl; // internal cast: drive the typed implement() builder through a loose chain view
      for (const mw of s.mws) {
        b = mw.bound ? b.middleware(mw.bound) : b.middleware(mw.def, mw.implFactory!(ctx));
      }
      const bag: Record<string, AnyFn> = {};
      for (const hf of s.handlerFactories) {
        Object.assign(bag, hf(ctx));
      }
      return b.handlers(bag);
    },
    __lifecycle: (ctx) => (s.lifecycleFactory ? s.lifecycleFactory(ctx) : {}),
  };
}

/**
 * Create a plugin **builder** from its config. The builder is inert until a
 * {@link createPluginHost | host} installs it — at which point its `state` is computed,
 * its `lifecycle.up` runs, and its `spec` + handlers are mounted live. Chain
 * `.middleware`/`.handlers`/`.lifecycle` to add the implementation.
 *
 * @typeParam Name  - inferred from `config.name`.
 * @typeParam Spec  - inferred from `config.spec`.
 * @typeParam State - inferred from `config.state`'s return (`undefined` if omitted).
 * @typeParam Deps  - inferred from `config.requires`.
 */
export function plugin<
  const Name extends string,
  Spec extends AnySpec,
  State = undefined,
  const Deps extends readonly AnyPlugin[] = readonly [],
>(config: PluginConfig<Name, Spec, State, Deps>): Plugin<Name, Spec, State, Deps> {
  return makeBuilder({
    name: config.name,
    spec: config.spec,
    requires: (config.requires ?? ([] as readonly AnyPlugin[])) as readonly AnyPlugin[],
    stateFactory: config.state as ((ctx: unknown) => unknown) | undefined,
    mws: [],
    handlerFactories: [],
  }) as unknown as Plugin<Name, Spec, State, Deps>; // internal cast: the loose runtime builder behind the typed chain surface
}
