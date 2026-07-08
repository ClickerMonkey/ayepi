/**
 * # Manifest
 *
 * The **zod-free runtime configuration** the client needs. It carries exactly
 * enough structure (per-endpoint key tables, method, path, streaming flags) for
 * the client to split a single `data` payload back into path/query/body/files
 * and pick a transport — with no zod schemas, so the frontend bundle stays
 * schema-free. Obtain it from `app.manifest()` or {@link manifestFromSpec}.
 *
 * Every field here is part of the **frozen v0 wire contract**.
 *
 * @module
 */

/** The HTTP methods ayepi endpoints may use. */
export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/**
 * Runtime description of a single endpoint — everything the client must know to
 * build a request and interpret a response without access to the zod schemas.
 */
export interface ManifestEndpoint {
  /** HTTP method (default `POST`). */
  readonly method: HttpMethod;
  /** Path pattern with `:key` segments, e.g. `/users/:id`. */
  readonly path: string;
  /** Explicit WebSocket id, or `null` to address the endpoint by `method + path`. */
  readonly ws: string | null;
  /** When `true`, the endpoint cannot be called over ws (raw streams / files). */
  readonly httpOnly: boolean;
  /** Content-type of the streamed request body (raw, or NDJSON for item streams); `null` if none. */
  readonly streamIn: string | null;
  /** `true` when `streamIn` is a typed NDJSON item stream (vs a raw byte stream). */
  readonly itemsIn: boolean;
  /** Content-type of the streamed response (raw, or NDJSON/SSE for item streams); `null` if none. */
  readonly streamOut: string | null;
  /** `true` when `streamOut` is a typed item stream (vs a raw byte stream). */
  readonly items: boolean;
  /** Path-param keys, in path order. */
  readonly p: readonly string[];
  /** Query-param keys. */
  readonly q: readonly string[];
  /** Body keys, `'raw'` when the body is the entire data payload, or `null` when there is no body. */
  readonly b: readonly string[] | 'raw' | null;
  /** Multipart file-field keys. */
  readonly f: readonly string[];
  /** Whether the endpoint declares a body at all. */
  readonly hasBody: boolean;
  /** Whether the endpoint declares typed request headers. */
  readonly hasHeaders: boolean;
  /** When `true`, `call()` resolves a `{ status, data }` discriminated union. */
  readonly multi: boolean;
  /** Body wire encoding, or `null` when there is no body. */
  readonly bodyEnc: 'json' | 'urlencoded' | null;
  /**
   * Whether calling this endpoint mutates server state — governs whether the
   * client {@link caller} may **replay** it after a transient disconnect.
   * Optional/additive: when absent, replay-safety is derived from `method`
   * (only `GET` is treated as side-effect-free). Read defensively.
   */
  readonly sideEffects?: boolean;
}

/** Runtime description of a single server-pushed event channel. */
export interface ManifestEvent {
  /** WebSocket channel id. */
  readonly ws: string;
  /** Whether the channel is parameterized (subscriptions are keyed by params). */
  readonly hasParams: boolean;
}

/**
 * The complete zod-free runtime manifest consumed by {@link client} — obtained
 * from `app.manifest()` or {@link manifestFromSpec}. Hand a client this manifest
 * (instead of the spec) to talk to a server without shipping its schema code.
 */
export interface Manifest {
  readonly endpoints: Readonly<Record<string, ManifestEndpoint>>;
  readonly events: Readonly<Record<string, ManifestEvent>>;
}
