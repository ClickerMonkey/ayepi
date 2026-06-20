/**
 * # Middleware
 *
 * Composable, strongly-typed middleware, split into a **def** (the contract) and an
 * **impl** (the runtime fn) — mirroring `spec()` ↔ `implement().handlers()`. A def
 * is frontend-safe: name, contributed context, docs, and dependencies, with no fn,
 * secrets, or node deps. A middleware def can:
 *
 * - **provide context** — declared via `provides: ctx<{ … }>()`; the impl produces
 *   it (`io.next({ … })`) and it is merged into the handler payload root;
 * - **declare dependencies** — `requires` middleware are auto-included and run
 *   first (their context is guaranteed); `optional` middleware only affect
 *   *ordering* when independently present;
 * - **load a path param** — {@link MiddlewareFactory.loader | middleware.loader}
 *   owns a `:key` + schema + context, parsing the segment before the chain runs.
 *
 * Bind impls with `implement(api).middleware(def, impl)`; `server()` resolves each
 * chain and throws if a def is unbound. Stacks (`.with()`, `.path()`) bundle
 * middleware and path prefixes for reuse across a `.group()` of endpoints. Chains
 * are resolved topologically at `spec()`/server time — see {@link resolveChain}.
 *
 * @module
 */

import type { z } from 'zod';
import type { Json, Simplify, UnionToIntersection, EmptyObject } from './types';
import type { HttpMethod } from './manifest';
import type { WsConn } from './server';
import type { AnyPathTemplate } from './path';
import type { EndpointConfig, CheckCfg, Endpoint } from './endpoint';
import { makeEndpoint } from './endpoint';

/** Which transport an invocation arrived on (`'local'` = an in-process {@link LocalClient} call). */
export type Transport = 'http' | 'ws' | 'local';

/**
 * The matched route a middleware is running for. A discriminated union: an
 * **endpoint** (with `method`/`path`/`ws` id) or an **event** channel (guard
 * chains run when a client subscribes), which has no method/path.
 */
export type RouteInfo =
  | { readonly kind: 'endpoint'; readonly name: string; readonly method: HttpMethod; readonly path: string; readonly ws: string | null }
  | { readonly kind: 'event'; readonly name: string; readonly ws: string };

/** WebSocket frame context, present on {@link MiddlewareIO.ws} only when `transport === 'ws'`. */
export interface WsFrameInfo {
  /** The frame id (the per-call correlation id) — the ws equivalent of a request id. */
  readonly id: string;
  /** The raw frame payload (`data` for calls, `params` for event subscriptions). Narrow it yourself. */
  readonly data: unknown;
  /** The WebSocket connection this frame arrived on. */
  readonly conn: WsConn;
}

/** Loosest internal function type — replaces the banned `Function` in plumbing signatures. */
type AnyFn = (...args: never[]) => unknown;

declare const MW_PROVIDES: unique symbol;
/**
 * Opaque token returned by `next()`; carries (type-only) the context a
 * middleware provides so the next link and the handler can see it.
 *
 * @typeParam P - the context shape this step contributes.
 */
export interface MiddlewareResult<P extends object> {
  readonly [MW_PROVIDES]?: P;
}

/**
 * The argument passed to a middleware function.
 *
 * @typeParam Req - the accumulated context from earlier middleware in the chain.
 */
export interface MiddlewareIO<Req extends object> {
  /** The incoming request. Over ws this is the connection's HTTP **upgrade** request (shared per socket), not the frame. */
  readonly req: Request;
  /** Context accumulated so far (read-only snapshot). */
  readonly ctx: Simplify<Req>;
  /**
   * The raw, **pre-validation** request body — the parsed JSON / urlencoded-form object
   * (or, for a multipart request, its non-file fields), the ws call's data, or `undefined`
   * when the request declares no body. Read it to derive idempotency/cache keys, sign or
   * log the payload, etc. The typed, validated body still reaches the handler as `data`.
   */
  readonly body: unknown;
  /**
   * Continue the chain, optionally contributing context. The added shape is
   * inferred and becomes visible to later middleware and the handler. Every
   * middleware **must** call `next()` (or throw) exactly once.
   */
  readonly next: <T extends object = EmptyObject>(add?: T) => Promise<MiddlewareResult<T>>;
  /** Which transport this invocation arrived on (`'http'` or `'ws'`). */
  readonly transport: Transport;
  /** The matched route — an endpoint (with `method`/`path`/`ws`) or an event channel. Use `route.method`/`route.path` for transport-neutral identity. */
  readonly route: RouteInfo;
  /** The abort signal for this invocation (the HTTP request signal, or the ws call's per-frame signal). */
  readonly signal: AbortSignal;
  /** WebSocket frame context — present only when `transport === 'ws'` (carries the frame `id`, raw `data`, and `conn`). */
  readonly ws?: WsFrameInfo;
  /** Set a response header. Applies over HTTP (collected with the handler's headers); collected-but-unused over ws. Must run before the response commits. */
  readonly setHeader: (name: string, value: string) => void;
  /** Set the response status — the HTTP status code, or a ws call's result-frame `$status`. Must run before the response commits. */
  readonly status: (code: number) => void;
}

/**
 * A plain middleware function. Either continue the chain via `io.next(…)` (the
 * common case) or **short-circuit** by returning a `Response` directly — the rest
 * of the chain and the handler are skipped. Over HTTP the `Response` is sent
 * as-is; over ws a JSON body becomes a result frame and anything else an error
 * frame.
 */
export type MiddlewareFn<Req extends object, P extends object> = (io: MiddlewareIO<Req>) => Promise<MiddlewareResult<P> | Response>;
/** A loader middleware function — additionally receives the parsed, typed param `value`. May also short-circuit with a `Response`. */
export type LoaderFn<Req extends object, Z extends z.ZodType, P extends object> = (
  io: MiddlewareIO<Req> & { readonly value: z.output<Z> },
) => Promise<MiddlewareResult<P> | Response>;

/**
 * Erased middleware shape used by the runtime and by variance-friendly
 * constraints. Carries phantom fields (`__p`/`__req`/`__lp`/`__opt`/`__isLoader`/
 * `__lz`) that are type-only.
 *
 * A middleware value is a **def** (contract only): its {@link AnyMiddleware.run}
 * is an unbound placeholder that throws if executed. The runtime fn is supplied
 * separately via `implement(api).middleware(def, impl)` and bound at `server()`.
 *
 * @internal
 */
export interface AnyMiddleware {
  readonly kind: 'middleware';
  readonly name: string;
  readonly requires: readonly AnyMiddleware[];
  readonly optional: readonly AnyMiddleware[];
  readonly paramKey: string | undefined;
  readonly paramSchema: z.ZodType | undefined;
  readonly doc: MiddlewareDoc | undefined;
  /** internal: loosest possible run signature; on a def it is an unbound placeholder that throws. */
  readonly run: (io: { req: Request; ctx: never; next: (add?: object) => Promise<MiddlewareResult<object>>; value?: never }) => Promise<MiddlewareResult<object> | Response>;
  readonly __p: object;
  readonly __req: readonly AnyMiddleware[];
  readonly __lp: object;
  /** internal phantom: the `optional` list, so an impl's `io.ctx` can include `Partial<provides-of-optional>`. */
  readonly __opt: readonly AnyMiddleware[];
  /** internal phantom: `true` only for `middleware.loader` defs — selects the loader-shaped impl. */
  readonly __isLoader: boolean;
  /** internal phantom: a loader def's own param schema (the `value` an impl receives); `ZodNever` for non-loaders. */
  readonly __lz: z.ZodType;
}

/** Everything a middleware provides, including (recursively) what its `requires` provide. */
type FullProvides<M extends AnyMiddleware> = M['__p'] & ListProvides<M['__req']>;
type DistFullProvides<M extends AnyMiddleware> = M extends AnyMiddleware ? FullProvides<M> : never;
type ListProvides<Ms extends readonly AnyMiddleware[]> = [Ms[number]] extends [never]
  ? EmptyObject
  : UnionToIntersection<DistFullProvides<Ms[number]>>;

/** Loader params contributed by a middleware, including its `requires` chain. */
type FullLP<M extends AnyMiddleware> = M['__lp'] & ListLP<M['__req']>;
type DistFullLP<M extends AnyMiddleware> = M extends AnyMiddleware ? FullLP<M> : never;
type ListLP<Ms extends readonly AnyMiddleware[]> = [Ms[number]] extends [never]
  ? EmptyObject
  : UnionToIntersection<DistFullLP<Ms[number]>>;

/** The merged context a stack of middleware contributes to the handler payload. */
export type StackCtx<Ms extends readonly AnyMiddleware[]> = Simplify<ListProvides<Ms>>;
/** The merged loader-param schemas a stack of middleware declares. */
export type StackLP<Ms extends readonly AnyMiddleware[]> = Simplify<ListLP<Ms>>;

/** Param schemas declared by a path template (position + schema); plain strings contribute positions only. */
type TplPS<T> = T extends { readonly __ps: infer PS extends object } ? PS : EmptyObject;
/** Stacked prefixes must not re-declare param keys already owned by a loader or earlier prefix. */
type CheckPrefix<T, LP extends object, PFX extends object> = T extends { readonly __ps: infer PS }
  ? [keyof PS & (keyof LP | keyof PFX)] extends [never]
    ? unknown
    : readonly ['prefix re-declares param keys:', keyof PS & (keyof LP | keyof PFX)]
  : unknown;

/**
 * A single middleware value, with fluent builders for composing it with others
 * ({@link Middleware.with | .with}), prepending a path prefix
 * ({@link Middleware.path | .path}), or attaching endpoints
 * ({@link Middleware.endpoint | .endpoint} / {@link Middleware.group | .group}).
 *
 * @typeParam P  - context this middleware provides.
 * @typeParam R  - its `requires` chain.
 * @typeParam LP - loader-param schemas it (and its requires) declare.
 */
export interface Middleware<P extends object, R extends readonly AnyMiddleware[], LP extends object> extends AnyMiddleware {
  readonly __p: P;
  readonly __req: R;
  readonly __lp: LP;
  /** Compose this middleware with more, producing a {@link Stack}. */
  with<M extends readonly AnyMiddleware[]>(...mws: M): Stack<readonly [Middleware<P, R, LP>, ...M], EmptyObject>;
  /** Prepend a path prefix; template params merge into every endpoint defined under it. */
  path<const T extends string | AnyPathTemplate>(p: T & CheckPrefix<T, LP, EmptyObject>): Stack<readonly [Middleware<P, R, LP>], Simplify<TplPS<T>>>;
  /** Define a single endpoint guarded by this middleware. */
  endpoint<const C extends EndpointConfig>(
    cfg: C & CheckCfg<C, StackLP<readonly [Middleware<P, R, LP>]>, EmptyObject>,
  ): Endpoint<C, StackCtx<readonly [Middleware<P, R, LP>]>, StackLP<readonly [Middleware<P, R, LP>]>, EmptyObject>;
  /** Define a named group of endpoints, all guarded by this middleware. */
  group<const G extends Record<string, EndpointConfig>>(
    g: G & { [K in keyof G]: CheckCfg<G[K], StackLP<readonly [Middleware<P, R, LP>]>, EmptyObject> },
  ): { [K in keyof G]: Endpoint<G[K], StackCtx<readonly [Middleware<P, R, LP>]>, StackLP<readonly [Middleware<P, R, LP>]>, EmptyObject> };
}

/**
 * A bundle of middleware plus optional path prefixes, ready to attach endpoints.
 *
 * @typeParam Ms  - the middleware list, in declared order.
 * @typeParam PFX - param schemas contributed by stacked path prefixes.
 */
export interface Stack<Ms extends readonly AnyMiddleware[], PFX extends object> {
  readonly kind: 'stack';
  readonly mws: Ms;
  readonly prefixes: ReadonlyArray<string | AnyPathTemplate>;
  /** Append more middleware to the stack. */
  with<M extends readonly AnyMiddleware[]>(...mws: M): Stack<readonly [...Ms, ...M], PFX>;
  /** Prepend a path prefix; template params merge into every endpoint defined under it. */
  path<const T extends string | AnyPathTemplate>(p: T & CheckPrefix<T, StackLP<Ms>, PFX>): Stack<Ms, Simplify<PFX & TplPS<T>>>;
  /** Define a single endpoint under this stack. */
  endpoint<const C extends EndpointConfig>(cfg: C & CheckCfg<C, StackLP<Ms>, PFX>): Endpoint<C, StackCtx<Ms>, StackLP<Ms>, PFX>;
  /** Define a named group of endpoints under this stack. */
  group<const G extends Record<string, EndpointConfig>>(
    g: G & { [K in keyof G]: CheckCfg<G[K], StackLP<Ms>, PFX> },
  ): { [K in keyof G]: Endpoint<G[K], StackCtx<Ms>, StackLP<Ms>, PFX> };
}

declare const PROVIDE: unique symbol;
/**
 * Phantom carrier for the context type a middleware **provides**. Pass
 * `provides: ctx<{ user: User }>()` to a {@link middleware} def to declare what it
 * contributes to the handler payload — the type the impl must produce and that
 * later middleware and handlers can read. Frontend-safe: a type-only token.
 *
 * @typeParam P - the context shape contributed.
 */
export interface Provide<P extends object> {
  readonly [PROVIDE]?: P;
}

/**
 * Declare the context a middleware def provides — `provides: ctx<{ user: User }>()`.
 * Returns a type-only token; carries no runtime value.
 */
export function ctx<P extends object>(): Provide<P> {
  return {};
}

/** Options accepted by the {@link middleware} factory. */
interface MiddlewareOpts<P extends object, R extends readonly AnyMiddleware[], O extends readonly AnyMiddleware[]> {
  /** The context this middleware contributes — `provides: ctx<{ user: User }>()`. Omit for a no-context (purely-runtime) def. */
  readonly provides?: Provide<P>;
  /** Middleware that are auto-included and guaranteed to run before this one. */
  readonly requires?: R;
  /** Middleware that, *if independently present*, run before this one — without being pulled in. */
  readonly optional?: O;
  /** OpenAPI contributions (security schemes + per-operation patches). */
  readonly doc?: MiddlewareDoc;
}

/** A middleware **def**: the `Middleware` contract plus type-only phantoms an impl binds against. */
type Def<M extends AnyMiddleware, O extends readonly AnyMiddleware[], IsLoader extends boolean, Z extends z.ZodType> = M & {
  readonly __opt: O;
  readonly __isLoader: IsLoader;
  readonly __lz: Z;
};

/**
 * The {@link middleware} factory: callable to create a plain middleware **def**,
 * with a {@link MiddlewareFactory.loader | .loader} method for param-loading defs.
 *
 * A def is a contract only — no runtime fn, no secrets, no node deps — so it is
 * safe to declare in a frontend-importable spec. Bind the implementation later
 * with `implement(api).middleware(def, impl)`.
 */
export interface MiddlewareFactory {
  /**
   * Create a middleware def. Declare its contributed context via `provides`, its
   * dependencies via `requires`/`optional`, and OpenAPI patches via `doc`.
   */
  <P extends object = EmptyObject, const R extends readonly AnyMiddleware[] = readonly [], const O extends readonly AnyMiddleware[] = readonly []>(
    name: string,
    opts?: MiddlewareOpts<P, R, O>,
  ): Def<Middleware<P, R, Simplify<ListLP<R>>>, O, false, z.ZodNever>;
  /**
   * Create a **loader** def that owns a path param: it declares `key` + `schema`
   * and parses the matching segment. Its impl receives the typed `value`, and the
   * parsed param flows to the handler's `data`.
   */
  loader: <
    P extends object = EmptyObject,
    K extends string = string,
    Z extends z.ZodType = z.ZodType,
    const R extends readonly AnyMiddleware[] = readonly [],
    const O extends readonly AnyMiddleware[] = readonly [],
  >(
    key: K,
    schema: Z,
    opts?: MiddlewareOpts<P, R, O>,
  ) => Def<Middleware<P, R, Simplify<ListLP<R> & { [Q in K]: Z }>>, O, true, Z>;
}

/* internal: build the unbound placeholder run for a def — throws if executed before binding. */
function placeholderRun(name: string): AnyFn {
  return () => {
    throw new Error(`middleware "${name}" has no implementation — bind it with implement(api).middleware(def, impl)`);
  };
}

/* internal: single constructor behind every overload (casts confined here) */
function makeMiddleware(
  name: string,
  requires: readonly AnyMiddleware[],
  optional: readonly AnyMiddleware[],
  paramKey: string | undefined,
  paramSchema: z.ZodType | undefined,
  doc: MiddlewareDoc | undefined,
): AnyMiddleware {
  const self: AnyMiddleware = {
    kind: 'middleware' as const,
    name,
    requires,
    optional,
    paramKey,
    paramSchema,
    doc,
    run: placeholderRun(name) as AnyMiddleware['run'],
    with(...mws: readonly AnyMiddleware[]) {
      return makeStack([self, ...mws], []);
    },
    path(p: string | AnyPathTemplate) {
      return makeStack([self], [p]);
    },
    endpoint(cfg: EndpointConfig) {
      return makeStack([self], []).endpoint(cfg);
    },
    group(g: Record<string, EndpointConfig>) {
      return makeStack([self], []).group(g);
    },
  } as unknown as AnyMiddleware; // internal cast: phantom fields (__p/__req/__lp/__opt/__isLoader/__lz) are type-only
  return self;
}

/* internal: stack constructor — bundles middleware + prefixes, defers to makeEndpoint */
function makeStack(mws: readonly AnyMiddleware[], prefixes: ReadonlyArray<string | AnyPathTemplate>) {
  return {
    kind: 'stack' as const,
    mws,
    prefixes,
    with(...more: readonly AnyMiddleware[]) {
      return makeStack([...mws, ...more], prefixes);
    },
    path(p: string | AnyPathTemplate) {
      return makeStack(mws, [...prefixes, p]);
    },
    endpoint(cfg: EndpointConfig) {
      return makeEndpoint(cfg, mws, prefixes);
    },
    group(g: Record<string, EndpointConfig>) {
      const out: Record<string, ReturnType<typeof makeEndpoint>> = {};
      for (const [k, cfg] of Object.entries(g)) {out[k] = makeEndpoint(cfg, mws, prefixes);}
      return out;
    },
  };
}

/**
 * Compose one or more middleware into a {@link Stack} — the free-function form of
 * {@link Middleware.with | mw.with(...)}, which reads more naturally when bundling
 * several middleware at a group: `...use(auth, tel).group({ … })` instead of
 * `...auth.with(tel).group({ … })`.
 *
 * The middleware run in the order given (subject to `requires`/`optional`
 * resolution), exactly as with `.with()`.
 *
 * @typeParam M - the middleware list, in declared order (at least one).
 *
 * @example
 * ```ts
 * spec({
 *   endpoints: {
 *     ...use(auth, tel).group({ me, createJob }),
 *     ...use(auth, jobLoader).path('/jobs/:jobId').group({ jobStatus }),
 *   },
 * })
 * ```
 */
export function use<const M extends readonly [AnyMiddleware, ...AnyMiddleware[]]>(...mws: M): Stack<M, EmptyObject> {
  return makeStack([...mws], []) as unknown as Stack<M, EmptyObject>; // internal cast: makeStack returns a loosely-typed stack
}

type AnyMiddlewareOpts = MiddlewareOpts<object, readonly AnyMiddleware[], readonly AnyMiddleware[]>;

function middlewareImpl(name: string, opts?: AnyMiddlewareOpts): AnyMiddleware {
  return makeMiddleware(name, opts?.requires ?? [], opts?.optional ?? [], undefined, undefined, opts?.doc);
}

function loaderImpl(key: string, schema: z.ZodType, opts?: AnyMiddlewareOpts): AnyMiddleware {
  return makeMiddleware(key, opts?.requires ?? [], opts?.optional ?? [], key, schema, opts?.doc);
}

/**
 * Create a middleware **def** — a frontend-safe contract (name, contributed
 * context, docs, dependencies) with **no** runtime fn. Bind the implementation
 * with `implement(api).middleware(def, impl)` in your server entry.
 *
 * @example A plain def that provides `{ user }`:
 * ```ts
 * const auth = middleware('auth', { provides: ctx<{ user: User }>() })
 * // server.ts:
 * implement(api).middleware(auth, async (io) => io.next({ user: await authenticate(io.req) }))
 * ```
 *
 * @example A def that requires `auth` (auto-included) and provides `{ org }`:
 * ```ts
 * const org = middleware('org', { provides: ctx<{ org: Org }>(), requires: [auth] })
 * // server.ts:
 * implement(api).middleware(org, async (io) => io.next({ org: await loadOrg(io.ctx.user) }))
 * ```
 *
 * @example A no-context, purely-runtime def (e.g. logging/telemetry):
 * ```ts
 * const log = middleware('log')
 * implement(api).middleware(log, async (io) => io.next())
 * ```
 *
 * @example A loader def that owns the `:projectId` path param:
 * ```ts
 * const project = middleware.loader('projectId', z.uuid(), { provides: ctx<{ project: Project }>() })
 * // server.ts:
 * implement(api).middleware(project, async (io) => io.next({ project: await loadProject(io.value) }))
 * ```
 */
export const middleware: MiddlewareFactory = Object.assign(middlewareImpl, { loader: loaderImpl }) as unknown as MiddlewareFactory; // internal cast: impl ⇄ overloads

/**
 * The impl signature a plain middleware def expects — a {@link MiddlewareFn} whose
 * `io.ctx` is the def's `requires` context plus `Partial<optional>` context, and
 * which must produce the def's provided context `M['__p']`.
 *
 * @typeParam M - the middleware def.
 */
export type MiddlewareImplFor<M extends AnyMiddleware> = MiddlewareFn<
  Simplify<ListProvides<M['__req']> & Partial<ListProvides<M['__opt']>>>,
  M['__p']
>;

/**
 * The impl signature a loader def expects — a {@link LoaderFn} that additionally
 * receives the typed `value` parsed from the def's own param schema (`M['__lz']`).
 *
 * @typeParam M - the loader middleware def.
 */
export type LoaderImplFor<M extends AnyMiddleware> = LoaderFn<
  Simplify<ListProvides<M['__req']> & Partial<ListProvides<M['__opt']>>>,
  M['__lz'],
  M['__p']
>;

/**
 * The impl signature for a def — {@link LoaderImplFor} for loader defs (those whose
 * `__isLoader` is `true`), otherwise {@link MiddlewareImplFor}.
 *
 * @typeParam M - the middleware def.
 */
export type ImplFor<M extends AnyMiddleware> = M['__isLoader'] extends true ? LoaderImplFor<M> : MiddlewareImplFor<M>;

/**
 * A def paired with its impl — what a package's `*.server(def, config)` binder
 * returns, ready to hand to `implement(api).middleware(bound)`.
 *
 * @typeParam M - the middleware def.
 */
export interface BoundMiddleware<M extends AnyMiddleware> {
  readonly def: M;
  readonly impl: ImplFor<M>;
}

/** The single-key context a {@link provide} middleware contributes: `{ [name]: value }`. */
type Provided<N extends string, V> = { readonly [K in N]: V };

/**
 * The value {@link provide} returns: a middleware **def** that is also its own
 * {@link BoundMiddleware}. Use it directly in a spec chain (`use(svc).group(…)`,
 * `svc.endpoint(…)`) **and** bind it once with `implement(api).middleware(svc)`.
 *
 * The phantoms are pinned concretely (`__opt: []`, `__isLoader: false`) and `impl`
 * is written out (not via `ImplFor`) so the type stays finite.
 *
 * @typeParam N - the context key the value is injected under.
 * @typeParam V - the injected value's type (`io.ctx[name]`).
 */
export interface ProvideMiddleware<N extends string, V> extends Middleware<Provided<N, V>, readonly [], EmptyObject> {
  readonly __opt: readonly [];
  readonly __isLoader: false;
  readonly __lz: z.ZodNever;
  readonly def: ProvideMiddleware<N, V>;
  readonly impl: MiddlewareFn<EmptyObject, Provided<N, V>>;
}

/**
 * Create a middleware that **injects a typed value** onto the handler context under
 * `name` — the one-call form of `middleware(name, { provides: ctx<{ [name]: V }>() })`
 * plus its impl. Hand it a function, a service object, config, or any data, and every
 * endpoint whose chain includes it reads `io.ctx[name]`.
 *
 * The result is **both** the def (use it in the spec: `use(svc).group(…)` /
 * `svc.endpoint(…)`) and the bound def+impl (bind it once:
 * `implement(api).middleware(svc)`).
 *
 * @typeParam N - the context key (a string literal).
 * @typeParam V - the injected value's type.
 * @param name  - the key the value is injected under (also the middleware name).
 * @param value - the value to inject, or a factory `(io) => value` re-run per
 *   invocation (may be async). A **callable** `value` is treated as a factory — to
 *   inject a bare function as the value, wrap it: `provide('fn', () => myFn)`.
 *
 * @example
 * ```ts
 * const services = provide('services', { db, mailer });        // shared.ts / spec
 * export const api = spec({ endpoints: { ...services.group({ sendInvite }) } });
 * implement(api).middleware(services);                          // server.ts (bind once)
 * // handler: ({ services }) => services.mailer.send(…)
 * ```
 */
export function provide<const N extends string, V>(
  name: N,
  value: V | ((io: MiddlewareIO<EmptyObject>) => V | Promise<V>),
): ProvideMiddleware<N, V> {
  const def = middleware(name, { provides: ctx<Provided<N, V>>() });
  const impl: MiddlewareFn<EmptyObject, Provided<N, V>> = async (io) => {
    const v: V = typeof value === 'function' ? await (value as (io: MiddlewareIO<EmptyObject>) => V | Promise<V>)(io) : value;
    return io.next({ [name]: v } as Provided<N, V>);
  };
  return Object.assign(def, { def, impl }) as unknown as ProvideMiddleware<N, V>; // internal cast: the def doubles as its own bound pair
}

/**
 * Middleware-level OpenAPI contributions, applied to every operation whose chain
 * includes the middleware.
 */
export interface MiddlewareDoc {
  /** Named security schemes — merged into `components.securitySchemes` and required on each op. */
  readonly security?: Readonly<Record<string, Json>>;
  /** Patch applied to every operation whose chain includes this middleware. */
  readonly openapi?: (op: Record<string, Json>) => Record<string, Json>;
}

/**
 * Expand `requires` (auto-include) and topologically order a middleware list.
 *
 * `requires` edges pull dependencies in and force them earlier; `optional` edges
 * only reorder middleware that are *already present*. Throws on a dependency
 * cycle.
 *
 * @internal
 */
export function resolveChain(mws: readonly AnyMiddleware[]): AnyMiddleware[] {
  const present = new Set<AnyMiddleware>();
  const order: AnyMiddleware[] = [];
  const visit = (m: AnyMiddleware, trail: Set<AnyMiddleware>) => {
    if (present.has(m)) {return;}
    if (trail.has(m)) {throw new Error(`middleware cycle involving "${m.name}"`);}
    trail.add(m);
    for (const r of m.requires) {visit(r, trail);}
    trail.delete(m);
    present.add(m);
    order.push(m);
  };
  for (const m of mws) {visit(m, new Set());}
  // stable pass: ensure optionals that ARE present run before their dependents
  const idx = new Map(order.map((m, i) => [m, i] as const));
  const sorted = [...order].sort((a, b) => {
    if (a.optional.includes(b)) {return 1;}
    if (b.optional.includes(a)) {return -1;}
    return idx.get(a)! - idx.get(b)!;
  });
  return sorted;
}
