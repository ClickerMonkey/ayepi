/**
 * # `@ayepi/mcp`
 *
 * Model Context Protocol servers. Turn any ayepi {@link AnySpec | spec} into **MCP tools**: each endpoint becomes a
 * schema-validated tool whose input JSON Schema and description are derived from the endpoint's zod config, and
 * whose calls are executed against a running {@link Server | app} via the typed {@link client}. Or serve any other
 * {@link McpToolSource}, such as tools that change at runtime.
 *
 * Layers, smallest first:
 *
 * - {@link mcpTools}: pure, spec → array of {@link McpTool} definitions.
 * - {@link specToolSource}: a spec and an app as an {@link McpToolSource}.
 * - {@link mcpToolServer} / {@link mcpServer}: an {@link McpServer} that {@link McpServer.handle | handles} one
 *   JSON-RPC 2.0 message (`initialize`, `ping`, `tools/list`, `tools/call`) and sends
 *   `notifications/tools/list_changed` when its source's tools change.
 * - {@link mcpSourceServer}: a server over any tool, resource and prompt sources, such as an {@link McpToolSet}
 *   (tools defined at runtime) or views and unions over shared sources ({@link McpToolView}, {@link McpToolUnion}, …).
 * - Transports: {@link serveStdio} (newline-delimited JSON over an injected reader/writer), {@link mcpHttp}
 *   (Streamable HTTP as a web-standard `fetch` handler, optionally behind an authorizer such as {@link BearerAuth}),
 *   and {@link McpRouter} (many Streamable HTTP endpoints by path).
 * - {@link McpClient}: a typed client over HTTP, stdio, or in process ({@link McpMemoryClientTransport}).
 *
 * The protocol core does no I/O: `handle(message)` takes an already parsed object and returns a plain response
 * object (or `null` for notifications), so it is unit-testable without any transport.
 *
 * @example
 * ```ts
 * const app = server(api, [handlers]);
 * const mcp = mcpServer(app, api, { serverInfo: { name: 'my-api', version: '1.0.0' } });
 * const res = await mcp.handle({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
 * const http = mcpHttp(mcp); // serve http.fetch with any runtime adapter
 * ```
 *
 * @module
 */

import { z } from 'zod';
import { client } from '@ayepi/core';
import type { AnySpec, EndpointConfig, Server, ApiClient } from '@ayepi/core';
import { errorResult, mcpToolServer, textResult, type McpServer, type McpToolServerOptions, type McpToolSource } from './protocol';
import type { McpTool } from './shapes';

export {
  JsonRpcId, McpTool, McpToolAnnotations, McpToolResult, McpClientNotifications, McpContent, McpResource, McpResourceTemplate, McpResourcePage, McpResourceContents,
  McpTextContents, McpBlobContents, McpPrompt, McpPromptArgument, McpPromptMessage, McpPromptResult, McpImplementation,
  McpServerCapabilities, McpInitializeResult, McpResults, McpParams, McpNotifications, MCP_RESULTS, MCP_PARAMS,
  type McpMethod, type McpResultOf, type McpParamsOf, type McpNotificationMethod,
} from './shapes';
export {
  MCP_PROTOCOL_VERSIONS, JSON_RPC_ERRORS, JsonRpcRequest, JsonRpcError, JsonRpcResponseMessage, mcpSourceServer, mcpToolServer,
  isProtocolVersion, rpcError, textResult, jsonResult, errorResult, messageOf,
  type McpProtocolVersion, type JsonRpcSuccess, type JsonRpcFailure, type JsonRpcResponse, type JsonRpcNotification,
  type McpToolSource, type McpResourceSource, type McpPromptSource, type McpSources, type McpToolServerOptions,
  type McpHandleOptions, type McpNotificationListener, type McpServer, type McpAuthInfo, type McpCaller,
} from './protocol';
export { BearerAuth, bearerToken, type McpAuthorizer, type McpAuthDecision, type BearerSecret } from './auth';
export { McpRouter, type McpRouterOptions } from './router';
export {
  McpToolSet, MCP_TOOL_NAME, mcpToolName, invalidArgumentsResult,
  type McpToolContext, type McpToolRun, type McpJsonToolDefinition, type McpZodToolDefinition,
} from './toolset';
export {
  McpToolView, McpPromptView, McpResourceView, McpToolUnion, McpPromptUnion,
  type McpToolFilter, type McpPromptFilter, type McpResourceFilter,
} from './views';
export { McpMemoryClientTransport, type McpMemoryClientOptions } from './memory';
export {
  mcpHttp, MCP_SESSION_HEADER, MCP_VERSION_HEADER,
  type McpHttpOptions, type McpHttpHandler, type McpHttpSession, type McpSessionEndReason,
} from './http';
export { serveStdio, type LineReader, type LineWriter, type ServeStdioOptions } from './stdio';
export {
  McpClient, McpError, McpToolError, McpHttpClientTransport, McpStdioClientTransport,
  type McpClientTransport, type JsonRpcOutgoingRequest, type McpHttpClientOptions, type McpStdioClientOptions,
  type McpNotice, type McpConnectOptions, type McpCallOptions,
} from './client';

/** Default base URL for the internal {@link client}; only its path/query/host shape matters (requests go through `app.fetch`). */
const DEFAULT_BASE_URL = 'http://mcp.local';

/* ---- tool definitions ----------------------------------------------------- */

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

/** Options for {@link specToolSource} and {@link mcpServer}. */
export interface McpServerOptions extends McpToolsOptions, McpToolServerOptions {
  /** Base URL for the internal client (default {@link DEFAULT_BASE_URL}). Requests are routed through `app.fetch`, so only its shape matters. */
  readonly baseUrl?: string;
  /** Default headers for executed calls — static or computed per request (e.g. a fresh auth token). */
  readonly headers?: Record<string, string> | (() => Record<string, string>);
}

/**
 * A spec's endpoints as an {@link McpToolSource}, executed against a running app. Tool calls go through an internal
 * {@link client} wired to `app.fetch`, so a call is a real end-to-end request against the app (middleware,
 * validation, handlers) with no network. A call's result is its JSON text; a failed call (bad arguments, a declared
 * error) is an `isError` result with the error's message.
 */
export function specToolSource(app: Server<AnySpec>, spec: AnySpec, opts: McpServerOptions = {}): McpToolSource {
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
  return {
    tools: () => toolList,
    async call(name, args) {
      const endpointName = endpointByTool.get(name);
      if (endpointName === undefined) {
        return undefined;
      }
      try {
        const result = await sdk.call(endpointName, args as never); // internal cast: the endpoint's own schemas check the arguments
        return textResult(JSON.stringify(result ?? null));
      } catch (e) {
        return errorResult(e instanceof Error ? e.message : String(e));
      }
    },
  };
}

/**
 * An MCP server exposing a spec's endpoints as tools, executed against a running app: {@link mcpToolServer} over
 * {@link specToolSource}. See {@link mcpToolServer} for the methods it answers.
 *
 * @example
 * ```ts
 * const mcp = mcpServer(app, api, { headers: () => ({ authorization: token() }) });
 * await mcp.handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'getUser', arguments: { id: 'u1' } } });
 * ```
 */
export function mcpServer(app: Server<AnySpec>, spec: AnySpec, opts: McpServerOptions = {}): McpServer {
  return mcpToolServer(specToolSource(app, spec, opts), opts);
}
