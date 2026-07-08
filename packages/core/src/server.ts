/**
 * # Server
 *
 * The fetch-native server. {@link server} takes a {@link AnySpec | spec} and
 * handler bags and returns a {@link Server} whose `fetch(Request) => Response` is
 * the whole HTTP surface, plus a `ws` object (`open`/`message`/`close`) that
 * speaks the JSON frame protocol. Everything is web-standard `Request`/`Response`
 * /streams — Node/Express/etc. live in adapters at the edge, never here.
 *
 * Responsibilities: middleware chain execution, payload assembly from the single
 * `data` kind tables, HTTP body parsing (JSON/urlencoded/multipart/raw/items),
 * raw + item + SSE streaming with Range/206/HEAD, CORS, the WebSocket call /
 * stream / sub-unsub protocol, event fanout through the {@link Broker}, and
 * OpenAPI/AsyncAPI generation (delegated to {@link buildOpenapi}/{@link buildAsyncapi}).
 *
 * @module
 */

import { z } from 'zod';
import type { Json } from './types';
import { ApiError, ApiFailure, reject } from './errors';
import type { Broker } from './broker';
import { localBroker } from './broker';
import type { Manifest, ManifestEndpoint, ManifestEvent } from './manifest';
import type { AnySpec, AnyEndpoint, NormalizedEp, CookieOptions, EventConfig, SpecDoc } from './endpoint';
import { normalizeEndpoint, objectKeys } from './endpoint';
import type { AnyMiddleware, RouteInfo, Transport, WsFrameInfo, ImplFor, BoundMiddleware } from './middleware';
import { resolveChain } from './middleware';
import type { PathPart } from './path';
import { matchParts } from './path';
import type { EmitFn, HandlerFor, ClientData, CallReturn } from './payload';
import { buildOpenapi } from './openapi';
import { buildAsyncapi } from './asyncapi';
import type { DocsOptions } from './docs-ui';
import { normalizeDocs, swaggerHtml, redocHtml, asyncapiHtml } from './docs-ui';

/* ---- internal constants ---- */
/** Readable-side highWaterMark for the `$out` transform: accept the first chunk before a reader attaches so headers can commit. */
const OUT_HIGH_WATER_MARK = 1;
/** Synthetic status for an aborted/cancelled call (no HTTP response is produced). */
const ABORTED_STATUS = 0;

/* internal: cookie header codec */
function parseCookieHeader(header: string | null): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) {return out;}
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) {continue;}
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
function serializeCookie(name: string, value: string, o?: CookieOptions): string {
  let s = `${name}=${encodeURIComponent(value)}`;
  if (o?.path) {s += `; Path=${o.path}`;}
  if (o?.domain) {s += `; Domain=${o.domain}`;}
  if (o?.maxAge !== undefined) {s += `; Max-Age=${o.maxAge}`;}
  if (o?.expires) {s += `; Expires=${o.expires.toUTCString()}`;}
  if (o?.httpOnly) {s += '; HttpOnly';}
  if (o?.secure) {s += '; Secure';}
  if (o?.sameSite) {s += `; SameSite=${o.sameSite}`;}
  return s;
}

/** internal: the accumulated handler + middleware-impl bindings behind an {@link Implementor}. */
interface ImplBag {
  readonly handlers: Map<string, (payload: never) => unknown>;
  readonly middleware: Map<AnyMiddleware, AnyFn>;
}

/**
 * Returned by {@link implement} — a chainable builder that accumulates endpoint
 * handlers and middleware impls for a spec. Bind middleware defs to their runtime
 * fns with {@link Implementor.middleware | .middleware}, and endpoint handlers with
 * {@link Implementor.handlers | .handlers}/{@link Implementor.handle | .handle}.
 * Hand the builder(s) to {@link server}, which requires every endpoint to have
 * exactly one handler and every chain middleware to be bound.
 *
 * @typeParam HK - the union of endpoint names handled so far (drives {@link server}'s
 *   missing-handler compile check).
 */
export interface Implementor<S extends AnySpec, HK extends keyof S['endpoints'] & string = never> {
  /** Bind a middleware **def** to its runtime impl (or a loader def to its loader impl). */
  middleware<M extends AnyMiddleware>(def: M, impl: ImplFor<M>): Implementor<S, HK>;
  /** Bind a package-built `{ def, impl }` pair (e.g. `bearerAuth.server(def, cfg)`). */
  middleware<M extends AnyMiddleware>(bound: BoundMiddleware<M>): Implementor<S, HK>;
  /** Provide a bag of handlers (a partial map of endpoint name → handler). */
  handlers<K extends keyof S['endpoints'] & string>(h: { [P in K]: HandlerFor<S, S['endpoints'][P]> }): Implementor<S, HK | K>;
  /** Provide a single handler by name. */
  handle<K extends keyof S['endpoints'] & string>(name: K, fn: HandlerFor<S, S['endpoints'][K]>): Implementor<S, HK | K>;
  /** @internal the accumulated bindings — read by {@link server}. */
  readonly __bag: ImplBag;
  /** @internal type-only carrier of the handled-endpoint union — matched by {@link server} without expanding the methods. */
  readonly __hk?: HK;
}

/**
 * Begin implementing a spec. The returned {@link Implementor} is a chainable
 * builder: bind middleware impls with `.middleware(def, impl)` and endpoint
 * handlers with `.handlers({...})`/`.handle(name, fn)`, then hand it to
 * {@link server}. Split work across multiple `implement()` builders if you like —
 * `server()` merges them.
 *
 * @example
 * ```ts
 * const impl = implement(api)
 *   .middleware(auth, async (io) => io.next({ user: await authenticate(io.req) }))
 *   .handlers({ getUser: ({ data }) => loadUser(data.id) })
 * ```
 */
export function implement<S extends AnySpec>(spec: S): Implementor<S> {
  void spec;
  const bag: ImplBag = { handlers: new Map(), middleware: new Map() };
  const self = {
    __bag: bag,
    middleware(defOrBound: AnyMiddleware | { def: AnyMiddleware; impl: AnyFn }, impl?: AnyFn) {
      if (impl) {
        bag.middleware.set(defOrBound as AnyMiddleware, impl);
      } else {
        const b = defOrBound as { def: AnyMiddleware; impl: AnyFn };
        bag.middleware.set(b.def, b.impl);
      }
      return self;
    },
    handlers(h: Record<string, (payload: never) => unknown>) {
      for (const [k, fn] of Object.entries(h)) {
        if (bag.handlers.has(k)) {throw new Error(`duplicate handler for endpoint "${k}"`);}
        bag.handlers.set(k, fn);
      }
      return self;
    },
    handle(name: string, fn: (payload: never) => unknown) {
      if (bag.handlers.has(name)) {throw new Error(`duplicate handler for endpoint "${name}"`);}
      bag.handlers.set(name, fn);
      return self;
    },
  };
  return self as unknown as Implementor<S>; // internal cast: one mutable builder object backs the evolving HK type
}

/** A live WebSocket connection, as seen by the server's ws handler. */
export interface WsConn {
  readonly id: number;
  readonly req: Request;
  /** internal */ readonly send: (frame: string) => void;
  /** internal */ readonly subs: Set<string>;
  /** internal */ readonly streams: Map<string, { push(v: unknown): void; end(): void; fail(err: unknown): void }>;
  /** internal: per-call abort controllers, so an `{ id, abort: true }` frame can cancel a call */
  readonly calls: Map<string, AbortController>;
}

/** Cross-origin resource sharing configuration. */
export interface CorsOptions {
  /** Allowed origin(s): `'*'`, a single origin, or an allow-list. */
  readonly origin: '*' | string | readonly string[];
  /** Whether to send `Access-Control-Allow-Credentials`. */
  readonly credentials?: boolean;
  /** Preflight cache duration (seconds). */
  readonly maxAge?: number;
  /** Response headers to expose to the browser. */
  readonly exposeHeaders?: readonly string[];
}

/** Options for {@link server}. */
export interface ServerOptions {
  readonly cors?: CorsOptions;
  /** Event fanout across server instances (default: in-process {@link localBroker}). */
  readonly broker?: Broker;
  /**
   * Serve interactive API documentation. `true` mounts the defaults
   * (`/openapi.json`, `/asyncapi.json`, `/docs` Swagger UI, `/redoc`, `/asyncapi`);
   * pass a {@link DocsOptions} object to customize paths or disable pages. The
   * spec JSON is generated once and cached in memory.
   */
  readonly docs?: boolean | DocsOptions;
}

/** The assembled server: a fetch handler, a ws handler, the manifest, `emit`, and doc generators. */
export interface Server<S extends AnySpec> {
  readonly spec: S;
  /** The entire HTTP surface — pass any `Request`, get a `Response`. */
  fetch(req: Request): Promise<Response>;
  /** The zod-free runtime manifest the client routes from (also derivable via {@link manifestFromSpec}). */
  manifest(): Manifest;
  /** Publish a typed event to all subscribers (across instances via the {@link Broker}). */
  emit: EmitFn<S>;
  /** Generate the OpenAPI 3.1 document. */
  openapi(info?: { title?: string; version?: string }): Json;
  /** Generate the AsyncAPI 3.0 document. */
  asyncapi(info?: { title?: string; version?: string }): Json;
  /**
   * Call one of this server's endpoints **in-process** by name with just its data
   * payload — runs the full middleware chain + validation, but skips HTTP
   * serialization. The invocation's `io.transport` is `'local'`. Pass `headers` via
   * `opts` to satisfy auth-style middleware. Streaming/file endpoints are best
   * called over a {@link client} instead.
   *
   * The result is loosely typed here (a low-level escape hatch) — for the typed
   * surface use {@link localClient}, which returns a {@link LocalClient}.
   */
  call<K extends keyof S['endpoints'] & string>(name: K, ...args: LocalCallArgs<S['endpoints'][K]>): Promise<unknown>;
  /**
   * Mount another spec + its builders into this **running** server — its endpoints,
   * events, routes, and middleware go live immediately and the manifest/docs caches
   * refresh. Typed like {@link server}: every endpoint needs a handler and every
   * chain middleware a binding (a shared middleware def already bound by an earlier
   * mount is reused, not re-bound). Collisions (endpoint name / route / ws / event)
   * throw. Returns a {@link MountHandle} for {@link Server.uninstall}.
   */
  install<S2 extends AnySpec, const H2 extends readonly { readonly __hk?: keyof S2['endpoints'] & string }[]>(
    spec: S2,
    builders: H2,
    ...rest: [MissingHandlers<S2, H2>] extends [never] ? [] : [error: { readonly missingHandlers: MissingHandlers<S2, H2> }]
  ): MountHandle;
  /** Remove a previously {@link Server.install | installed} mount — deletes exactly its endpoints, events, routes, and bindings, and clears its subscriptions. */
  uninstall(handle: MountHandle): void;
  /** WebSocket lifecycle hooks for an adapter to drive. */
  readonly ws: {
    /** Register a new connection given its `send` and the upgrade `Request`. */
    open(send: (frame: string) => void, req: Request): WsConn;
    /** Handle one inbound text frame. */
    message(conn: WsConn, raw: string): Promise<void>;
    /** Tear down a connection (cleans up its subscriptions). */
    close(conn: WsConn): void;
  };
}

/** Per-call options for an in-process {@link Server.call} / {@link LocalClient}. */
export interface LocalCallOptions {
  /** Request headers visible to the chain (e.g. an `authorization` token for auth middleware). */
  readonly headers?: Readonly<Record<string, string>>;
  /** Abort signal for the call. */
  readonly signal?: AbortSignal;
}
/** The arguments an in-process call takes: `[opts?]` when the endpoint has no input, else `[data, opts?]`. */
type LocalCallArgs<E extends AnyEndpoint> = [keyof ClientData<E>] extends [never]
  ? [opts?: LocalCallOptions]
  : [data: ClientData<E>, opts?: LocalCallOptions];

/**
 * A typed in-process caller for a spec's endpoints — the no-serialization loopback
 * over {@link Server.call}, retyped against `S`. Use it to invoke another spec's
 * endpoints (e.g. a dependency's) from server-side code with just a data payload.
 */
export interface LocalClient<S extends AnySpec> {
  call<K extends keyof S['endpoints'] & string>(name: K, ...args: LocalCallArgs<S['endpoints'][K]>): CallReturn<S['endpoints'][K]>;
}

/**
 * View a running {@link Server} as a typed {@link LocalClient} for spec `S` — for
 * calling endpoints in-process (full chain + validation, no HTTP) by name + data.
 *
 * @param app  - the running server (its `call` is the in-process caller).
 * @param spec - the spec to type against (its endpoints/`CallReturn` shape `S`).
 *
 * @example
 * ```ts
 * const users = localClient(app, usersSpec);
 * const u = await users.call('getUser', { id: 'u1' });   // typed, in-process
 * ```
 */
export function localClient<S extends AnySpec>(app: Server<AnySpec>, spec?: S): LocalClient<S> {
  void spec;
  return app as unknown as LocalClient<S>; // internal cast: Server.call IS the in-process caller; retype it against S
}

/** The endpoint-name union a builder has handled — read off its `__hk` phantom (never expands the methods). */
type BuilderKeys<B> = B extends { readonly __hk?: infer K } ? K : never;
/** Endpoint names with no handler across the supplied builders — surfaced as a compile error. */
type MissingHandlers<S extends AnySpec, H extends readonly unknown[]> = Exclude<keyof S['endpoints'] & string, BuilderKeys<H[number]>>;

/* internal runtime payload bag */
type Bag = Record<string, unknown>;
/** Loosest internal function type — replaces the banned `Function` in plumbing signatures. */
type AnyFn = (...args: never[]) => unknown;
/** internal: a normalized event with its guard chain bound — held in the live `events` registry. */
interface LiveEvent {
  readonly name: string;
  readonly cfg: EventConfig;
  readonly ws: string;
  readonly chain: AnyMiddleware[];
}

/**
 * An opaque handle to a mounted spec, returned by {@link Server.install} and passed
 * back to {@link Server.uninstall} to remove exactly what that install added.
 */
export interface MountHandle {
  /** @internal the normalized endpoints this mount added. */
  readonly eps: readonly NormalizedEp[];
  /** @internal the live events this mount added. */
  readonly events: readonly LiveEvent[];
  /** @internal the middleware defs this mount bound (removed from the global impl map on uninstall). */
  readonly impls: readonly AnyMiddleware[];
  /** @internal this mount's spec-level doc patch, if any. */
  readonly doc: SpecDoc | undefined;
}

/**
 * Assemble a {@link Server} from a spec and one or more {@link implement} builders.
 *
 * Every endpoint must have exactly one handler: a missing handler is a **compile
 * error** that names the offending endpoints (via the final `error` argument), and
 * a duplicate/unknown handler throws at startup. Every middleware in an endpoint or
 * event-guard chain must be bound via `.middleware(def, impl)` — an unbound def
 * throws at assembly.
 *
 * @param spec     - the validated spec from {@link spec}.
 * @param builders - one or more builders from {@link implement}.
 * @param rest     - `[options?]` when all handlers are present, else `[{ missingHandlers }]`.
 *
 * @example
 * ```ts
 * const app = server(api, [implement(api).middleware(auth, authImpl).handlers({ … })], { cors, broker })
 * const res = await app.fetch(new Request('http://x/getUser/u1', { method: 'POST' }))
 * ```
 */
export function server<S extends AnySpec, const H extends readonly { readonly __hk?: keyof S['endpoints'] & string }[]>(
  spec: S,
  builders: H,
  ...rest: [MissingHandlers<S, H>] extends [never]
    ? [options?: ServerOptions]
    : [error: { readonly missingHandlers: MissingHandlers<S, H> }]
): Server<S> {
  const options = rest[0] as ServerOptions | undefined; // internal cast: the error branch never reaches runtime

  /* ---- mutable live registries (shared by boot + install/uninstall) ---- */
  const table = new Map<string, (payload: never) => unknown>();
  const implMap = new Map<AnyMiddleware, AnyFn>();
  const eps: NormalizedEp[] = [];
  const routes: { e: NormalizedEp; parts: readonly PathPart[] }[] = [];
  const events: LiveEvent[] = [];
  const byName = new Map<string, NormalizedEp>();
  const byWs = new Map<string, NormalizedEp>();
  const byRoute = new Map<string, NormalizedEp>();
  const boundChains = new Map<NormalizedEp, AnyMiddleware[]>();
  const eventsByWs = new Map<string, LiveEvent>();
  const subscribers = new Map<string, Set<WsConn>>();
  const specDocs: SpecDoc[] = [];

  /* ---- doc/manifest caches (dirtied on every install/uninstall) ---- */
  let manifestCache: Manifest | null = null;
  let openapiJsonCache: string | null = null;
  let asyncapiJsonCache: string | null = null;
  const invalidate = (): void => {
    manifestCache = null;
    openapiJsonCache = null;
    asyncapiJsonCache = null;
  };

  /* ---- bind a resolved chain's defs to their impls (unbound def = assembly error) ---- */
  const bind = (chain: readonly AnyMiddleware[], where: string): AnyMiddleware[] =>
    chain.map((m) => {
      const impl = implMap.get(m);
      if (!impl) {throw new Error(`middleware "${m.name}" (${where}) has no implementation — bind it with implement(api).middleware(def, impl)`);}
      return { ...m, run: impl as AnyMiddleware['run'] };
    });

  /* ---- register a spec + its builders into the live registries (boot + install share this) ---- */
  function register(regSpec: AnySpec, regBuilders: readonly { readonly __bag: ImplBag }[]): MountHandle {
    /* validate handlers + collect impls — dup vs the live table/implMap; unknown/missing vs regSpec */
    const newHandlers: [string, (payload: never) => unknown][] = [];
    const newImpls: [AnyMiddleware, AnyFn][] = [];
    for (const b of regBuilders) {
      for (const [k, fn] of b.__bag.handlers) {
        if (table.has(k) || newHandlers.some(([n]) => n === k)) {throw new Error(`duplicate handler for endpoint "${k}"`);}
        if (!(k in regSpec.endpoints)) {throw new Error(`handler for unknown endpoint "${k}"`);}
        newHandlers.push([k, fn]);
      }
      for (const [def, impl] of b.__bag.middleware) {
        if (implMap.has(def) || newImpls.some(([d]) => d === def)) {throw new Error(`duplicate implementation for middleware "${def.name}"`);}
        newImpls.push([def, impl]);
      }
    }
    for (const k of Object.keys(regSpec.endpoints)) {if (!newHandlers.some(([n]) => n === k)) {throw new Error(`missing handler for endpoint "${k}"`);}}

    /* normalize new endpoints + collision-check name/route/ws against the live set */
    const newEps = Object.entries(regSpec.endpoints).map(([name, def]) => normalizeEndpoint(name, def));
    for (const e of newEps) {
      // a duplicate endpoint *name* is already caught above by the handler-dup check (every endpoint has a handler)
      if (e.wsEligible && byRoute.has(`${e.method} ${e.path}`)) {throw new Error(`route "${e.method} ${e.path}" is already installed`);}
      if (e.ws !== null && e.wsEligible && (byWs.has(e.ws) || eventsByWs.has(e.ws))) {throw new Error(`ws id "${e.ws}" is already installed`);}
    }
    const newEvents = Object.entries(regSpec.events ?? {}).map(([name, cfg]) => ({ name, cfg, ws: cfg.ws ?? name }));
    for (const ev of newEvents) {
      if (events.some((x) => x.name === ev.name)) {throw new Error(`event "${ev.name}" is already installed`);}
      if (eventsByWs.has(ev.ws) || byWs.has(ev.ws) || newEps.some((e) => e.ws === ev.ws)) {throw new Error(`event channel "${ev.ws}" collides with an existing channel or ws id`);}
    }

    /* commit — impls first so the chains below can bind against them */
    for (const [def, impl] of newImpls) {implMap.set(def, impl);}
    for (const [k, fn] of newHandlers) {table.set(k, fn);}
    for (const e of newEps) {
      boundChains.set(e, bind(e.chain, `endpoint "${e.name}"`));
      byName.set(e.name, e);
      eps.push(e);
      routes.push({ e, parts: e.parts });
      if (e.wsEligible) {byRoute.set(`${e.method} ${e.path}`, e);}
      if (e.ws !== null && e.wsEligible) {byWs.set(e.ws, e);}
    }
    const liveEvents: LiveEvent[] = newEvents.map((ev) => ({ ...ev, chain: bind(resolveChain(ev.cfg.guard ?? []), `event "${ev.name}"`) }));
    for (const ev of liveEvents) {
      events.push(ev);
      eventsByWs.set(ev.ws, ev);
    }
    if (regSpec.doc) {specDocs.push(regSpec.doc);}
    invalidate();
    return { eps: newEps, events: liveEvents, impls: newImpls.map(([d]) => d), doc: regSpec.doc };
  }

  /* ---- remove exactly what a mount added (used by uninstall) ---- */
  function unregister(handle: MountHandle): void {
    for (const e of handle.eps) {
      boundChains.delete(e);
      byName.delete(e.name);
      table.delete(e.name);
      if (e.wsEligible) {byRoute.delete(`${e.method} ${e.path}`);}
      if (e.ws !== null && e.wsEligible) {byWs.delete(e.ws);}
      const ri = routes.findIndex((r) => r.e === e);
      if (ri >= 0) {routes.splice(ri, 1);}
      const ei = eps.indexOf(e);
      if (ei >= 0) {eps.splice(ei, 1);}
    }
    for (const ev of handle.events) {
      const i = events.indexOf(ev);
      if (i >= 0) {events.splice(i, 1);}
      eventsByWs.delete(ev.ws);
      for (const key of [...subscribers.keys()]) {if (key === ev.ws || key.startsWith(`${ev.ws}|`)) {subscribers.delete(key);}}
    }
    for (const def of handle.impls) {implMap.delete(def);}
    if (handle.doc) {
      const di = specDocs.indexOf(handle.doc);
      if (di >= 0) {specDocs.splice(di, 1);}
    }
    invalidate();
  }

  /* ---- boot: register the base spec + builders ---- */
  register(spec, builders as unknown as readonly { readonly __bag: ImplBag }[]); // internal cast: H elements are Implementors carrying `__bag`

  /* ---- live manifest + composed doc patches (rebuilt lazily after install/uninstall) ---- */
  const buildManifest = (): Manifest => ({
    endpoints: Object.fromEntries(
      eps.map((e) => [
        e.name,
        {
          method: e.method, path: e.path, ws: e.ws, httpOnly: e.httpOnly, streamIn: e.streamInCt, itemsIn: e.itemsIn,
          streamOut: e.streamOutCt, items: e.items, p: e.p, q: e.q, b: e.bRaw ? 'raw' : e.b, f: e.f,
          hasBody: Boolean(e.def.cfg.body), hasHeaders: Boolean(e.def.cfg.headers), multi: e.multi, bodyEnc: e.bodyEnc,
          sideEffects: e.def.cfg.sideEffects,
        } satisfies ManifestEndpoint,
      ]),
    ),
    events: Object.fromEntries(events.map((ev) => [ev.name, { ws: ev.ws, hasParams: Boolean(ev.cfg.params) } satisfies ManifestEvent])),
  });
  const getManifest = (): Manifest => (manifestCache ??= buildManifest());
  /** Compose every installed spec's doc patches into one (applied last, in install order). */
  const composeDoc = (): SpecDoc => ({
    openapi: (doc) => specDocs.reduce((acc, d) => (d.openapi ? d.openapi(acc) : acc), doc),
    asyncapi: (doc) => specDocs.reduce((acc, d) => (d.asyncapi ? d.asyncapi(acc) : acc), doc),
  });

  /* ---- documentation routes (spec JSON cached in memory; invalidated on install/uninstall) ---- */
  const docs = normalizeDocs(options?.docs);
  const openapiJson = () => (openapiJsonCache ??= JSON.stringify(buildOpenapi(eps, composeDoc(), docs?.info)));
  const asyncapiJson = () => (asyncapiJsonCache ??= JSON.stringify(buildAsyncapi(eps, events, composeDoc(), docs?.info)));
  const jsonDoc = (body: string) => new Response(body, { headers: { 'content-type': 'application/json; charset=utf-8' } });
  const htmlDoc = (body: string) => new Response(body, { headers: { 'content-type': 'text/html; charset=utf-8' } });
  function docResponse(pathname: string): Response | null {
    if (!docs) {return null;}
    if (docs.openapiJson && pathname === docs.openapiJson) {return jsonDoc(openapiJson());}
    if (docs.asyncapiJson && pathname === docs.asyncapiJson) {return jsonDoc(asyncapiJson());}
    if (docs.swagger && docs.openapiJson && pathname === docs.swagger) {return htmlDoc(swaggerHtml(docs.openapiJson));}
    if (docs.redoc && docs.openapiJson && pathname === docs.redoc) {return htmlDoc(redocHtml(docs.openapiJson));}
    if (docs.asyncapi && docs.asyncapiJson && pathname === docs.asyncapi) {return htmlDoc(asyncapiHtml(docs.asyncapiJson));}
    return null;
  }

  /* ---- middleware chain runner (internals; loose types confined here) ---- */
  /** Per-invocation context threaded onto every middleware `io`: route identity, transport, signal, response meta, and ws frame. */
  interface ChainInfo {
    readonly route: RouteInfo;
    readonly transport: Transport;
    readonly signal: AbortSignal;
    readonly meta: ResponseMeta | undefined;
    readonly ws?: WsFrameInfo;
    /** The raw, pre-validation body exposed to middleware as `io.body` (absent for event guards). */
    readonly body?: unknown;
  }

  async function runChain(
    chain: readonly AnyMiddleware[],
    req: Request,
    rawParams: Record<string, unknown>,
    terminal: (ctx: Bag, loaderVals: Bag) => Promise<unknown>,
    info: ChainInfo,
  ): Promise<unknown> {
    const fns = metaFns(info.meta);
    let ctx: Bag = {};
    const loaderVals: Bag = {};
    const step = async (i: number): Promise<unknown> => {
      if (i >= chain.length) {return terminal(ctx, loaderVals);}
      const m = chain[i]!;
      let nextCalled = false;
      const io: Bag = {
        req,
        body: info.body,
        get ctx() {
          return ctx;
        },
        next: async (add?: Bag) => {
          nextCalled = true;
          if (add) {ctx = { ...ctx, ...add };}
          return step(i + 1);
        },
        transport: info.transport,
        route: info.route,
        signal: info.signal,
        setHeader: fns.setHeader,
        status: fns.status,
      };
      if (info.ws) {io.ws = info.ws;}
      if (m.paramKey && m.paramSchema) {
        if (!(m.paramKey in rawParams)) {throw reject(400, 'BAD_REQUEST', `missing path param "${m.paramKey}"`);}
        const v = m.paramSchema.parse(rawParams[m.paramKey]);
        io.value = v;
        loaderVals[m.paramKey] = v;
      }
      const out = await (m.run as unknown as (io: Bag) => Promise<unknown>)(io); // internal cast: erased middleware run signature
      if (out instanceof Response) {return out;} // short-circuit: skip the rest of the chain + the handler
      if (!nextCalled) {throw new Error(`middleware "${m.name}" returned without calling next()`);}
      return out;
    };
    return step(0);
  }

  /* ---- payload assembly ---- */
  interface ResponseMeta {
    status: number | null;
    headers: [string, string][];
    length: number | null;
    committed: boolean;
  }
  const makeMeta = (): ResponseMeta => ({ status: null, headers: [], length: null, committed: false });
  const metaFns = (meta: ResponseMeta | undefined) => ({
    status: (code: number) => {
      if (!meta) {return;} // non-HTTP transport: response meta is a no-op
      if (meta.committed) {throw new Error('$status must be called before the response is committed');}
      meta.status = code;
    },
    setHeader: (name: string, value: string) => {
      if (!meta) {return;}
      if (meta.committed) {throw new Error('$setHeader must be called before the response is committed');}
      meta.headers.push([name, value]);
    },
    setCookie: (name: string, value: string, opts?: CookieOptions) => {
      if (!meta) {return;}
      if (meta.committed) {throw new Error('$setCookie must be called before the response is committed');}
      meta.headers.push(['set-cookie', serializeCookie(name, value, opts)]);
    },
  });

  interface StreamCtl {
    readonly out: WritableStream<Uint8Array | string>;
    readonly download: (filename: string, contentType?: string) => void;
    readonly length: (totalBytes: number) => void;
  }

  /** disjoint kinds: split a flat data payload back into p/q/b by the endpoint's key tables */
  function kindsFromData(e: NormalizedEp, data: unknown): { p: Bag; q: Bag; b: unknown } {
    if (e.bRaw) {return { p: {}, q: {}, b: data };}
    const p: Bag = {};
    const q: Bag = {};
    const b: Bag = {};
    const pSet = new Set(e.p);
    const qSet = new Set(e.q);
    const bSet = new Set(e.b ?? []);
    const fSet = new Set(e.f);
    for (const [k, v] of Object.entries((data as Bag | undefined) ?? {})) {
      if (pSet.has(k)) {p[k] = v;}
      else if (qSet.has(k)) {q[k] = v;}
      else if (bSet.has(k)) {b[k] = v;}
      /* v8 ignore next */ // reason: file kinds force httpOnly, so a file key can never reach the ws-only kindsFromData path
      else if (fSet.has(k)) {continue;}
      else {throw reject(400, 'VALIDATION', `key "${k}" does not belong to this endpoint`);}
    }
    return { p, q, b: e.b !== null ? b : undefined };
  }

  /** root payload names owned by the framework — middleware ctx may not collide with them */
  const RESERVED_CTX = new Set([
    'data', 'stream', 'headers', 'cookies',
    'out', 'download', 'length', 'fail', 'status', 'header', 'cookie', 'req', 'signal', 'emit',
  ]);

  function assemble(
    e: NormalizedEp,
    ctx: Bag,
    kinds: { p: Bag; q: Bag; b: unknown; f: Bag; stream?: ReadableStream<Uint8Array> | AsyncIterable<unknown>; h?: Bag; ck?: Bag },
    req: Request,
    signal: AbortSignal,
    streamCtl: StreamCtl | undefined,
    meta: ResponseMeta | undefined,
  ): Bag {
    /* kinds are disjoint by construction — merge is lossless; a raw body IS the data */
    const data: unknown = e.bRaw ? kinds.b : { ...kinds.p, ...kinds.q, ...(e.b !== null ? (kinds.b as Bag) : {}), ...kinds.f };
    const payload: Bag = {};
    for (const [k, v] of Object.entries(ctx)) {
      if (RESERVED_CTX.has(k)) {throw new Error(`middleware ctx key "${k}" collides with a reserved payload name`);}
      payload[k] = v;
    }
    if (e.bRaw || Object.keys(data as Bag).length > 0) {payload.data = data;}
    if (kinds.stream) {payload.stream = kinds.stream;}
    if (streamCtl) {
      payload.out = streamCtl.out;
      payload.download = streamCtl.download;
      payload.length = streamCtl.length;
    }
    if (e.def.cfg.headers) {payload.headers = kinds.h;}
    if (e.def.cfg.cookies) {payload.cookies = kinds.ck;}
    const errors = e.def.cfg.errors;
    if (errors && Object.keys(errors).length > 0) {
      payload.fail = (status: number, data2: unknown): never => {
        const schema = errors[status];
        if (!schema) {throw new Error(`endpoint "${e.name}": fail(${status}) is not a declared error status`);}
        throw new ApiFailure(status, schema.parse(data2));
      };
    }
    const fns = metaFns(meta);
    payload.status = fns.status;
    payload.header = fns.setHeader;
    payload.cookie = fns.setCookie;
    payload.req = req;
    payload.signal = signal;
    payload.emit = emit;
    return payload;
  }

  async function parseFiles(e: NormalizedEp, form: FormData): Promise<{ files: Bag; body: unknown }> {
    const files: Bag = {};
    for (const [key, schema] of Object.entries(e.def.cfg.files ?? {})) {
      const all = form.getAll(key).filter((v) => typeof v !== 'string');
      const wantsArray = schema instanceof z.ZodArray || (schema instanceof z.ZodOptional && schema.unwrap() instanceof z.ZodArray);
      const raw = wantsArray ? all : all[0];
      files[key] = schema.parse(raw);
    }
    const rawBody = form.get('body');
    const body = typeof rawBody === 'string' ? JSON.parse(rawBody) : undefined;
    return { files, body };
  }

  function queryToObject(e: NormalizedEp, sp: URLSearchParams): Bag {
    const out: Bag = {};
    for (const k of e.q) {
      const vals = sp.getAll(k);
      if (vals.length === 0) {continue;}
      out[k] = vals.length === 1 ? vals[0] : vals;
    }
    return out;
  }

  async function invoke(
    e: NormalizedEp,
    req: Request,
    rawParams: Record<string, unknown>,
    rawQuery: Bag,
    rawBody: unknown,
    rawFiles: Bag | null,
    stream: ReadableStream<Uint8Array> | AsyncIterable<unknown> | undefined,
    streamCtl: StreamCtl | undefined,
    meta: ResponseMeta | undefined,
    signal: AbortSignal | undefined,
    chainCtx: { readonly transport: Transport; readonly ws?: WsFrameInfo },
  ): Promise<unknown> {
    const route: RouteInfo = { kind: 'endpoint', name: e.name, method: e.method, path: e.path, ws: e.ws };
    return runChain(boundChains.get(e)!, req, rawParams, async (ctx, loaderVals) => {
      const c = e.def.cfg;
      const cfgParamKeys = (objectKeys(c.params) ?? []).filter((k) => !e.loaders.has(k) && !e.tplSchemas.has(k));
      const picked: Bag = {};
      for (const k of cfgParamKeys) {picked[k] = rawParams[k];}
      const tplVals: Bag = {};
      for (const [k, schema] of e.tplSchemas) {tplVals[k] = schema.parse(rawParams[k]);}
      const p: Bag = { ...loaderVals, ...tplVals, ...(c.params ? (c.params.parse(picked) as Bag) : {}) };
      const q: Bag = c.query ? (c.query.parse(rawQuery) as Bag) : {};
      const b = c.body ? c.body.parse(rawBody) : undefined;
      const f: Bag = {};
      if (rawFiles) {
        for (const [k, schema] of Object.entries(c.files ?? {})) {f[k] = rawFiles[k] !== undefined ? rawFiles[k] : schema.parse(undefined);}
      }
      let h: Bag | undefined;
      if (c.headers) {
        const raw: Bag = {};
        for (const k of objectKeys(c.headers) ?? []) {
          const v = req.headers.get(k);
          if (v !== null) {raw[k] = v;}
        }
        h = c.headers.parse(raw) as Bag;
      }
      let ck: Bag | undefined;
      if (c.cookies) {ck = c.cookies.parse(parseCookieHeader(req.headers.get('cookie'))) as Bag;}
      const handler = table.get(e.name)! as unknown as (payload: Bag) => unknown; // internal cast: erased handler signature
      const payload = assemble(e, ctx, { p, q, b, f: rawFiles ? f : {}, stream, h, ck }, req, signal ?? req.signal, streamCtl, meta);
      const result = await handler(payload);
      if (c.streamOut) {return result;}
      if (c.responses) {
        const r = result as { status: number; data: unknown }; // internal cast: HandlerReturn guarantees the shape
        const schema = c.responses[r.status];
        if (!schema) {throw new Error(`endpoint "${e.name}": status ${r.status} is not a declared response status`);}
        return { status: r.status, data: schema.parse(r.data) };
      }
      if (c.response) {return c.response.parse(result);}
      return undefined;
    }, { route, transport: chainCtx.transport, signal: signal ?? req.signal, meta, ws: chainCtx.ws, body: rawBody });
  }

  /** In-process call: route by name, split the flat data, run the full chain via {@link invoke} (transport `'local'`). */
  function callLocal(name: string, ...args: readonly unknown[]): Promise<unknown> {
    const e = byName.get(name);
    if (!e) {throw new Error(`unknown endpoint "${name}"`);}
    const hasInput = e.bRaw || e.b !== null || e.p.length > 0 || e.q.length > 0;
    const data = hasInput ? args[0] : undefined;
    const opts = (hasInput ? args[1] : args[0]) as LocalCallOptions | undefined;
    const { p, q, b } = kindsFromData(e, data);
    const req = new Request(`http://local/${name}`, { method: e.method, headers: new Headers(opts?.headers ?? {}) });
    return invoke(e, req, p, q, b, null, undefined, undefined, makeMeta(), opts?.signal, { transport: 'local' });
  }

  function toStream(v: unknown): ReadableStream<Uint8Array> {
    if (v instanceof ReadableStream) {return v;}
    const iter = v as AsyncIterable<string | Uint8Array>; // internal cast: HandlerReturn guarantees the union
    const enc = new TextEncoder();
    return new ReadableStream<Uint8Array>({
      async start(controller) {
        for await (const chunk of iter) {controller.enqueue(typeof chunk === 'string' ? enc.encode(chunk) : chunk);}
        controller.close();
      },
    });
  }

  /** push-based async iterable: ws chunk frames feed it, handlers for-await it */
  interface AsyncQueue<T> extends AsyncIterable<T> {
    push(v: T): void;
    end(): void;
    fail(err: unknown): void;
  }
  function asyncQueue<T>(): AsyncQueue<T> {
    const buf: T[] = [];
    let done = false;
    let err: unknown;
    let wake: (() => void) | null = null;
    return {
      push(v) {
        buf.push(v);
        wake?.();
      },
      end() {
        done = true;
        wake?.();
      },
      fail(e) {
        err = e;
        done = true;
        wake?.();
      },
      async *[Symbol.asyncIterator]() {
        for (;;) {
          if (buf.length > 0) {
            yield buf.shift()!;
            continue;
          }
          if (err !== undefined) {throw err;}
          if (done) {return;}
          await new Promise<void>((r) => (wake = r));
          wake = null;
        }
      },
    };
  }

  /** NDJSON request body → typed async iterable; each item validated as the handler pulls it. */
  async function* decodeItems(body: ReadableStream<Uint8Array>, schema: z.ZodType): AsyncGenerator<unknown, void, undefined> {
    const reader = body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) {break;}
        buf += dec.decode(value, { stream: true });
        let nl;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl);
          buf = buf.slice(nl + 1);
          if (line.trim()) {yield schema.parse(JSON.parse(line));}
        }
      }
      buf += dec.decode();
      if (buf.trim()) {yield schema.parse(JSON.parse(buf));}
    } finally {
      await reader.cancel().catch(() => {});
    }
  }

  /** Identity transform behind `out`: encodes strings, signals the first write, can error mid-stream. */
  function createOut(): {
    readable: ReadableStream<Uint8Array>;
    writable: WritableStream<Uint8Array | string>;
    firstWrite: Promise<void>;
    wrote: () => boolean;
    fail: (err: unknown) => void;
  } {
    const enc = new TextEncoder();
    let wrote = false;
    let resolveFirst!: () => void;
    const firstWrite = new Promise<void>((r) => (resolveFirst = r));
    let ctl!: TransformStreamDefaultController<Uint8Array>;
    const ts = new TransformStream<Uint8Array | string, Uint8Array>(
      {
        start(c) {
          ctl = c;
        },
        transform(chunk, c) {
          if (!wrote) {
            wrote = true;
            resolveFirst();
          }
          c.enqueue(typeof chunk === 'string' ? enc.encode(chunk) : chunk);
        },
      },
      undefined,
      /* readable HWM 1: accept the first chunk before any reader attaches, so headers can commit */
      { highWaterMark: OUT_HIGH_WATER_MARK },
    );
    return {
      readable: ts.readable,
      writable: ts.writable,
      firstWrite,
      wrote: () => wrote,
      fail: (err) => {
        try {
          ctl.error(err);
          /* v8 ignore next 3 */ // reason: defensive — ctl.error() is a no-op (never throws) once the transform has already errored/closed
        } catch {
          /* already errored/closed */
        }
      },
    };
  }

  /** Typed item stream → NDJSON or SSE bytes; each item validated against the schema as it flows. */
  function itemStream(v: unknown, schema: z.ZodType, sse: boolean): ReadableStream<Uint8Array> {
    const iter = v as AsyncIterable<unknown>; // internal cast: HandlerReturn guarantees AsyncIterable
    const it = iter[Symbol.asyncIterator]();
    const enc = new TextEncoder();
    return new ReadableStream<Uint8Array>({
      async pull(controller) {
        const { done, value } = await it.next();
        if (done) {return controller.close();}
        const json = JSON.stringify(schema.parse(value));
        controller.enqueue(enc.encode(sse ? `data: ${json}\n\n` : json + '\n'));
      },
      async cancel() {
        await it.return?.(undefined);
      },
    });
  }

  /** Byte-range slicer for resumable downloads: skip `start`, stop after `end` (inclusive). */
  function sliceStream(src: ReadableStream<Uint8Array>, start: number, end: number): ReadableStream<Uint8Array> {
    let pos = 0;
    const reader = src.getReader();
    return new ReadableStream<Uint8Array>({
      async pull(controller) {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) {return controller.close();}
          const from = pos;
          pos += value.byteLength;
          if (pos <= start) {continue;}
          const sliceFrom = Math.max(0, start - from);
          const sliceTo = Math.min(value.byteLength, end + 1 - from);
          controller.enqueue(value.subarray(sliceFrom, sliceTo));
          if (pos > end) {
            await reader.cancel().catch(() => {});
            return controller.close();
          }
          return;
        }
      },
      async cancel() {
        await reader.cancel().catch(() => {});
      },
    });
  }

  function parseRange(header: string | null): { start: number; end: number | null } | null {
    const m = header ? /^bytes=(\d+)-(\d*)$/.exec(header) : null;
    if (!m) {return null;}
    return { start: Number(m[1]), end: m[2] ? Number(m[2]) : null };
  }

  function errorResponse(err: unknown): Response {
    if (err instanceof ApiFailure) {
      return Response.json(err.data as Json, { status: err.status });
    }
    if (err instanceof ApiError) {
      return Response.json({ error: { code: err.code, message: err.message } }, { status: err.status });
    }
    if (err instanceof z.ZodError) {
      return Response.json({ error: { code: 'VALIDATION', issues: err.issues } }, { status: 400 });
    }
    return Response.json({ error: { code: 'INTERNAL', message: err instanceof Error ? err.message : 'internal error' } }, { status: 500 });
  }

  /* ---- HTTP ---- */
  async function fetchHandler(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (req.method === 'GET') {
      const doc = docResponse(url.pathname);
      if (doc) {return doc;}
    }
    const effMethod = req.method === 'HEAD' ? 'GET' : req.method;
    for (const { e, parts } of routes) {
      if (effMethod !== e.method) {continue;}
      const matched = matchParts(parts, url.pathname);
      if (!matched) {continue;}
      try {
        const rawParams: Record<string, unknown> = { ...matched };
        const c = e.def.cfg;
        let rawBody: unknown;
        let rawFiles: Bag | null = null;
        let stream: ReadableStream<Uint8Array> | AsyncIterable<unknown> | undefined;
        if (c.streamIn) {
          const body = req.body ?? new ReadableStream<Uint8Array>({ start: (ctl) => ctl.close() });
          stream = e.itemsIn ? decodeItems(body, c.streamIn as z.ZodType) : body;
        } else if (e.f.length > 0) {
          const parsed = await parseFiles(e, await req.formData());
          rawFiles = parsed.files;
          rawBody = parsed.body;
        } else if (c.body) {
          if (e.bodyEnc === 'urlencoded') {
            const form = new URLSearchParams(await req.text());
            const obj: Bag = {};
            for (const k of new Set(form.keys())) {
              const all = form.getAll(k);
              obj[k] = all.length === 1 ? all[0] : all;
            }
            rawBody = obj;
          } else {
            rawBody = await req.json();
          }
        }
        const rawQuery = queryToObject(e, url.searchParams);
        const meta = makeMeta();

        /* raw byte stream: respond on first write OR handler settle, whichever comes first */
        if (c.streamOut && !e.items) {
          const t = createOut();
          const dl = { filename: (c.download ?? null) as string | null, ct: e.streamOutCt!, committed: false };
          const download = (filename: string, contentType?: string) => {
            if (dl.committed) {throw new Error('$download must be called before streaming starts');}
            dl.filename = filename;
            if (contentType) {dl.ct = contentType;}
          };
          const length = (totalBytes: number) => {
            if (meta.committed) {throw new Error('$length must be called before streaming starts');}
            meta.length = totalBytes;
          };
          const handlerDone = invoke(e, req, rawParams, rawQuery, rawBody, rawFiles, stream, { out: t.writable, download, length }, meta, undefined, { transport: 'http' });
          const winner = await Promise.race([
            t.firstWrite.then(() => ({ kind: 'wrote' }) as const),
            handlerDone.then(
              (result) => ({ kind: 'done', result }) as const,
              (err) => ({ kind: 'fail', err }) as const,
            ),
          ]);
          if (winner.kind === 'fail' && !t.wrote()) {return errorResponse(winner.err);}
          if (winner.kind === 'done' && winner.result instanceof Response) {
            if (!t.writable.locked) {void t.writable.close().catch(() => {});} // short-circuit: nothing was streamed
            return winner.result;
          }
          /* v8 ignore next 3 */ // reason: a write resolves firstWrite before the handler can settle, so the "wrote" race always wins here; the streaming-late twin (handlerDone.then below) is the reachable guard
          if (winner.kind === 'done' && winner.result != null && t.wrote()) {
            return errorResponse(new Error(`endpoint "${e.name}": handler both wrote to $out and returned a stream`));
          }
          dl.committed = true;
          meta.committed = true;
          const headers = new Headers(meta.headers);
          headers.set('content-type', dl.ct);
          headers.set('accept-ranges', 'bytes');
          if (dl.filename) {headers.set('content-disposition', `attachment; filename="${dl.filename}"`);}
          let body: ReadableStream<Uint8Array>;
          if (winner.kind === 'done' && winner.result != null) {
            body = toStream(winner.result);
          } else {
            if (winner.kind === 'done' && !t.wrote() && !t.writable.locked) {
              void t.writable.close(); // returned void, never piped → empty stream
            } else {
              handlerDone.then(
                (result) => {
                  if (result != null) {t.fail(new Error(`endpoint "${e.name}": handler both wrote to $out and returned a stream`));}
                },
                (err) => t.fail(err),
              );
            }
            body = t.readable;
          }
          /* Range / Content-Length (resumable downloads) — only when the handler declared $length */
          const range = e.method === 'GET' ? parseRange(req.headers.get('range')) : null;
          if (meta.length !== null) {
            if (range) {
              const start = range.start;
              const end = Math.min(range.end ?? meta.length - 1, meta.length - 1);
              if (start >= meta.length || start > end) {
                void body.cancel().catch(() => {});
                headers.set('content-range', `bytes */${meta.length}`);
                return new Response(null, { status: 416, headers });
              }
              headers.set('content-range', `bytes ${start}-${end}/${meta.length}`);
              headers.set('content-length', String(end - start + 1));
              return new Response(sliceStream(body, start, end), { status: 206, headers });
            }
            headers.set('content-length', String(meta.length));
          }
          return new Response(body, { status: meta.status ?? 200, headers });
        }

        const result = await invoke(e, req, rawParams, rawQuery, rawBody, rawFiles, stream, undefined, meta, undefined, { transport: 'http' });
        if (result instanceof Response) {return result;} // middleware short-circuit
        meta.committed = true;
        const headers = new Headers(meta.headers);
        if (c.streamOut) {
          headers.set('content-type', e.streamOutCt!);
          return new Response(itemStream(result, c.streamOut as z.ZodType, e.sse), { status: meta.status ?? 200, headers });
        }
        if (c.responses) {
          const r = result as { status: number; data: unknown }; // internal: validated in invoke
          return Response.json(r.data as Json, { status: r.status, headers });
        }
        if (c.response) {return Response.json(result as Json, { status: meta.status ?? 200, headers });}
        return new Response(null, { status: meta.status ?? 204, headers });
      } catch (err) {
        return errorResponse(err);
      }
    }
    return Response.json({ error: { code: 'NOT_FOUND' } }, { status: 404 });
  }

  /* ---- CORS + HEAD wrapper around the inner handler ---- */
  function corsHeadersFor(req: Request): Record<string, string> | null {
    const cors = options?.cors;
    if (!cors) {return null;}
    const origin = req.headers.get('origin');
    if (!origin) {return null;}
    const allowed =
      cors.origin === '*'
        ? '*'
        : typeof cors.origin === 'string'
          ? cors.origin === origin
            ? origin
            : null
          : cors.origin.includes(origin)
            ? origin
            : null;
    if (!allowed) {return null;}
    const h: Record<string, string> = { 'access-control-allow-origin': allowed };
    if (cors.credentials) {h['access-control-allow-credentials'] = 'true';}
    if (allowed !== '*') {h.vary = 'origin';}
    if (cors.exposeHeaders?.length) {h['access-control-expose-headers'] = cors.exposeHeaders.join(', ');}
    return h;
  }

  async function fetchEntry(req: Request): Promise<Response> {
    const ch = corsHeadersFor(req);
    if (options?.cors && req.method === 'OPTIONS' && req.headers.get('access-control-request-method')) {
      const headers = new Headers(ch ?? {});
      headers.set('access-control-allow-methods', [...new Set(eps.map((e) => e.method))].join(', '));
      headers.set('access-control-allow-headers', req.headers.get('access-control-request-headers') ?? '*');
      if (options.cors.maxAge !== undefined) {headers.set('access-control-max-age', String(options.cors.maxAge));}
      return new Response(null, { status: 204, headers });
    }
    let res = await fetchHandler(req);
    if (ch || req.method === 'HEAD') {
      const headers = new Headers(res.headers);
      for (const [k, v] of Object.entries(ch ?? {})) {headers.set(k, v);}
      if (req.method === 'HEAD') {
        void res.body?.cancel().catch(() => {});
        return new Response(null, { status: res.status, headers });
      }
      res = new Response(res.body, { status: res.status, headers });
    }
    return res;
  }

  /* ---- WebSocket + events (subscribers map declared with the registries above) ---- */
  let connSeq = 0;
  const canon = (v: unknown): string => JSON.stringify(v, Object.keys((v as Bag) ?? {}).sort());
  const subKey = (ws: string, params: unknown) => `${ws}|${canon(params ?? {})}`;

  /* emit → broker → every instance (including this one) delivers to its local subscribers */
  const broker = options?.broker ?? localBroker();
  function deliverLocal(msg: { ch: string; params: unknown; data: unknown }): void {
    const frame = JSON.stringify({ type: msg.ch, params: msg.params as Json, data: msg.data as Json });
    const conns = subscribers.get(subKey(msg.ch, msg.params));
    if (conns) {
      for (const c of conns) {
        try {
          c.send(frame);
        } catch {
          /* one dead/broken socket must not stop fanout to the rest */
        }
      }
    }
  }
  broker.subscribe((raw) => {
    try {
      deliverLocal(JSON.parse(raw) as { ch: string; params: unknown; data: unknown });
    } catch {
      /* ignore malformed broker messages */
    }
  });

  function emitImpl(name: string, ...args: readonly unknown[]): void {
    const ev = events.find((x) => x.name === name);
    if (!ev) {throw new Error(`unknown event "${name}"`);}
    const [params, data] = ev.cfg.params ? [args[0], args[1]] : [undefined, args[0]];
    const pOut = ev.cfg.params ? ev.cfg.params.parse(params) : {};
    const dOut = ev.cfg.data.parse(data);
    // emit is fire-and-forget: a broker that throws (sync) or rejects (async) must not fail
    // the handler that emitted. A custom broker reports its own delivery errors (e.g. redisBroker.onError).
    try {
      const published = broker.publish(JSON.stringify({ ch: ev.ws, params: pOut, data: dOut }));
      if (published) {void Promise.resolve(published).catch(() => {});}
    } catch {
      /* a synchronous broker failure must not propagate into the emitting handler */
    }
  }
  const emit = emitImpl as EmitFn<S>; // internal cast: variadic impl behind the typed surface

  /** Map a middleware short-circuit Response to a ws frame: JSON body → result frame, else error frame. */
  async function sendShortCircuit(conn: WsConn, id: unknown, res: Response): Promise<void> {
    const ct = res.headers.get('content-type') ?? '';
    const isJson = ct.includes('application/json');
    if (res.ok && isJson) {
      const data = await res.json().catch(() => null);
      conn.send(JSON.stringify({ id, $status: res.status, data: data as Json }));
      return;
    }
    let data: unknown = null;
    try {
      data = isJson ? await res.json() : await res.text();
    } catch {
      /* empty/unreadable body */
    }
    conn.send(JSON.stringify({ id, $status: res.status, $code: 'SHORT_CIRCUIT', $error: typeof data === 'string' ? data : undefined, data: data as Json }));
  }

  const wsApi = {
    open(send: (frame: string) => void, req: Request): WsConn {
      return { id: ++connSeq, req, send, subs: new Set(), streams: new Map(), calls: new Map() };
    },
    async message(conn: WsConn, raw: string): Promise<void> {
      let frame: Bag;
      try {
        frame = JSON.parse(raw) as Bag;
      } catch {
        conn.send(JSON.stringify({ $status: 400, $code: 'BAD_FRAME', $error: 'bad frame' }));
        return;
      }
      const id = frame.id;
      /* Error frames carry the reserved `$status`/`$error`/`$code` fields + an optional typed `data` body.
         The client throws an ApiError whenever `$status` is not 2xx (declared-error `data` is preserved). */
      const fail = (err: unknown) => {
        const out: Bag =
          err instanceof ApiFailure
            ? { id, $status: err.status, data: err.data as Json } // declared typed error: body in `data`, code defaults to ERROR client-side (HTTP parity)
            : err instanceof ApiError
              ? { id, $status: err.status, $code: err.code, $error: err.message }
              : err instanceof z.ZodError
                ? { id, $status: 400, $code: 'VALIDATION', $error: 'VALIDATION', data: { issues: err.issues } as unknown as Json } // internal cast: zod issues are JSON-shaped
                : { id, $status: 500, $code: 'INTERNAL', $error: err instanceof Error ? err.message : 'internal error' };
        conn.send(JSON.stringify(out));
      };
      try {
        if (frame.ping === true) {
          /* heartbeat (forward-compatible extension): answer liveness probes */
          conn.send(JSON.stringify({ pong: true }));
          return;
        }
        if (typeof frame.sub === 'string') {
          const ev = eventsByWs.get(frame.sub);
          if (!ev) {throw reject(404, 'NOT_FOUND', `unknown channel "${frame.sub}"`);}
          const pOut = ev.cfg.params ? ev.cfg.params.parse(frame.params) : {};
          const guard = await runChain(ev.chain, conn.req, {}, async () => undefined, {
            route: { kind: 'event', name: ev.name, ws: ev.ws },
            transport: 'ws',
            signal: conn.req.signal,
            meta: undefined,
            ws: { id: String(id), data: frame.params, conn },
          });
          if (guard instanceof Response) {
            await sendShortCircuit(conn, id, guard); // a guard rejected the subscription (e.g. auth 401)
            return;
          }
          const key = subKey(ev.ws, pOut);
          let set = subscribers.get(key);
          if (!set) {subscribers.set(key, (set = new Set()));}
          set.add(conn);
          conn.subs.add(key);
          conn.send(JSON.stringify({ id, $status: 200 }));
        } else if (typeof frame.unsub === 'string') {
          const ev = eventsByWs.get(frame.unsub);
          if (ev) {
            const pOut = ev.cfg.params ? ev.cfg.params.parse(frame.params) : {};
            const key = subKey(ev.ws, pOut);
            subscribers.get(key)?.delete(conn);
            conn.subs.delete(key);
          }
          conn.send(JSON.stringify({ id, $status: 200 }));
        } else if ('chunk' in frame) {
          conn.streams.get(String(id))?.push(frame.chunk);
        } else if (frame.end === true) {
          conn.streams.get(String(id))?.end();
        } else if (frame.abort === true) {
          /* cancel an in-flight call: abort its signal and unblock any item-stream-in */
          conn.calls.get(String(id))?.abort();
          conn.streams.get(String(id))?.fail(new ApiError(ABORTED_STATUS, 'ABORTED'));
        } else if (typeof frame.type === 'string') {
          /* a call: type is the explicit ws id, or the un-injected url pattern + method */
          const e = typeof frame.method === 'string' ? byRoute.get(`${frame.method} ${frame.type}`) : byWs.get(frame.type);
          if (!e) {throw reject(404, 'NOT_FOUND', `unknown ws endpoint "${frame.type}"`);}
          /* trivial mapping: kinds are disjoint, so data splits losslessly by key tables */
          const { p, q, b } = kindsFromData(e, frame.data);
          /* per-call abort: an { id, abort: true } frame aborts this signal */
          const ac = new AbortController();
          conn.calls.set(String(id), ac);
          /* response meta: lets the handler/middleware set the result-frame `$status` over ws (headers are collected but not applied) */
          const wsMeta = makeMeta();
          /* typed item stream in: chunk frames feed an async queue the handler for-awaits */
          let stream: AsyncIterable<unknown> | undefined;
          if (e.itemsIn) {
            const queue = asyncQueue<unknown>();
            conn.streams.set(String(id), queue);
            const schema = e.def.cfg.streamIn as z.ZodType;
            stream = (async function* () {
              for await (const raw of queue) {yield schema.parse(raw);}
            })();
          }
          try {
            const result = await invoke(e, conn.req, p, q, b, null, stream, undefined, wsMeta, ac.signal, { transport: 'ws', ws: { id: String(id), data: frame.data, conn } });
            if (result instanceof Response) {
              await sendShortCircuit(conn, id, result); // middleware short-circuit
            } else if (e.items) {
              /* typed item stream out: chunk frames until end (stop early if cancelled) */
              const schema = e.def.cfg.streamOut as z.ZodType;
              for await (const item of result as AsyncIterable<unknown>) {
                if (ac.signal.aborted) {break;}
                conn.send(JSON.stringify({ id, chunk: schema.parse(item) as Json }));
              }
              if (!ac.signal.aborted) {conn.send(JSON.stringify({ id, end: true }));}
            } else if (e.multi) {
              const r = result as { status: number; data: unknown }; // internal: validated in invoke
              if (!ac.signal.aborted) {conn.send(JSON.stringify({ id, $status: r.status, data: { status: r.status, data: r.data as Json } }));}
            } else {
              if (!ac.signal.aborted) {conn.send(JSON.stringify({ id, $status: wsMeta.status ?? 200, data: result as Json }));}
            }
          } finally {
            conn.streams.delete(String(id));
            conn.calls.delete(String(id));
          }
        } else {
          throw reject(400, 'BAD_FRAME', 'unrecognized frame');
        }
      } catch (err) {
        fail(err);
      }
    },
    close(conn: WsConn): void {
      for (const key of conn.subs) {subscribers.get(key)?.delete(conn);}
      conn.subs.clear();
      for (const ac of conn.calls.values()) {ac.abort();} // cancel in-flight calls
      conn.calls.clear();
      for (const s of conn.streams.values()) {s.fail(new ApiError(ABORTED_STATUS, 'ABORTED'));}
      conn.streams.clear();
    },
  };

  return {
    spec,
    fetch: fetchEntry,
    manifest: getManifest,
    emit,
    openapi: (info?: { title?: string; version?: string }) => buildOpenapi(eps, composeDoc(), info),
    asyncapi: (info?: { title?: string; version?: string }) => buildAsyncapi(eps, events, composeDoc(), info),
    call: callLocal as unknown as Server<S>['call'], // internal cast: erased in-process caller behind the typed surface
    install: ((regSpec: AnySpec, regBuilders: readonly { readonly __bag: ImplBag }[]) => register(regSpec, regBuilders)) as unknown as Server<S>['install'], // internal cast: H elements carry `__bag`
    uninstall: unregister,
    ws: wsApi,
  };
}
