/**
 * # ayepi/client — zod-free client entry
 *
 * The browser-facing entry point. It re-exports only the client surface and the
 * types it needs, and — critically — pulls in **zero zod runtime code** (zod is
 * imported type-only throughout the client path). Construct a client from a
 * {@link Manifest} to talk to an ayepi server without shipping its schemas to the
 * frontend.
 *
 * ```ts
 * import { client } from 'ayepi/client'
 * import manifest from './manifest.gen' // a prebuilt zod-free manifest (plain data)
 * import type { api } from '../server/api' // type-only — erased at build time
 *
 * const sdk = client<typeof api>({ baseUrl: '/', manifest })
 * ```
 *
 * @module
 */

export { client } from '../client';
export type { ClientWs, ClientOptions, ApiClient, GetUrlKeys } from '../client';
export { wsTransport } from '../ws-transport';
export type { WsTransport, WsTransportOptions, WsState, BackoffOptions, HeartbeatOptions, WebSocketLike, WebSocketCtor, WsMessageEvent } from '../ws-transport';
export { ApiError } from '../errors';
export type { Manifest, ManifestEndpoint, ManifestEvent, HttpMethod } from '../manifest';
export type { ClientData, CallOpts, CallArgs, CallReturn } from '../payload';
export type { AnySpec } from '../endpoint';
