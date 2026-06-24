/**
 * # ayepi
 *
 * zod-first, painfully-typed HTTP + WebSocket API library. Define endpoints and
 * events once with zod schemas as the single source of truth, and get a typed
 * server, a typed client, OpenAPI 3.1 + AsyncAPI 3.0 docs, and a zod-free runtime
 * manifest.
 *
 * ```ts
 * const api = spec({ endpoints: { … }, events: { … } })
 * const app = server(api, [handlers], { broker, cors }) // app.fetch(Request) => Response
 * const sdk = client<typeof api>({ baseUrl, manifest, ws })
 * const user = await sdk.call('getUser', { id: 'u1' })   // fully typed
 * ```
 *
 * This is the full surface (server + client). For a **zod-free** client-only
 * entry point, import from `ayepi/client`.
 *
 * @module
 */

/* --- type utilities --- */
export type { Simplify, MaybePromise, Json } from './types';

/* --- retry --- */
export { retry, backoff, RetryAbort, DEFAULT_RETRY_OPTIONS, setDefaultRetryOptions, getDefaultRetryOptions } from './retry';
export type { RetryOptions, RetryState } from './retry';

/* --- stats / metrics --- */
export { createMetrics, formatPrometheus, DEFAULT_BUCKETS } from './stats';
export type { Metrics, MetricsOptions, Counter, Gauge, Summary, StatKind, StatMeta, StatValue, StatSummary, StatBucket, Labels } from './stats';

/* --- path templates --- */
export type { AnyPathTemplate, PathTemplate, PathPart } from './path';
export { splitPattern, joinPattern, matchParts, buildParts, path } from './path';

/* --- middleware --- */
export type {
  MiddlewareResult,
  MiddlewareIO,
  MiddlewareFn,
  LoaderFn,
  AnyMiddleware,
  Middleware,
  Stack,
  StackCtx,
  StackLP,
  MiddlewareFactory,
  MiddlewareDoc,
  Provide,
  MiddlewareImplFor,
  LoaderImplFor,
  ImplFor,
  BoundMiddleware,
  ProvideMiddleware,
  Transport,
  RouteInfo,
  WsFrameInfo,
} from './middleware';
export { middleware, ctx, use, provide } from './middleware';

/* --- endpoints + spec --- */
export type {
  EndpointDoc,
  EventDoc,
  SpecDoc,
  CookieOptions,
  EndpointConfig,
  AnyEndpoint,
  Endpoint,
  CheckCfg,
  EventConfig,
  SpecShape,
  AnySpec,
  EventsOf,
} from './endpoint';
export { endpoint, spec, manifestFromSpec } from './endpoint';

/* --- payload type machinery --- */
export type {
  FailFn,
  ClientData,
  StreamBody,
  IsHttpOnly,
  CallOptsBase,
  CallOpts,
  CallReturn,
  CallArgs,
  EmitArgs,
  EmitFn,
  HandlerPayload,
  HandlerReturn,
  HandlerFor,
} from './payload';

/* --- manifest --- */
export type { HttpMethod, ManifestEndpoint, ManifestEvent, Manifest } from './manifest';

/* --- errors --- */
export { ApiError, reject } from './errors';

/* --- broker --- */
export type { Broker } from './broker';
export { localBroker } from './broker';

/* --- server --- */
export type { Implementor, ServerOptions, Server, WsConn, CorsOptions, LocalClient, LocalCallOptions, MountHandle } from './server';
export { implement, server, localClient } from './server';

/* --- docs UI --- */
export type { DocsOptions } from './docs-ui';
export { swaggerHtml, redocHtml, asyncapiHtml } from './docs-ui';

/* --- client --- */
export type { ClientWs, ClientOptions, ApiClient, GetUrlKeys } from './client';
export { client } from './client';

/* --- websocket transport --- */
export type {
  WsTransport,
  WsTransportOptions,
  WsState,
  BackoffOptions,
  HeartbeatOptions,
  WebSocketLike,
  WebSocketCtor,
  WsMessageEvent,
} from './ws-transport';
export { wsTransport } from './ws-transport';
