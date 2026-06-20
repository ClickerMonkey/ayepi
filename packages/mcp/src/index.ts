/**
 * # `@ayepi/mcp`
 *
 * Turn any ayepi {@link AnySpec | spec} into **MCP tools** (Model Context
 * Protocol): each endpoint becomes a schema-validated tool whose input JSON
 * Schema and description are derived from the endpoint's zod config, and whose
 * calls are executed against a running {@link Server | app} via the typed
 * {@link client}.
 *
 * Three layers, smallest first:
 *
 * - {@link mcpTools} — pure: spec → array of {@link McpTool} definitions.
 * - {@link mcpServer} — wraps an app + spec into an {@link McpServer} that
 *   {@link McpServer.handle | handles} one JSON-RPC 2.0 request (`initialize`,
 *   `tools/list`, `tools/call`) by executing the tool against the app.
 * - {@link serveStdio} — a thin newline-delimited-JSON loop over an injected
 *   reader/writer (no hard-wired `process.stdin`), so it is testable with
 *   in-memory fakes.
 *
 * The transport is kept **out** of the core: `handle(request)` takes an already
 * parsed object and returns a plain response object (or `null` for
 * notifications), so the protocol is unit-testable without any I/O.
 *
 * @example
 * ```ts
 * const app = server(api, [handlers]);
 * const mcp = mcpServer(app, api, { serverInfo: { name: 'my-api', version: '1.0.0' } });
 * const res = await mcp.handle({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
 * ```
 *
 * @module
 */

import { z } from 'zod';
import { client } from '@ayepi/core';
import type { AnySpec, EndpointConfig, Server, ApiClient } from '@ayepi/core';

/* ---- constants ------------------------------------------------------------ */

/** The MCP protocol version this server advertises in the `initialize` handshake. */
const PROTOCOL_VERSION = '2024-11-05';
/** JSON-RPC 2.0 version string — every request/response carries it. */
const JSONRPC_VERSION = '2.0';
/** Default base URL for the internal {@link client}; only its path/query/host shape matters (requests go through `app.fetch`). */
const DEFAULT_BASE_URL = 'http://mcp.local';
/** Default server identity reported by `initialize` when the caller supplies none. */
const DEFAULT_SERVER_INFO = { name: 'ayepi-mcp', version: '0.0.0' } as const;

/** JSON-RPC error code: the requested method does not exist / is not available. */
const ERR_METHOD_NOT_FOUND = -32601;
/** JSON-RPC error code: the request object is not a valid Request object. */
const ERR_INVALID_REQUEST = -32600;

/* ---- tool definitions ----------------------------------------------------- */

/**
 * A single MCP tool definition: the shape an MCP client lists and invokes.
 *
 * `inputSchema` is a JSON Schema **object** describing the merged endpoint input
 * (path params + query + body keys flattened into one object).
 */
export interface McpTool {
  /** Tool name — the endpoint name, optionally {@link McpToolsOptions.namePrefix | prefixed}. */
  readonly name: string;
  /** Human/LLM-facing description, from the endpoint's doc summary/description. */
  readonly description: string;
  /** JSON Schema (`type: 'object'`) of the tool's input arguments. */
  readonly inputSchema: object;
}

/** Options shared by {@link mcpTools} and {@link mcpServer}. */
export interface McpToolsOptions {
  /**
   * Filter which endpoints become tools. Receives the endpoint name and its
   * config; return `false` to skip it. Defaults to including every endpoint.
   */
  readonly include?: (name: string, cfg: EndpointConfig) => boolean;
  /** Prefix prepended to every tool name (e.g. `'api_'`). */
  readonly namePrefix?: string;
}

/** A JSON Schema object fragment (loosely typed — JSON Schema is open-ended). */
type JsonSchemaObject = Record<string, unknown>;

/** Convert a zod schema to its input-view JSON Schema, degrading to a placeholder if zod cannot represent it. */
function toInputSchema(schema: z.ZodType): JsonSchemaObject {
  try {
    return z.toJSONSchema(schema, { io: 'input' }) as JsonSchemaObject;
  } catch {
    return { type: 'string', description: 'unrepresentable schema' };
  }
}

/** Read the `properties`/`required` of a zod object schema's JSON Schema (or empties when absent / non-object). */
function objectMembers(schema: z.ZodType | undefined): { properties: JsonSchemaObject; required: string[] } {
  if (!schema) {
    return { properties: {}, required: [] };
  }
  const js = toInputSchema(schema);
  const properties = js.properties && typeof js.properties === 'object' ? (js.properties as JsonSchemaObject) : {};
  const required = Array.isArray(js.required) ? (js.required as string[]) : [];
  return { properties, required };
}

/**
 * Build the merged input JSON Schema for one endpoint.
 *
 * Path params, query, and an **object** body each contribute their keys to a
 * single flat object schema (mirroring how the client merges the disjoint kinds
 * into one `data` payload). A **non-object** (raw) body becomes the entire
 * schema. `files` and raw `streamIn` byte streams cannot be expressed as JSON
 * tool arguments, so they are represented as a generic `string` field and noted
 * in the description rather than silently dropped.
 */
function inputSchemaFor(cfg: EndpointConfig): JsonSchemaObject {
  // A non-object body *is* the data payload — surface it directly.
  if (cfg.body && !(cfg.body instanceof z.ZodObject)) {
    return toInputSchema(cfg.body);
  }
  const properties: JsonSchemaObject = {};
  const required: string[] = [];
  for (const schema of [cfg.params, cfg.query, cfg.body]) {
    const { properties: props, required: req } = objectMembers(schema);
    Object.assign(properties, props);
    for (const key of req) {
      required.push(key);
    }
  }
  // Files / raw byte streams are not JSON-expressible; mark them so the tool input stays honest.
  for (const key of Object.keys(cfg.files ?? {})) {
    properties[key] = { type: 'string', description: 'file field (not transferable as a JSON tool argument)' };
  }
  const schema: JsonSchemaObject = { type: 'object', properties };
  if (required.length > 0) {
    schema.required = required;
  }
  return schema;
}

/** Derive a tool's description from its endpoint doc, falling back to the endpoint name. */
function descriptionFor(name: string, cfg: EndpointConfig): string {
  return cfg.doc?.summary ?? cfg.doc?.description ?? name;
}

/**
 * Turn a spec into MCP tool definitions — one per (included) endpoint.
 *
 * For each endpoint, `name` is the endpoint name (with {@link McpToolsOptions.namePrefix}),
 * `description` is `cfg.doc.summary ?? cfg.doc.description ?? name`, and
 * `inputSchema` is the merged JSON Schema of its path/query/body inputs (see
 * {@link inputSchemaFor}). Endpoints with no input get an empty-object schema.
 *
 * @example
 * ```ts
 * const tools = mcpTools(api, { include: (_n, c) => c.method !== 'GET', namePrefix: 'api_' });
 * ```
 */
export function mcpTools(spec: AnySpec, opts: McpToolsOptions = {}): McpTool[] {
  const prefix = opts.namePrefix ?? '';
  const tools: McpTool[] = [];
  for (const [name, ep] of Object.entries(spec.endpoints)) {
    const cfg = ep.cfg;
    if (opts.include && !opts.include(name, cfg)) {
      continue;
    }
    tools.push({
      name: prefix + name,
      description: descriptionFor(name, cfg),
      inputSchema: inputSchemaFor(cfg),
    });
  }
  return tools;
}

/* ---- server --------------------------------------------------------------- */

/** Options for {@link mcpServer}; extends the tool options with execution wiring. */
export interface McpServerOptions extends McpToolsOptions {
  /** Base URL for the internal client (default {@link DEFAULT_BASE_URL}). Requests are routed through `app.fetch`, so only its shape matters. */
  readonly baseUrl?: string;
  /** Server identity returned by `initialize` (default {@link DEFAULT_SERVER_INFO}). */
  readonly serverInfo?: { name: string; version: string };
  /** Default headers for executed calls — static or computed per request (e.g. a fresh auth token). */
  readonly headers?: Record<string, string> | (() => Record<string, string>);
}

/** A minimal MCP server over JSON-RPC 2.0, decoupled from any transport. */
export interface McpServer {
  /** The tool definitions this server exposes (same filtering/prefix as {@link mcpTools}). */
  tools(): McpTool[];
  /**
   * Handle one parsed JSON-RPC 2.0 request object and return the response
   * object. Returns `null` for notifications (requests with no `id`), which must
   * not produce a response.
   */
  handle(request: unknown): Promise<unknown>;
}

/** A well-formed JSON-RPC request, after validation. */
interface JsonRpcRequest {
  readonly jsonrpc: string;
  readonly id?: string | number | null;
  readonly method: string;
  readonly params?: unknown;
}

/** Narrow an unknown value to a JSON-RPC request shape (`jsonrpc: '2.0'` + string `method`). */
function asJsonRpcRequest(request: unknown): JsonRpcRequest | null {
  if (!request || typeof request !== 'object') {
    return null;
  }
  const r = request as Record<string, unknown>;
  if (r.jsonrpc !== JSONRPC_VERSION || typeof r.method !== 'string') {
    return null;
  }
  return r as unknown as JsonRpcRequest; // internal cast: validated shape above
}

/** Build a JSON-RPC success response. */
function ok(id: string | number | null, result: unknown): object {
  return { jsonrpc: JSONRPC_VERSION, id, result };
}

/** Build a JSON-RPC error response. */
function err(id: string | number | null, code: number, message: string): object {
  return { jsonrpc: JSONRPC_VERSION, id, error: { code, message } };
}

/** The `content`-array shape an MCP `tools/call` returns. */
interface ToolCallResult {
  readonly content: ReadonlyArray<{ type: 'text'; text: string }>;
  readonly isError?: boolean;
}

/** Wrap a JSON-serializable value as a successful MCP tool-call result. */
function textResult(text: string): ToolCallResult {
  return { content: [{ type: 'text', text }] };
}

/** Wrap a message as a failed MCP tool-call result (`isError: true`). */
function errorResult(text: string): ToolCallResult {
  return { content: [{ type: 'text', text }], isError: true };
}

/**
 * Create an MCP server that exposes a spec's endpoints as tools and executes
 * tool calls against a running app.
 *
 * Tool calls are executed through an internal {@link client} wired to
 * `app.fetch`, so a `tools/call` is a real end-to-end request against the app
 * (middleware, validation, handlers) — no network required.
 *
 * Supported JSON-RPC methods:
 * - `initialize` → `{ protocolVersion, capabilities: { tools: {} }, serverInfo }`.
 * - `tools/list` → `{ tools: McpTool[] }`.
 * - `tools/call` → executes `client.call(name, arguments)` and returns the
 *   result as `{ content: [{ type: 'text', text }] }`; a thrown error becomes a
 *   `{ content, isError: true }` result; an unknown tool is a `-32602` error.
 * - any other method → `-32601`.
 *
 * Malformed requests get `-32600`. Notifications (no `id`) return `null`.
 *
 * @example
 * ```ts
 * const mcp = mcpServer(app, api, { headers: () => ({ authorization: token() }) });
 * await mcp.handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'getUser', arguments: { id: 'u1' } } });
 * ```
 */
export function mcpServer(app: Server<AnySpec>, spec: AnySpec, opts: McpServerOptions = {}): McpServer {
  const serverInfo = opts.serverInfo ?? DEFAULT_SERVER_INFO;
  const prefix = opts.namePrefix ?? '';
  const toolList = mcpTools(spec, opts);
  // Map prefixed tool name -> underlying endpoint name, so tools/call routes to the right endpoint.
  const endpointByTool = new Map(toolList.map((t) => [t.name, t.name.slice(prefix.length)]));

  const sdk: ApiClient<AnySpec> = client<AnySpec>({
    baseUrl: opts.baseUrl ?? DEFAULT_BASE_URL,
    manifest: spec,
    fetchImpl: (req) => app.fetch(req),
    headers: opts.headers,
  });

  /** Execute one tool call and produce its MCP result (never throws). */
  async function callTool(params: unknown): Promise<ToolCallResult> {
    const p = (params ?? {}) as { name?: unknown; arguments?: unknown };
    const toolName = typeof p.name === 'string' ? p.name : '';
    const endpointName = endpointByTool.get(toolName);
    if (!endpointName) {
      return errorResult(`unknown tool "${toolName}"`);
    }
    try {
      const result = await sdk.call(endpointName, p.arguments as never);
      return textResult(JSON.stringify(result ?? null));
    } catch (e) {
      return errorResult(e instanceof Error ? e.message : String(e));
    }
  }

  async function handle(request: unknown): Promise<unknown> {
    const req = asJsonRpcRequest(request);
    if (!req) {
      return err(null, ERR_INVALID_REQUEST, 'invalid JSON-RPC request');
    }
    // Notifications carry no `id` — they must not produce a response.
    const isNotification = !('id' in (request as Record<string, unknown>));
    const id = req.id ?? null;
    switch (req.method) {
      case 'initialize': {
        if (isNotification) {
          return null;
        }
        return ok(id, { protocolVersion: PROTOCOL_VERSION, capabilities: { tools: {} }, serverInfo });
      }
      case 'tools/list': {
        if (isNotification) {
          return null;
        }
        return ok(id, { tools: toolList });
      }
      case 'tools/call': {
        const result = await callTool(req.params);
        if (isNotification) {
          return null;
        }
        return ok(id, result);
      }
      default: {
        if (isNotification) {
          return null;
        }
        return err(id, ERR_METHOD_NOT_FOUND, `method not found: ${req.method}`);
      }
    }
  }

  return { tools: () => toolList, handle };
}

/* ---- stdio transport ------------------------------------------------------ */

/** A line reader: yields one decoded line (newline-delimited) per iteration. */
export interface LineReader {
  /** Async-iterate newline-delimited JSON request lines. */
  [Symbol.asyncIterator](): AsyncIterator<string>;
}

/** A line writer: receives one serialized JSON response line per call. */
export interface LineWriter {
  /** Write one serialized response line (a trailing newline is appended by {@link serveStdio}). */
  write(line: string): void | Promise<void>;
}

/** Options for {@link serveStdio} — injected I/O so it never touches `process` directly. */
export interface ServeStdioOptions {
  /** Source of newline-delimited JSON request lines. */
  readonly input: LineReader;
  /** Sink for newline-delimited JSON response lines. */
  readonly output: LineWriter;
}

/**
 * Drive an {@link McpServer} over newline-delimited JSON from an injected
 * reader/writer. Each input line is parsed and handed to `server.handle`; each
 * non-null response is written back as one JSON line. Resolves when the input is
 * exhausted.
 *
 * Transport is fully injected (no `process.stdin`/`process.stdout`), so it can
 * be exercised with in-memory fakes. A line that fails to parse as JSON yields a
 * JSON-RPC invalid-request response so the loop never throws.
 */
export async function serveStdio(server: McpServer, opts: ServeStdioOptions): Promise<void> {
  for await (const line of opts.input) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    let request: unknown;
    try {
      request = JSON.parse(trimmed);
    } catch {
      await opts.output.write(JSON.stringify(err(null, ERR_INVALID_REQUEST, 'parse error')));
      continue;
    }
    const response = await server.handle(request);
    if (response !== null) {
      await opts.output.write(JSON.stringify(response));
    }
  }
}
