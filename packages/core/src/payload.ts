/**
 * # Payload type machinery
 *
 * Pure type-level derivations that turn an {@link AnyEndpoint}'s config into the
 * exact shapes a consumer sees:
 *
 * - {@link ClientData} / {@link CallArgs} / {@link CallOpts} — what `call()` accepts;
 * - {@link CallReturn} — what `call()` resolves to;
 * - {@link HandlerPayload} / {@link HandlerReturn} — what a handler receives and returns.
 *
 * Because kinds are disjoint, path + query + body + files merge into a single
 * `data` object (a non-object body *is* `data` and excludes the rest). Nothing
 * here emits runtime code.
 *
 * @module
 */

import type { z } from 'zod';
import type { Simplify, EmptyObject, Get, MaybePromise } from './types';
import type { AnyEndpoint, CookieOptions, EventConfig, AnySpec, EventsOf } from './endpoint';

/** Input vs output side of a schema (request parsing vs response/handler view). */
type IOMode = 'in' | 'out';
/** Pick `z.input` or `z.output` of a schema by {@link IOMode}. */
type ZIO<Z extends z.ZodType, M extends IOMode> = M extends 'in' ? z.input<Z> : z.output<Z>;

type CfgOf<E extends AnyEndpoint> = E['cfg'];
type CtxOf<E extends AnyEndpoint> = E['__ctx'];
type LPOf<E extends AnyEndpoint> = E['__lp'];

type LPShape<E extends AnyEndpoint, M extends IOMode> = { [K in keyof LPOf<E>]: LPOf<E>[K] extends z.ZodType ? ZIO<LPOf<E>[K], M> : never };
/** Params contributed by a `path` template on `cfg.path`. */
type TplOf<E extends AnyEndpoint> = Get<CfgOf<E>, 'path'> extends { readonly __ps: infer PS extends object } ? PS : EmptyObject;
/** Params contributed by stacked path prefixes. */
type PfxOf<E extends AnyEndpoint> = E extends { readonly __pfx: infer PFX extends object } ? PFX : EmptyObject;
type PfxShape<E extends AnyEndpoint, M extends IOMode> = { -readonly [K in keyof PfxOf<E>]: PfxOf<E>[K] extends z.ZodType ? ZIO<PfxOf<E>[K], M> : never };
type TplShape<E extends AnyEndpoint, M extends IOMode> = { -readonly [K in keyof TplOf<E>]: TplOf<E>[K] extends z.ZodType ? ZIO<TplOf<E>[K], M> : never };
type PShape<E extends AnyEndpoint, M extends IOMode> = Simplify<
  (Get<CfgOf<E>, 'params'> extends z.ZodType ? ZIO<Get<CfgOf<E>, 'params'> & z.ZodType, M> : EmptyObject) & LPShape<E, M> & TplShape<E, M> & PfxShape<E, M>
>;
type QShape<E extends AnyEndpoint, M extends IOMode> = Get<CfgOf<E>, 'query'> extends z.ZodType
  ? ZIO<Get<CfgOf<E>, 'query'> & z.ZodType, M>
  : EmptyObject;
/** File fields map to data keys; a file schema whose input accepts `undefined` (e.g. `z.file().optional()`) becomes an optional key. */
type FShape<E extends AnyEndpoint, M extends IOMode> = Get<CfgOf<E>, 'files'> extends infer F extends Readonly<Record<string, z.ZodType>>
  ? Simplify<
      { -readonly [K in keyof F as undefined extends z.input<F[K]> ? never : K]: ZIO<F[K], M> } & {
        -readonly [K in keyof F as undefined extends z.input<F[K]> ? K : never]?: ZIO<F[K], M>
      }
    >
  : EmptyObject;

type HShape<E extends AnyEndpoint, M extends IOMode> = Get<CfgOf<E>, 'headers'> extends z.ZodType
  ? ZIO<Get<CfgOf<E>, 'headers'> & z.ZodType, M>
  : EmptyObject;
type CShape<E extends AnyEndpoint, M extends IOMode> = Get<CfgOf<E>, 'cookies'> extends z.ZodType
  ? ZIO<Get<CfgOf<E>, 'cookies'> & z.ZodType, M>
  : EmptyObject;
type HasHeaders<E extends AnyEndpoint> = Get<CfgOf<E>, 'headers'> extends z.ZodType ? true : false;
type HasCookies<E extends AnyEndpoint> = Get<CfgOf<E>, 'cookies'> extends z.ZodType ? true : false;
type RespMap<E extends AnyEndpoint> = Get<CfgOf<E>, 'responses'> extends Readonly<Record<number, z.ZodType>> ? Get<CfgOf<E>, 'responses'> : EmptyObject;
type HasMulti<E extends AnyEndpoint> = [keyof RespMap<E>] extends [never] ? false : true;
type ErrorsOf<E extends AnyEndpoint> = Get<CfgOf<E>, 'errors'> extends Readonly<Record<number, z.ZodType>> ? Get<CfgOf<E>, 'errors'> : EmptyObject;
type HasErrors<E extends AnyEndpoint> = [keyof ErrorsOf<E>] extends [never] ? false : true;

/**
 * The handler's `fail()` — throw a declared, schema-validated error response.
 * Only declared statuses are accepted, and the data must match that status's
 * schema.
 *
 * @typeParam Errors - the endpoint's `errors` record.
 */
export type FailFn<Errors extends object> = <S extends keyof Errors & number>(
  status: S,
  data: Errors[S] extends z.ZodType ? z.input<Errors[S]> : never,
) => never;

type HasBody<E extends AnyEndpoint> = Get<CfgOf<E>, 'body'> extends z.ZodType ? true : false;
type HasFiles<E extends AnyEndpoint> = Get<CfgOf<E>, 'files'> extends Readonly<Record<string, z.ZodType>> ? true : false;
type HasRawStreamIn<E extends AnyEndpoint> = Get<CfgOf<E>, 'streamIn'> extends string ? true : false;
type HasItemStreamIn<E extends AnyEndpoint> = Get<CfgOf<E>, 'streamIn'> extends z.ZodType ? true : false;
type InItemSchema<E extends AnyEndpoint> = Get<CfgOf<E>, 'streamIn'> extends z.ZodType ? Get<CfgOf<E>, 'streamIn'> & z.ZodType : never;
type HasStreamIn<E extends AnyEndpoint> = Get<CfgOf<E>, 'streamIn'> extends string | z.ZodType ? true : false;
type HasRawStreamOut<E extends AnyEndpoint> = Get<CfgOf<E>, 'streamOut'> extends string ? true : false;
type HasItemStream<E extends AnyEndpoint> = Get<CfgOf<E>, 'streamOut'> extends z.ZodType ? true : false;
type ItemSchema<E extends AnyEndpoint> = Get<CfgOf<E>, 'streamOut'> extends z.ZodType ? Get<CfgOf<E>, 'streamOut'> & z.ZodType : never;

type BRaw<E extends AnyEndpoint, M extends IOMode> = Get<CfgOf<E>, 'body'> extends z.ZodType ? ZIO<Get<CfgOf<E>, 'body'> & z.ZodType, M> : never;
/** A body merges into the flat object only when it is a plain string-keyed record. */
type BMergeable<E extends AnyEndpoint, M extends IOMode> = HasBody<E> extends true ? ([BRaw<E, M>] extends [Record<string, unknown>] ? true : false) : false;
type BFlat<E extends AnyEndpoint, M extends IOMode> = BMergeable<E, M> extends true ? BRaw<E, M> : EmptyObject;

/* ---- single data payload --------------------------------------------------
 * Kinds are disjoint by construction (validated at spec time + compile time),
 * so params + query + body + files merge losslessly into one object: `data`.
 * A non-object body can't merge — it then IS the data, and excludes the others. */
type NonMergeableBody<E extends AnyEndpoint> = HasBody<E> extends true ? (BMergeable<E, 'in'> extends true ? false : true) : false;

type ClientFlat<E extends AnyEndpoint> = Simplify<PShape<E, 'in'> & QShape<E, 'in'> & BFlat<E, 'in'> & FShape<E, 'in'>>;
/**
 * The single `data` argument the client passes to `call()` — the merged
 * path/query/body/files object, or the raw value when the body is a non-object
 * (then it *is* the data).
 */
export type ClientData<E extends AnyEndpoint> = NonMergeableBody<E> extends true ? BRaw<E, 'in'> : ClientFlat<E>;

/** Accepted shapes for a raw streaming request body. */
export type StreamBody = ReadableStream<Uint8Array> | Blob | ArrayBuffer | string;

/**
 * Whether an endpoint is HTTP-only (cannot use the `'ws'` transport): raw byte
 * streams and file uploads are HTTP-only; typed item streams travel over ws too.
 */
export type IsHttpOnly<E extends AnyEndpoint> = Get<CfgOf<E>, 'httpOnly'> extends true
  ? true
  : HasFiles<E> extends true
    ? true
    : HasRawStreamIn<E> extends true
      ? true
      : HasRawStreamOut<E> extends true
        ? true
        : false;

/** Options common to every `call()`. */
export interface CallOptsBase {
  /** Abort signal — cancels the in-flight request (and, over ws, the call). */
  readonly signal?: AbortSignal;
  /** Extra request headers (also used to deliver typed request headers/cookies). */
  readonly headers?: Readonly<Record<string, string>>;
}
/**
 * The per-call options object. Adds a `transport` choice (narrowed to `'http'`
 * for HTTP-only endpoints) and a **required** `stream` for streaming-input
 * endpoints.
 */
export type CallOpts<E extends AnyEndpoint> = CallOptsBase &
  (IsHttpOnly<E> extends true ? { readonly transport?: 'http' } : { readonly transport?: 'http' | 'ws' }) &
  (HasRawStreamIn<E> extends true
    ? { readonly stream: StreamBody }
    : HasItemStreamIn<E> extends true
      ? { readonly stream: AsyncIterable<z.input<InItemSchema<E>>> | (() => AsyncIterable<z.input<InItemSchema<E>>>) }
      : EmptyObject);

/** What `call()` resolves to: an async iterable for item streams, a `ReadableStream` for raw streams, a `{ status, data }` union for multi-status, the response, or `void`. */
export type CallReturn<E extends AnyEndpoint> = HasItemStream<E> extends true
  ? AsyncIterable<z.output<ItemSchema<E>>>
  : HasRawStreamOut<E> extends true
    ? Promise<ReadableStream<Uint8Array>>
    : HasMulti<E> extends true
      ? Promise<{ [St in keyof RespMap<E> & number]: { status: St; data: z.output<RespMap<E>[St] & z.ZodType> } }[keyof RespMap<E> & number]>
      : Get<CfgOf<E>, 'response'> extends z.ZodType
        ? Promise<z.output<Get<CfgOf<E>, 'response'> & z.ZodType>>
        : Promise<void>;

/**
 * The positional arguments to `call(name, …)`, computed per endpoint: data-less
 * endpoints take `opts?` first; streaming-input endpoints require `opts`; a
 * non-object body is a required positional value; everything else takes the
 * merged `data` (optional when every key is optional).
 */
export type CallArgs<E extends AnyEndpoint> = HasStreamIn<E> extends true
  ? [keyof ClientData<E>] extends [never]
    ? [data: undefined, opts: CallOpts<E>]
    : EmptyObject extends ClientData<E>
      ? [data: ClientData<E> | undefined, opts: CallOpts<E>]
      : [data: ClientData<E>, opts: CallOpts<E>]
  : NonMergeableBody<E> extends true
    ? [data: ClientData<E>, opts?: CallOpts<E>]
    : [keyof ClientData<E>] extends [never]
      ? [opts?: CallOpts<E>]
      : EmptyObject extends ClientData<E>
        ? [data?: ClientData<E>, opts?: CallOpts<E>]
        : [data: ClientData<E>, opts?: CallOpts<E>];

/* ---- handler payload ------------------------------------------------------ */
type HandlerFlat<E extends AnyEndpoint> = Simplify<PShape<E, 'out'> & QShape<E, 'out'> & BFlat<E, 'out'> & FShape<E, 'out'>>;
type HandlerData<E extends AnyEndpoint> = NonMergeableBody<E> extends true ? BRaw<E, 'out'> : HandlerFlat<E>;

/** The positional arguments to `emit(name, …)`: `(params, data)` for parameterized events, `(data)` otherwise. */
export type EmitArgs<Ev extends EventConfig> = Get<Ev, 'params'> extends z.ZodType
  ? [params: z.input<Get<Ev, 'params'> & z.ZodType>, data: z.input<Ev['data']>]
  : [data: z.input<Ev['data']>];
/** The typed `emit` function for a spec's events, available on the server and in handlers. */
export type EmitFn<S extends AnySpec> = <K extends keyof EventsOf<S> & string>(
  name: K,
  ...args: EmitArgs<EventsOf<S>[K] & EventConfig>
) => void;

/**
 * The object a handler receives. The middleware context spreads at the root,
 * alongside a single merged `data`, the declared kinds (`stream`, `headers`,
 * `cookies`), and the framework toolkit (`req`, `signal`, `emit`, `status()`,
 * `header()`, `cookie()`, and — gated by config — `out`/`download()`/`length()`/`fail()`).
 *
 * @typeParam S - the owning spec (for the typed `emit`).
 * @typeParam E - the endpoint.
 */
export type HandlerPayload<S extends AnySpec, E extends AnyEndpoint> = Simplify<
  CtxOf<E> &
    (NonMergeableBody<E> extends true
      ? { readonly data: HandlerData<E> }
      : [keyof HandlerFlat<E>] extends [never]
        ? EmptyObject
        : { readonly data: HandlerData<E> }) &
    (HasRawStreamIn<E> extends true ? { readonly stream: ReadableStream<Uint8Array> } : EmptyObject) &
    (HasItemStreamIn<E> extends true ? { readonly stream: AsyncIterable<z.output<InItemSchema<E>>> } : EmptyObject) &
    (HasRawStreamOut<E> extends true
      ? {
          /** Pipe target — `await readable.pipeTo(out)` (or write via `getWriter()`); strings are utf-8 encoded. */
          readonly out: WritableStream<Uint8Array | string>;
          /** Set `Content-Disposition`/content-type dynamically; must be called before the first byte streams. */
          readonly download: (filename: string, contentType?: string) => void;
          /** Declare the total byte length — enables `Content-Length` and HTTP Range (resumable downloads). */
          readonly length: (totalBytes: number) => void;
        }
      : EmptyObject) &
    (HasHeaders<E> extends true ? { readonly headers: HShape<E, 'out'> } : EmptyObject) &
    (HasCookies<E> extends true ? { readonly cookies: CShape<E, 'out'> } : EmptyObject) &
    (HasErrors<E> extends true ? { readonly fail: FailFn<ErrorsOf<E>> } : EmptyObject) & {
      readonly req: Request;
      readonly signal: AbortSignal;
      readonly emit: EmitFn<S>;
      /** Override the HTTP status (default 200/204/201…); HTTP transport only, before the first streamed byte. */
      readonly status: (code: number) => void;
      /** Set a response header; HTTP transport only, before the first streamed byte. */
      readonly header: (name: string, value: string) => void;
      /** Append a `Set-Cookie` header; HTTP transport only. */
      readonly cookie: (name: string, value: string, opts?: CookieOptions) => void;
    }
>;

/** What a handler may return, per endpoint: an item-stream iterable, raw bytes, a `{ status, data }` union, the response, or `void`. */
export type HandlerReturn<E extends AnyEndpoint> = HasItemStream<E> extends true
  ? MaybePromise<AsyncIterable<z.output<ItemSchema<E>>>>
  : HasRawStreamOut<E> extends true
    ? MaybePromise<ReadableStream<Uint8Array> | AsyncIterable<string | Uint8Array> | void>
    : HasMulti<E> extends true
      ? MaybePromise<{ [St in keyof RespMap<E> & number]: { readonly status: St; readonly data: z.input<RespMap<E>[St] & z.ZodType> } }[keyof RespMap<E> & number]>
      : Get<CfgOf<E>, 'response'> extends z.ZodType
        ? MaybePromise<z.output<Get<CfgOf<E>, 'response'> & z.ZodType>>
        : MaybePromise<void>;

/** A handler function for endpoint `E` of spec `S`. */
export type HandlerFor<S extends AnySpec, E extends AnyEndpoint> = (payload: HandlerPayload<S, E>) => HandlerReturn<E>;
