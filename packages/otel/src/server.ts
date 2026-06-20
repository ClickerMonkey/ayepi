/**
 * # @ayepi/otel/server — telemetry **impl** binder (node)
 *
 * The server half of `@ayepi/otel`: it binds a frontend-safe {@link telemetry} def
 * to its runtime behaviour. This is the only entry that pulls `node:crypto` (for
 * the fallback request id) and `@ayepi/log` (for the trace context + log lines), so
 * it must never be imported by a spec a frontend build consumes.
 *
 * It does two things, both optional and independently configurable:
 *
 * 1. **Enriches the `@ayepi/log` trace context** for the whole request — every
 *    inner `logger.*` call during the downstream chain + handler inherits the
 *    chosen fields (request id, method, path, ip, …).
 * 2. **Emits a request and/or response log line** with configurable fields and
 *    level, with reliable `duration` + `error` and best-effort `status`.
 *
 * It is **transport-neutral**: `method`/`path`/`name` come from `io.route`, and over
 * ws the per-call request id is the **frame id** (`io.ws.id`). See `ayepi-otel.md`.
 *
 * ```ts
 * import { telemetry } from '@ayepi/otel/server';
 * implement(api).middleware(telemetry.server(tel, { echoRequestId: true }));
 * ```
 *
 * @module
 */

import type {
  AnyMiddleware,
  BoundMiddleware,
  ImplFor,
  MiddlewareIO,
  RouteInfo,
  StackCtx,
} from '@ayepi/core';
import { ApiError } from '@ayepi/core';
import { logger as defaultLogger, logWith as defaultLogWith } from '@ayepi/log';
import type { Level, Logger } from '@ayepi/log';
import { randomUUID } from 'node:crypto';
import { telemetry as telemetryDef } from './index';

/* ---- constants ---- */
/** Fallback HTTP status when a thrown error is not an {@link ApiError}. */
const DEFAULT_ERROR_STATUS = 500;
/** Default success status for a plain-object / void handler result. */
const DEFAULT_OK_STATUS = 200;
/** Header carrying a caller-supplied request id (the default requestId source). */
const REQUEST_ID_HEADER = 'x-request-id';
/** Default header name used when {@link TelemetryServerOptions.echoRequestId} is `true`. */
const DEFAULT_ECHO_HEADER = 'x-request-id';
/** Header carrying the upstream client ip (checked before `X-Real-IP`). */
const FORWARDED_FOR_HEADER = 'x-forwarded-for';
/** Header carrying the client ip when there is no proxy chain. */
const REAL_IP_HEADER = 'x-real-ip';
/** Header carrying a distributed-trace id (W3C `traceparent` or a bare id). */
const TRACE_HEADER = 'x-trace-id';
/** Header carrying the request body size in bytes. */
const CONTENT_LENGTH_HEADER = 'content-length';
/** Default log level for the request/response lines. */
const DEFAULT_LEVEL: Level = 'info';
/** Default message for the request log line. */
const DEFAULT_REQUEST_MSG = 'request';
/** Default message for the response log line. */
const DEFAULT_RESPONSE_MSG = 'response';

/* ---- field selections ---- */

/**
 * Request-derived fields, each independently toggleable. A `true` includes the
 * field (when derivable); a `false`/omitted excludes it.
 */
export interface RequestFieldFlags {
  /** The matched route name (`io.route.name`) — the endpoint/event label. */
  readonly name?: boolean;
  /** The resolved request id (see {@link TelemetryServerOptions.requestId}). */
  readonly requestId?: boolean;
  /** The HTTP method, from `io.route` (absent on an `event` route). */
  readonly method?: boolean;
  /** The route path, from `io.route` (absent on an `event` route). */
  readonly path?: boolean;
  /** The transport this invocation arrived on (`'http'` or `'ws'`), from `io.transport`. */
  readonly transport?: boolean;
  /** The client ip, from `X-Forwarded-For` (first hop) then `X-Real-IP`. */
  readonly ip?: boolean;
  /** The request body size in bytes, from `Content-Length`. */
  readonly size?: boolean;
  /** A distributed-trace id, from `X-Trace-Id` / `traceparent`. */
  readonly traceId?: boolean;
}

/**
 * Response-derived fields, each independently toggleable. `duration` and `error`
 * are reliable; `status` is best-effort and `size` is rarely derivable from a
 * middleware (see {@link ResponseFieldFlags.size}).
 */
export interface ResponseFieldFlags {
  /** The response status (best-effort: 200 / multi-status `{ status }` / `ApiError.status` / 500). */
  readonly status?: boolean;
  /** The wall-clock duration in milliseconds. */
  readonly duration?: boolean;
  /** The response "type" — `'json' | 'multi' | 'stream' | 'response' | 'empty' | 'error'`. */
  readonly type?: boolean;
  /** A serialized error on the failure path. */
  readonly error?: boolean;
  /**
   * The response body size in bytes. Only derivable when a middleware
   * short-circuits with a `Response` that carries `Content-Length`; omitted
   * otherwise. Opt-in and honestly limited — see `ayepi-otel.md`.
   */
  readonly size?: boolean;
}

/* ---- options ---- */

/**
 * The subset of {@link TelemetryServerOptions} that can be overridden **per route**
 * via {@link TelemetryServerOptions.overrides}. Everything here is per-call
 * behaviour; the plumbing options (`logger`, `logWith`, `now`, `extra`) are not.
 */
export interface PerCallOptions {
  /** Override the emitted `name` field value for this route. */
  readonly name?: string;
  /** Override the log level for both lines on this route. */
  readonly level?: Level;
  /** Override the `context` (`logWith`) field selection on this route. */
  readonly context?: RequestFieldFlags;
  /** Override the request-line field selection on this route (`false` disables it). */
  readonly request?: RequestFieldFlags | false;
  /** Override the response-line field selection on this route (`false` disables it). */
  readonly response?: ResponseFieldFlags | false;
  /** Override the request-id echo behaviour on this route. */
  readonly echoRequestId?: boolean | string;
}

/** The `requires` chain of a middleware def. */
type ReqOf<M extends AnyMiddleware> = M['__req'];

/**
 * Server-side options for binding a {@link telemetry} def. Every field has a
 * sensible default; the three field sets ({@link context}, {@link request},
 * {@link response}) are configured independently.
 *
 * @typeParam M - the telemetry def being bound (its `requires` type the `extra`
 *   callback reads).
 */
export interface TelemetryServerOptions<M extends AnyMiddleware> {
  /** Log level for the request/response lines (default `'info'`). */
  readonly level?: Level;
  /**
   * Which request fields go into the `logWith` trace context inherited by every
   * inner log. Default: `{ requestId: true, method: true, path: true }`.
   */
  readonly context?: RequestFieldFlags;
  /**
   * The request log line. `false` disables it; an object selects fields
   * (default: `{ method: true, path: true, requestId: true }`).
   */
  readonly request?: RequestFieldFlags | false;
  /**
   * The response log line. `false` disables it; an object selects fields
   * (default: `{ status: true, duration: true }`).
   */
  readonly response?: ResponseFieldFlags | false;
  /**
   * Per-route overrides, keyed by `io.route.name` (the endpoint/event key). The
   * matching entry is shallow-merged over the base per-call config at call time.
   */
  readonly overrides?: Record<string, PerCallOptions>;
  /**
   * Resolve the request id from the upgrade/HTTP request. Highest precedence;
   * default precedence when omitted is `io.ws?.id` (the ws frame id) →
   * `X-Request-ID` header → a generated UUID.
   */
  readonly requestId?: (req: Request) => string;
  /**
   * Echo the resolved request id back on the response via `io.setHeader`. `false`
   * (default) does nothing; `true` uses the `x-request-id` header; a string uses
   * that header name.
   */
  readonly echoRequestId?: boolean | string;
  /** Extra static/dynamic fields merged into every derived field bag (lowest precedence). */
  readonly extra?: (ctx: StackCtx<ReqOf<M>>, req: Request) => Record<string, unknown>;
  /** Logger used to emit the request/response lines (default the `@ayepi/log` default logger). */
  readonly logger?: Logger;
  /** `logWith` used to push the trace context (default the `@ayepi/log` default `logWith`). */
  readonly logWith?: <T>(add: object, inner: () => T) => T;
  /**
   * Observe an error thrown by the telemetry itself — your `extra` callback, a log call, or
   * the context push. Telemetry is **fail-open**: such an error never breaks the request (the
   * handler runs and its result/error are returned untouched); this hook just lets you notice.
   * Off by default. It must not throw; if it does, the throw is ignored.
   */
  readonly onError?: (err: unknown) => void;
  /** Clock for durations, in ms (default `Date.now`). Inject for deterministic tests. */
  readonly now?: () => number;
}

/* ---- defaults ---- */
const DEFAULT_CONTEXT_FIELDS: RequestFieldFlags = { requestId: true, method: true, path: true };
const DEFAULT_REQUEST_FIELDS: RequestFieldFlags = { method: true, path: true, requestId: true };
const DEFAULT_RESPONSE_FIELDS: ResponseFieldFlags = { status: true, duration: true };

/* ---- per-call config resolution ---- */

/**
 * The base per-call config built from the bind options. `name` and `level` are
 * always concrete, so they survive the merge.
 */
interface BaseCall extends PerCallOptions {
  readonly name: string;
  readonly level: Level;
}

/** The fully-resolved per-call configuration (after applying any route override). */
interface ResolvedCall {
  readonly name: string;
  readonly level: Level;
  readonly contextFlags: RequestFieldFlags;
  readonly requestFlags: RequestFieldFlags | null;
  readonly responseFlags: ResponseFieldFlags | null;
  readonly echoRequestId: boolean | string;
}

/** Resolve the per-call config for a route, applying its {@link TelemetryServerOptions.overrides} entry (if any). */
function resolveCall(base: BaseCall, overrides: Record<string, PerCallOptions> | undefined, routeName: string): ResolvedCall {
  const o = overrides?.[routeName];
  const merged: BaseCall = o ? { ...base, ...o } : base;
  const request = merged.request;
  const response = merged.response;
  return {
    name: merged.name,
    level: merged.level,
    contextFlags: merged.context ?? DEFAULT_CONTEXT_FIELDS,
    requestFlags: request === false ? null : (request ?? DEFAULT_REQUEST_FIELDS),
    responseFlags: response === false ? null : (response ?? DEFAULT_RESPONSE_FIELDS),
    echoRequestId: merged.echoRequestId ?? false,
  };
}

/* ---- request-field derivation ---- */

/** All candidate request fields, computed once per request. */
interface DerivedRequest {
  readonly name: string;
  readonly requestId: string;
  readonly method: string | undefined;
  readonly path: string | undefined;
  readonly transport: string;
  readonly ip: string | undefined;
  readonly size: number | undefined;
  readonly traceId: string | undefined;
}

/**
 * Resolve the request id. Precedence: caller `override(req)` → the ws **frame id**
 * (`io.ws.id`, the real per-call id) → `X-Request-ID` header → a generated UUID.
 */
function resolveRequestId(io: MiddlewareIO<object>, override: ((req: Request) => string) | undefined): string {
  if (override) {
    return override(io.req);
  }
  if (io.ws) {
    return io.ws.id;
  }
  const header = io.req.headers.get(REQUEST_ID_HEADER);
  if (header) {
    return header;
  }
  return randomUUID();
}

/** First-hop client ip from `X-Forwarded-For`, else `X-Real-IP`, else `undefined`. */
function resolveIp(req: Request): string | undefined {
  const fwd = req.headers.get(FORWARDED_FOR_HEADER);
  if (fwd) {
    return fwd.split(',')[0]!.trim();
  }
  const real = req.headers.get(REAL_IP_HEADER);
  return real ?? undefined;
}

/** Body size in bytes from `Content-Length`, if present and numeric. */
function resolveSize(req: Request): number | undefined {
  const raw = req.headers.get(CONTENT_LENGTH_HEADER);
  if (raw === null) {
    return undefined;
  }
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

/** The method/path for a route — present for endpoints, absent for events. */
function routeMethodPath(route: RouteInfo): { method: string | undefined; path: string | undefined } {
  if (route.kind === 'endpoint') {
    return { method: route.method, path: route.path };
  }
  return { method: undefined, path: undefined };
}

/** Compute every candidate request field for this invocation. */
function deriveRequest(io: MiddlewareIO<object>, name: string, override: ((req: Request) => string) | undefined): DerivedRequest {
  const { method, path } = routeMethodPath(io.route);
  return {
    name,
    requestId: resolveRequestId(io, override),
    method,
    path,
    transport: io.transport,
    ip: resolveIp(io.req),
    size: resolveSize(io.req),
    traceId: io.req.headers.get(TRACE_HEADER) ?? undefined,
  };
}

/** Pick the toggled-on request fields, dropping any that are `undefined`. */
function pickRequest(derived: DerivedRequest, flags: RequestFieldFlags): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (flags.name) {
    out.name = derived.name;
  }
  if (flags.requestId) {
    out.requestId = derived.requestId;
  }
  if (flags.method && derived.method !== undefined) {
    out.method = derived.method;
  }
  if (flags.path && derived.path !== undefined) {
    out.path = derived.path;
  }
  if (flags.transport) {
    out.transport = derived.transport;
  }
  if (flags.ip && derived.ip !== undefined) {
    out.ip = derived.ip;
  }
  if (flags.size && derived.size !== undefined) {
    out.size = derived.size;
  }
  if (flags.traceId && derived.traceId !== undefined) {
    out.traceId = derived.traceId;
  }
  return out;
}

/* ---- response-field derivation ---- */

/** The response "type" discriminant emitted in the `type` field. */
type ResponseType = 'json' | 'multi' | 'stream' | 'response' | 'empty' | 'error';

/** Inspect a successful handler result for status + type + (rarely) size. */
function inspectResult(result: unknown): { status: number; type: ResponseType; size: number | undefined } {
  if (result instanceof Response) {
    const len = result.headers.get(CONTENT_LENGTH_HEADER);
    const n = len === null ? undefined : Number(len);
    return { status: result.status, type: 'response', size: n !== undefined && Number.isFinite(n) ? n : undefined };
  }
  if (isMultiStatus(result)) {
    return { status: result.status, type: 'multi', size: undefined };
  }
  if (isAsyncIterable(result)) {
    return { status: DEFAULT_OK_STATUS, type: 'stream', size: undefined };
  }
  if (result === undefined || result === null) {
    return { status: DEFAULT_OK_STATUS, type: 'empty', size: undefined };
  }
  return { status: DEFAULT_OK_STATUS, type: 'json', size: undefined };
}

/** True for a multi-status handler result of the shape `{ status, data }`. */
function isMultiStatus(v: unknown): v is { status: number; data: unknown } {
  return typeof v === 'object' && v !== null && typeof (v as { status?: unknown }).status === 'number' && 'data' in v;
}

/** True for an async-iterable handler result (a typed/raw stream). */
function isAsyncIterable(v: unknown): v is AsyncIterable<unknown> {
  return typeof v === 'object' && v !== null && typeof (v as { [Symbol.asyncIterator]?: unknown })[Symbol.asyncIterator] === 'function';
}

/** Build the response log fields for the success path. */
function pickResponseOk(result: unknown, duration: number, flags: ResponseFieldFlags): Record<string, unknown> {
  const { status, type, size } = inspectResult(result);
  const out: Record<string, unknown> = {};
  if (flags.status) {
    out.status = status;
  }
  if (flags.duration) {
    out.duration = duration;
  }
  if (flags.type) {
    out.type = type;
  }
  if (flags.size && size !== undefined) {
    out.size = size;
  }
  return out;
}

/** Build the non-error response fields for the error path (the raw error is logged separately). */
function pickResponseErr(err: unknown, duration: number, flags: ResponseFieldFlags): Record<string, unknown> {
  const status = err instanceof ApiError ? err.status : DEFAULT_ERROR_STATUS;
  const fields: Record<string, unknown> = {};
  if (flags.status) {
    fields.status = status;
  }
  if (flags.duration) {
    fields.duration = duration;
  }
  if (flags.type) {
    fields.type = 'error';
  }
  return fields;
}

/** Resolve the echo header name, or `null` when echoing is off. */
function echoHeaderName(echo: boolean | string): string | null {
  if (echo === false) {
    return null;
  }
  if (echo === true) {
    return DEFAULT_ECHO_HEADER;
  }
  return echo;
}

/* ---- binder ---- */

/** Bind a {@link telemetry} def to its runtime behaviour. */
function telemetryServer<M extends AnyMiddleware>(def: M, opts: TelemetryServerOptions<M> = {}): BoundMiddleware<M> {
  const name = def.name;
  const log = opts.logger ?? defaultLogger;
  const wrap = opts.logWith ?? defaultLogWith;
  const now = opts.now ?? Date.now;
  const overrides = opts.overrides;

  const base: BaseCall = {
    name,
    level: opts.level ?? DEFAULT_LEVEL,
    context: opts.context,
    request: opts.request,
    response: opts.response,
    echoRequestId: opts.echoRequestId,
  };

  // Telemetry is best-effort: a failure in *our* logging must never break the request. Run a
  // bookkeeping step guarded, reporting any throw to `onError` (itself guarded) and moving on.
  const safely = (fn: () => void): void => {
    try {
      fn();
    } catch (err) {
      try {
        opts.onError?.(err);
      } catch {
        /* error reporting must never break the request */
      }
    }
  };

  const run = (io: MiddlewareIO<StackCtx<ReqOf<M>>>): Promise<unknown> => {
    const call = resolveCall(base, overrides, io.route.name);
    const derived = deriveRequest(io, call.name, opts.requestId);
    const echoHeader = echoHeaderName(call.echoRequestId);
    if (echoHeader) {
      io.setHeader(echoHeader, derived.requestId);
    }
    let extra: Record<string, unknown> = {};
    safely(() => {
      extra = opts.extra ? opts.extra(io.ctx, io.req) : {};
    });
    let ctxFields: object = { ...extra };
    safely(() => {
      ctxFields = { ...extra, ...pickRequest(derived, call.contextFlags) };
    });
    // the chain (`io.next()`) runs inside the log context but **outside** every guard, so the
    // handler's own result and errors pass through untouched.
    const body = (): Promise<unknown> => {
      safely(() => {
        if (call.requestFlags) {
          log.log(call.level, DEFAULT_REQUEST_MSG, { ...extra, ...pickRequest(derived, call.requestFlags) });
        }
      });
      const start = now();
      return io.next().then(
        (result) => {
          safely(() => {
            if (call.responseFlags) {
              log.log(call.level, DEFAULT_RESPONSE_MSG, pickResponseOk(result, now() - start, call.responseFlags));
            }
          });
          return result;
        },
        (err: unknown) => {
          safely(() => {
            if (call.responseFlags) {
              const fields = pickResponseErr(err, now() - start, call.responseFlags);
              if (call.responseFlags.error) {
                log.error(DEFAULT_RESPONSE_MSG, fields, err);
              } else {
                log.error(DEFAULT_RESPONSE_MSG, fields);
              }
            }
          });
          throw err; // re-raise the handler's own error untouched
        },
      );
    };
    try {
      return wrap(ctxFields, body);
    } catch (err) {
      safely(() => {
        throw err;
      }); // report a context-push failure…
      return body(); // …then run without the log context rather than failing the request
    }
  };

  return { def, impl: run as unknown as ImplFor<M> }; // internal cast: the precise typed run presented as the def's bound impl
}

/**
 * The {@link telemetry} def factory, augmented with a `.server(def, opts)` binder.
 * Import from `@ayepi/otel/server` in your server entry to bind a def created in a
 * frontend-safe spec.
 */
export const telemetry = Object.assign(telemetryDef, { server: telemetryServer });
