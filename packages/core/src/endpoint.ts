/**
 * # Endpoint specs
 *
 * Endpoint configuration ({@link EndpointConfig}), the compile-time config
 * validator ({@link CheckCfg}), event configuration, and the two entry points
 * that turn declarations into a runtime spec: {@link endpoint} and {@link spec}.
 *
 * The central invariant is **disjoint kinds**: every path-param key is declared
 * exactly once (loader XOR template XOR `params` schema) and positioned exactly
 * once; query keys are disjoint from path; body keys from path∪query; files keys
 * from all. That disjointness is what lets the four kinds merge losslessly into a
 * single `data` payload. It is enforced both at compile time (via {@link CheckCfg})
 * and at `spec()` time (via {@link normalizeEndpoint}).
 *
 * @module
 */

import { z } from 'zod';
import type { Get, EmptyObject, Json } from './types';
import type { HttpMethod, Manifest, ManifestEndpoint, ManifestEvent } from './manifest';
import type { AnyPathTemplate, PathPart } from './path';
import { splitPattern, joinPattern, paramKeys } from './path';
import type { AnyMiddleware } from './middleware';
import { resolveChain } from './middleware';

/* ---- documentation hooks ----------------------------------------------- */

/** Endpoint-level OpenAPI metadata, plus an escape hatch over the generated operation. */
export interface EndpointDoc {
  readonly summary?: string;
  readonly description?: string;
  readonly tags?: readonly string[];
  readonly deprecated?: boolean;
  readonly operationId?: string;
  /** Final say over this endpoint's generated operation object. */
  readonly openapi?: (op: Record<string, Json>) => Record<string, Json>;
}

/** Event-level AsyncAPI metadata, plus an escape hatch over the generated channel. */
export interface EventDoc {
  readonly summary?: string;
  readonly description?: string;
  /** Final say over this event's generated channel object. */
  readonly asyncapi?: (channel: Record<string, Json>) => Record<string, Json>;
}

/** Spec-level final patches over the whole generated documents. */
export interface SpecDoc {
  readonly openapi?: (doc: Record<string, Json>) => Record<string, Json>;
  readonly asyncapi?: (doc: Record<string, Json>) => Record<string, Json>;
}

/** Options for a `Set-Cookie` written via the handler's `cookie()`. */
export interface CookieOptions {
  readonly path?: string;
  readonly domain?: string;
  readonly maxAge?: number;
  readonly expires?: Date;
  readonly httpOnly?: boolean;
  readonly secure?: boolean;
  readonly sameSite?: 'Strict' | 'Lax' | 'None';
}

/**
 * The declarative configuration for one endpoint.
 *
 * Schemas are the single source of truth: each kind below contributes typed keys
 * to the endpoint's single `data` payload (path params, query, body, files), and
 * the kinds must be disjoint. Streaming, multi-status, typed errors, custom
 * method/path, and documentation are all declared here.
 */
export interface EndpointConfig {
  /** Path params as a `z.object`; keys must be positioned in the path. */
  readonly params?: z.ZodType;
  /** Query params as a `z.object`. */
  readonly query?: z.ZodType;
  /** Request body — a `z.object` (merges into `data`) or any other schema (then it *is* `data`). */
  readonly body?: z.ZodType;
  /** Multipart file fields, keyed by form-field name. Declaring files forces `httpOnly`. */
  readonly files?: Readonly<Record<string, z.ZodType>>;
  /** Typed request headers (`z.object`, lowercase keys) — handler gets `headers`; never merged into `data`. */
  readonly headers?: z.ZodType;
  /** Typed request cookies (`z.object`) — handler gets `cookies`; server-side input only. */
  readonly cookies?: z.ZodType;
  /** Single success response schema. */
  readonly response?: z.ZodType;
  /** Multi-status success responses by code — handler returns `{ status, data }`, client gets a `{ status, data }` union. */
  readonly responses?: Readonly<Record<number, z.ZodType>>;
  /** Declared error responses by status — documents them and types the handler's `fail()`. */
  readonly errors?: Readonly<Record<number, z.ZodType>>;
  /** Body wire encoding (default `'json'`); `'urlencoded'` for `application/x-www-form-urlencoded` HTML forms. */
  readonly bodyEncoding?: 'json' | 'urlencoded';
  /** Typed item-stream output encoding (default `'ndjson'`); `'sse'` for `text/event-stream`. */
  readonly streamEncoding?: 'ndjson' | 'sse';
  readonly doc?: EndpointDoc;
  /** HTTP method (default `POST`). */
  readonly method?: HttpMethod;
  /** Custom path: a `:key` string, or a {@link path} template whose schemas join the params kind. */
  readonly path?: string | AnyPathTemplate;
  /** Explicit WebSocket id (default: the un-injected url pattern + method). */
  readonly ws?: string;
  /** Force the endpoint to be HTTP-only (no ws). */
  readonly httpOnly?: boolean;
  /**
   * Streaming request body. `string` → raw byte stream with that content-type
   * (`stream: ReadableStream<Uint8Array>`); zod schema → typed NDJSON item stream
   * (client passes an async iterable as `stream`, handler for-awaits validated items).
   */
  readonly streamIn?: string | z.ZodType;
  /**
   * Streaming response. `string` → raw byte stream with that content-type
   * (handler returns/pipes bytes); zod schema → typed item stream over
   * NDJSON/SSE (handler is an async generator, client `for await`s typed items).
   */
  readonly streamOut?: string | z.ZodType;
  /** Raw `streamOut` only: serve with `Content-Disposition: attachment; filename="…"`. */
  readonly download?: string;
}

/** Erased (non-generic) endpoint shape used by the runtime. @internal */
export interface AnyEndpoint {
  readonly kind: 'endpoint';
  readonly cfg: EndpointConfig;
  readonly mws: readonly AnyMiddleware[];
  readonly prefixes: ReadonlyArray<string | AnyPathTemplate>;
  readonly __ctx: object;
  readonly __lp: object;
}

/**
 * A fully-typed endpoint declaration.
 *
 * @typeParam C   - the literal {@link EndpointConfig}.
 * @typeParam Ctx - middleware-provided context visible to the handler.
 * @typeParam LP  - loader-param schemas in scope.
 * @typeParam PFX - prefix-param schemas in scope.
 */
export interface Endpoint<C extends EndpointConfig, Ctx extends object, LP extends object, PFX extends object> extends AnyEndpoint {
  readonly cfg: C;
  readonly __ctx: Ctx;
  readonly __lp: LP;
  readonly __pfx: PFX;
}

/* internal: endpoint constructor — phantoms are type-only */
export function makeEndpoint(cfg: EndpointConfig, mws: readonly AnyMiddleware[], prefixes: ReadonlyArray<string | AnyPathTemplate>): AnyEndpoint {
  return { kind: 'endpoint', cfg, mws, prefixes } as unknown as AnyEndpoint; // internal cast: phantoms are type-only
}

/**
 * Define a bare endpoint with no middleware.
 *
 * @example
 * ```ts
 * const getReport = endpoint({
 *   method: 'GET',
 *   path: reportPath,
 *   response: z.object({ year: z.number(), slug: z.string() }),
 * })
 * ```
 */
export function endpoint<const C extends EndpointConfig>(cfg: C & CheckCfg<C, EmptyObject, EmptyObject>): Endpoint<C, EmptyObject, EmptyObject, EmptyObject> {
  return makeEndpoint(cfg, [], []) as Endpoint<C, EmptyObject, EmptyObject, EmptyObject>; // internal cast
}

/* ---- compile-time config validation --------------------------------------- */
/** Extract `:key` param names from a literal path string. */
type PathParamKeys<P extends string> = P extends `${string}:${infer R}`
  ? R extends `${infer K}/${infer Rest}`
    ? K | PathParamKeys<`/${Rest}`>
    : R
  : never;
/** Keys of a `z.object` schema's input type. */
type ZKeys<T> = T extends z.ZodType ? keyof z.input<T> & string : never;
/** Param keys contributed by a `path` template attached to `cfg.path`. */
type CfgTplKeys<C extends EndpointConfig> = Get<C, 'path'> extends { readonly __ps: infer PS } ? keyof PS & string : never;
/** Every path-param key, from every source: `cfg.params`, loaders, prefix templates, own template/string. */
type AllParamKeys<C extends EndpointConfig, LP extends object, PFX extends object> =
  | ZKeys<Get<C, 'params'>>
  | (keyof LP & string)
  | (keyof PFX & string)
  | CfgTplKeys<C>
  | (Get<C, 'path'> extends string ? PathParamKeys<Get<C, 'path'>> : never);
/** Keys of an object body (empty for a non-object body). */
type BodyKeys<C extends EndpointConfig> = Get<C, 'body'> extends z.ZodType
  ? z.input<Get<C, 'body'> & z.ZodType> extends Record<string, unknown>
    ? keyof z.input<Get<C, 'body'> & z.ZodType> & string
    : never
  : never;
/** Whether the body is a non-object (so it *is* the data payload). */
type CfgHasRawBody<C extends EndpointConfig> = Get<C, 'body'> extends z.ZodType
  ? z.input<Get<C, 'body'> & z.ZodType> extends Record<string, unknown>
    ? false
    : true
  : false;

/**
 * Definition-time config validation, surfaced as compile errors that land on the
 * offending config property.
 *
 * Enforces:
 * - a custom path may only reference declared param keys;
 * - each param key is declared exactly once (own template vs prefix vs `params`);
 * - kinds are disjoint: query ∉ path, body ∉ path∪query, files ∉ path∪query∪body;
 * - a non-object body excludes params/query/files (it *is* the data).
 *
 * Errors are emitted as `readonly ['message', Keys]` tuples (not plain strings)
 * so that conflicting messages on the same property don't collapse to `never`.
 * Cross-prefix position coverage is additionally validated at `spec()` time.
 */
export type CheckCfg<C extends EndpointConfig, LP extends object, PFX extends object> = (Get<C, 'path'> extends string
  ? [PathParamKeys<Get<C, 'path'>>] extends [ZKeys<Get<C, 'params'>> | (keyof LP & string) | (keyof PFX & string)]
    ? EmptyObject
    : { readonly path: readonly ['custom path references undeclared param keys:', Exclude<PathParamKeys<Get<C, 'path'>>, ZKeys<Get<C, 'params'>> | (keyof LP & string) | (keyof PFX & string)>] }
  : EmptyObject) &
  ([CfgTplKeys<C> & (keyof PFX | keyof LP | ZKeys<Get<C, 'params'>>)] extends [never]
    ? EmptyObject
    : { readonly path: readonly ['path template re-declares param keys:', CfgTplKeys<C> & (keyof PFX | keyof LP | ZKeys<Get<C, 'params'>>) & string] }) &
  ([ZKeys<Get<C, 'params'>> & (keyof PFX | keyof LP)] extends [never]
    ? EmptyObject
    : { readonly params: readonly ['params re-declares keys owned by a loader or prefix:', ZKeys<Get<C, 'params'>> & (keyof PFX | keyof LP) & string] }) &
  ([ZKeys<Get<C, 'query'>> & AllParamKeys<C, LP, PFX>] extends [never]
    ? EmptyObject
    : { readonly query: readonly ['query keys collide with path params:', ZKeys<Get<C, 'query'>> & AllParamKeys<C, LP, PFX>] }) &
  ([BodyKeys<C> & (AllParamKeys<C, LP, PFX> | ZKeys<Get<C, 'query'>>)] extends [never]
    ? EmptyObject
    : { readonly body: readonly ['body keys collide with path/query:', BodyKeys<C> & (AllParamKeys<C, LP, PFX> | ZKeys<Get<C, 'query'>>)] }) &
  ([(keyof Get<C, 'files'> & string) & (AllParamKeys<C, LP, PFX> | ZKeys<Get<C, 'query'>> | BodyKeys<C>)] extends [never]
    ? EmptyObject
    : { readonly files: readonly ['files keys collide with path/query/body:', (keyof Get<C, 'files'> & string) & (AllParamKeys<C, LP, PFX> | ZKeys<Get<C, 'query'>> | BodyKeys<C>)] }) &
  (CfgHasRawBody<C> extends true
    ? [AllParamKeys<C, LP, PFX> | ZKeys<Get<C, 'query'>> | (keyof Get<C, 'files'> & string)] extends [never]
      ? EmptyObject
      : { readonly body: readonly ['a non-object body is the entire data payload — params/query/files are not allowed alongside it'] }
    : EmptyObject);

/* ---- events --------------------------------------------------------------- */

/** Configuration for a server-pushed event channel. */
export interface EventConfig {
  /** Channel params as a `z.object` — subscriptions are keyed by these. */
  readonly params?: z.ZodType;
  /** Event payload schema. */
  readonly data: z.ZodType;
  /** Middleware chain that must pass before a client may subscribe. */
  readonly guard?: readonly AnyMiddleware[];
  /** Explicit WebSocket channel id (default: the event name). */
  readonly ws?: string;
  readonly doc?: EventDoc;
}

/** The shape passed to {@link spec}. */
export interface SpecShape {
  readonly endpoints: Readonly<Record<string, AnyEndpoint>>;
  readonly events?: Readonly<Record<string, EventConfig>>;
  readonly doc?: SpecDoc;
}
/** Any normalized spec. */
export type AnySpec = SpecShape;
/** Extract the events record of a spec (or `{}` when it has none). */
export type EventsOf<S extends AnySpec> = S['events'] extends Readonly<Record<string, EventConfig>> ? S['events'] : EmptyObject;

/**
 * Finalize a set of endpoints + events into a spec, validating every endpoint at
 * definition time.
 *
 * Beyond the compile-time {@link CheckCfg} guarantees, this performs runtime
 * sanity checks (flag exclusivity, kind shapes) and full
 * {@link normalizeEndpoint | path/coverage/disjointness} validation — throwing
 * immediately on any violation so misconfiguration fails at module init.
 *
 * @returns the same spec object, now type-branded and validated.
 */
export function spec<const S extends SpecShape>(spec: S): S {
  // runtime sanity: reserved keys, flag exclusivity, path coverage
  for (const [name, def] of Object.entries(spec.endpoints)) {
    const c = def.cfg;
    if (c.streamIn && (c.body || c.files)) {throw new Error(`endpoint "${name}": streamIn excludes body/files`);}
    if (c.files && 'body' in c.files) {throw new Error(`endpoint "${name}": "body" is reserved as the multipart JSON field name`);}
    if (c.streamOut && c.response) {throw new Error(`endpoint "${name}": streamOut excludes response`);}
    if (c.responses && c.response) {throw new Error(`endpoint "${name}": responses (multi-status) excludes response`);}
    if (c.responses && c.streamOut) {throw new Error(`endpoint "${name}": responses excludes streamOut`);}
    if (c.streamEncoding && !(c.streamOut instanceof z.ZodType)) {throw new Error(`endpoint "${name}": streamEncoding requires a typed (schema) streamOut`);}
    if (c.bodyEncoding === 'urlencoded' && !(c.body instanceof z.ZodObject)) {throw new Error(`endpoint "${name}": urlencoded bodies must be z.object(...)`);}
    if (c.download && typeof c.streamOut !== 'string') {throw new Error(`endpoint "${name}": download requires a raw (content-type) streamOut`);}
    for (const kind of ['params', 'query', 'headers', 'cookies'] as const) {
      const s = c[kind];
      if (s && !(s instanceof z.ZodObject)) {throw new Error(`endpoint "${name}": ${kind} must be a z.object(...)`);}
    }
    normalizeEndpoint(name, def); // throws on duplicate keys, kind collisions, position/declaration mismatches
  }
  // Stamp a cached, zod-free manifest builder under a global symbol so `client()` can
  // accept this spec directly (and derive its manifest) without statically importing the
  // deriver — keeping manifest-only frontends free of this (zod-bearing) code path.
  let cached: Manifest | undefined;
  Object.defineProperty(spec, SPEC_MANIFEST, {
    value: (): Manifest => (cached ??= manifestFromSpec(spec)),
    enumerable: false,
    configurable: true,
  });
  return spec;
}

/**
 * Global-registry symbol under which {@link spec} stashes its lazy
 * {@link manifestFromSpec} builder. Global (`Symbol.for`) so consumers — notably
 * the zod-free `client` — can read it off a spec value **without importing this
 * module**, so a manifest-only bundle never pulls in the deriver or zod.
 *
 * @internal
 */
export const SPEC_MANIFEST: unique symbol = Symbol.for('ayepi.manifest');

/**
 * Derive the zod-free {@link Manifest} from a spec — exactly the routing data
 * `app.manifest()` returns, computed purely from the endpoint/event definitions.
 * Used by {@link server} and stamped (cached) onto every spec by {@link spec}, so
 * {@link client} can take a spec directly.
 *
 * This runs the zod-bearing {@link normalizeEndpoint}, so importing it — or
 * handing a spec to the client — brings zod into the bundle. Pass a prebuilt
 * manifest instead to keep a frontend schema-free.
 */
export function manifestFromSpec(spec: AnySpec): Manifest {
  const eps = Object.entries(spec.endpoints).map(([name, def]) => normalizeEndpoint(name, def));
  return {
    endpoints: Object.fromEntries(
      eps.map((e) => [
        e.name,
        {
          method: e.method,
          path: e.path,
          ws: e.ws,
          httpOnly: e.httpOnly,
          streamIn: e.streamInCt,
          itemsIn: e.itemsIn,
          streamOut: e.streamOutCt,
          items: e.items,
          p: e.p,
          q: e.q,
          b: e.bRaw ? 'raw' : e.b,
          f: e.f,
          hasBody: Boolean(e.def.cfg.body),
          hasHeaders: Boolean(e.def.cfg.headers),
          multi: e.multi,
          bodyEnc: e.bodyEnc,
        } satisfies ManifestEndpoint,
      ]),
    ),
    events: Object.fromEntries(
      Object.entries(spec.events ?? {}).map(([name, cfg]) => [name, { ws: cfg.ws ?? name, hasParams: Boolean(cfg.params) } satisfies ManifestEvent]),
    ),
  };
}

/* ---- normalization (shared by spec() and server()) ------------------------ */

/** Read the keys of a `z.object` schema, or `null` for any other (or absent) schema. @internal */
export function objectKeys(s: z.ZodType | undefined): string[] | null {
  if (!s) {return null;}
  if (s instanceof z.ZodObject) {return Object.keys(s.shape);}
  return null;
}

/** The fully-resolved runtime description of one endpoint. @internal */
export interface NormalizedEp {
  readonly name: string;
  readonly def: AnyEndpoint;
  readonly method: HttpMethod;
  readonly parts: readonly PathPart[];
  readonly path: string;
  /** Explicit ws id only — the default ws identity is method + path pattern. */
  readonly ws: string | null;
  readonly wsEligible: boolean;
  readonly httpOnly: boolean;
  readonly streamInCt: string | null;
  readonly itemsIn: boolean;
  readonly streamOutCt: string | null;
  readonly items: boolean;
  readonly sse: boolean;
  readonly multi: boolean;
  readonly bodyEnc: 'json' | 'urlencoded' | null;
  readonly p: readonly string[];
  readonly q: readonly string[];
  readonly b: readonly string[] | null;
  readonly bRaw: boolean;
  readonly f: readonly string[];
  readonly loaders: ReadonlyMap<string, z.ZodType>;
  /** Per-key schemas from own + prefix templates. */
  readonly tplSchemas: ReadonlyMap<string, z.ZodType>;
  readonly chain: readonly AnyMiddleware[];
}

/**
 * Resolve an endpoint declaration into a {@link NormalizedEp}: assemble its path
 * parts (prefixes → own path → default), verify exact-once param declaration and
 * positioning, and enforce kind disjointness. Throws on any violation.
 *
 * @internal
 */
export function normalizeEndpoint(name: string, def: AnyEndpoint): NormalizedEp {
  const c = def.cfg;
  const chain = resolveChain(def.mws);
  const fail = (msg: string): never => {
    throw new Error(`endpoint "${name}": ${msg}`);
  };

  /* ---- declared param keys: each key from exactly one source ---- */
  const loaders = new Map<string, z.ZodType>();
  for (const m of chain) {if (m.paramKey && m.paramSchema) {loaders.set(m.paramKey, m.paramSchema);}}
  const tplSchemas = new Map<string, z.ZodType>();
  const declareTpl = (tpl: AnyPathTemplate, where: string) => {
    for (const k of tpl.keys) {
      if (loaders.has(k) || tplSchemas.has(k)) {fail(`param ":${k}" is declared more than once (${where})`);}
      tplSchemas.set(k, tpl.schemas[k]!);
    }
  };
  for (const pre of def.prefixes) {if (typeof pre !== 'string') {declareTpl(pre, 'prefix path');}}
  const ownTpl = typeof c.path === 'object' && c.path !== null ? (c.path as AnyPathTemplate) : null;
  if (ownTpl) {declareTpl(ownTpl, 'endpoint path');}
  const cfgP = objectKeys(c.params) ?? [];
  for (const k of cfgP) {if (loaders.has(k) || tplSchemas.has(k)) {fail(`param ":${k}" is declared more than once (params schema)`);}}
  const declared = new Set([...loaders.keys(), ...tplSchemas.keys(), ...cfgP]);

  /* ---- assemble parts: prefixes, then own path (or default) ---- */
  const parts: PathPart[] = [];
  for (const pre of def.prefixes) {parts.push(...(typeof pre === 'string' ? splitPattern(pre) : pre.parts));}
  if (ownTpl) {parts.push(...ownTpl.parts);}
  else if (typeof c.path === 'string') {parts.push(...splitPattern(c.path));}
  else {
    parts.push({ t: 'lit', v: name });
    const positioned = new Set(paramKeys(parts));
    for (const k of declared) {if (!positioned.has(k)) {parts.push({ t: 'param', k });}}
  }

  /* ---- exact-once position coverage ---- */
  const positions = paramKeys(parts);
  const posSet = new Set(positions);
  if (positions.length !== posSet.size) {fail(`path positions a param more than once: ${joinPattern(parts)}`);}
  for (const k of positions) {if (!declared.has(k)) {fail(`path references undeclared param ":${k}"`);}}
  for (const k of declared) {if (!posSet.has(k)) {fail(`declared param ":${k}" has no position in path ${joinPattern(parts)}`);}}

  const p = [...declared];
  const q = objectKeys(c.query) ?? [];
  const b = c.body ? objectKeys(c.body) : null;
  const bRaw = Boolean(c.body) && b === null;
  const f = Object.keys(c.files ?? {});

  /* ---- kind disjointness (lets p/q/b/f merge losslessly into data) ---- */
  const taken = new Map<string, string>();
  for (const [kind, keys] of [['path', p], ['query', q], ['body', b ?? []], ['files', f]] as const) {
    for (const k of keys) {
      const prev = taken.get(k);
      if (prev) {fail(`key "${k}" appears in both ${prev} and ${kind} — kinds must be disjoint`);}
      taken.set(k, kind);
    }
  }
  if (bRaw && (p.length > 0 || q.length > 0 || f.length > 0)) {fail('a non-object body is the entire data payload — params/query/files are not allowed alongside it');}

  const itemsIn = c.streamIn instanceof z.ZodType;
  const streamInCt = typeof c.streamIn === 'string' ? c.streamIn : itemsIn ? 'application/x-ndjson' : null;
  const items = c.streamOut instanceof z.ZodType;
  const sse = items && c.streamEncoding === 'sse';
  const streamOutCt = typeof c.streamOut === 'string' ? c.streamOut : items ? (sse ? 'text/event-stream' : 'application/x-ndjson') : null;
  /* raw byte streams + files are http-only; typed item streams travel over ws chunk frames too */
  const httpOnly = Boolean(c.httpOnly || typeof c.streamIn === 'string' || typeof c.streamOut === 'string' || f.length > 0);
  return {
    name,
    def,
    method: c.method ?? 'POST',
    parts,
    path: joinPattern(parts),
    ws: c.ws ?? null,
    wsEligible: !httpOnly,
    httpOnly,
    streamInCt,
    itemsIn,
    streamOutCt,
    items,
    sse,
    multi: Boolean(c.responses && Object.keys(c.responses).length > 0),
    bodyEnc: c.body ? (c.bodyEncoding ?? 'json') : null,
    p,
    q,
    b,
    bRaw,
    f,
    loaders,
    tplSchemas,
    chain,
  };
}
