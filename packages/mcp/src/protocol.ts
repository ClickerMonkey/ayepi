/**
 * The MCP protocol core: JSON-RPC 2.0 messages, the `initialize` handshake with version negotiation, `ping`, tools
 * (`tools/list`, `tools/call`), resources (`resources/list`, `resources/templates/list`, `resources/read`,
 * `resources/subscribe`, `resources/unsubscribe`), prompts (`prompts/list`, `prompts/get`), and the server's
 * notifications (`notifications/{tools,resources,prompts}/list_changed`, `notifications/resources/updated`) — over
 * any {@link McpSources}. No I/O: a transport hands {@link McpServer.handle} one parsed message and writes back what
 * it returns, and forwards {@link McpServer.onNotification} messages.
 *
 * @module
 */

import { z } from 'zod';
import {
  JsonRpcId, MCP_PARAMS,
  type McpMethod, type McpNotificationMethod, type McpParamsOf, type McpPrompt, type McpPromptResult, type McpResourceContents,
  type McpResourcePage, type McpResourceTemplate, type McpResultOf, type McpServerCapabilities, type McpTool, type McpToolResult,
} from './shapes';

/* ---- protocol constants ---------------------------------------------------- */

/** The MCP protocol versions this package speaks, newest first. The first is offered when the other side asks for another. */
export const MCP_PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'] as const;
/** A protocol version this package speaks. */
export type McpProtocolVersion = (typeof MCP_PROTOCOL_VERSIONS)[number];

/** JSON-RPC error codes this server answers with. */
export const JSON_RPC_ERRORS = {
  /** The text was not JSON. */
  parse: -32700,
  /** The JSON is not a valid JSON-RPC request. */
  invalidRequest: -32600,
  /** No such method, or a capability the server doesn't offer. */
  methodNotFound: -32601,
  /** The params don't fit the method (an unknown tool or prompt, missing fields or arguments). */
  invalidParams: -32602,
  /** The server failed while answering. */
  internal: -32603,
  /** No resource at the URI asked for. */
  resourceNotFound: -32002,
} as const;

/** Default server identity reported by `initialize` when the caller supplies none. */
const DEFAULT_SERVER_INFO = { name: 'ayepi-mcp', version: '0.0.0' } as const;

/** The session key of a transport with a single session (stdio, or a caller that passes none). */
const SOLE_SESSION = '';

/* ---- messages -------------------------------------------------------------- */

/** A JSON-RPC request or notification (a notification has no `id`). */
export const JsonRpcRequest = z.object({
  jsonrpc: z.literal('2.0'),
  id: z.union([JsonRpcId, z.null()]).optional(),
  method: z.string(),
  params: z.unknown().optional(),
});
export type JsonRpcRequest = z.infer<typeof JsonRpcRequest>;

/** A JSON-RPC error object. */
export const JsonRpcError = z.object({ code: z.number(), message: z.string(), data: z.unknown().optional() });
export type JsonRpcError = z.infer<typeof JsonRpcError>;

/** A JSON-RPC response: a result or an error for the request with its `id`. */
export const JsonRpcResponseMessage = z.object({
  jsonrpc: z.literal('2.0'),
  id: z.union([JsonRpcId, z.null()]),
  result: z.unknown().optional(),
  error: JsonRpcError.optional(),
}).refine((message) => message.result !== undefined || message.error !== undefined, 'a response has a result or an error');
export type JsonRpcResponseMessage = z.infer<typeof JsonRpcResponseMessage>;

/** What a server sends: a success, an error, or a notification. */
export type JsonRpcSuccess = { readonly jsonrpc: '2.0'; readonly id: JsonRpcId | null; readonly result: unknown };
export type JsonRpcFailure = { readonly jsonrpc: '2.0'; readonly id: JsonRpcId | null; readonly error: { readonly code: number; readonly message: string } };
export type JsonRpcResponse = JsonRpcSuccess | JsonRpcFailure;
export type JsonRpcNotification = { readonly jsonrpc: '2.0'; readonly method: string; readonly params?: unknown };

/** A JSON-RPC error response. */
export function rpcError(id: JsonRpcId | null, code: number, message: string): JsonRpcFailure {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

/** A notification message. */
function notification(method: McpNotificationMethod, params?: object): JsonRpcNotification {
  return { jsonrpc: '2.0', method, ...(params === undefined ? {} : { params }) };
}

/* ---- results ---------------------------------------------------------------- */

/** A successful tool result carrying text. */
export function textResult(text: string): McpToolResult {
  return { content: [{ type: 'text', text }] };
}

/** A failed tool result (`isError: true`) carrying the message the model reads. */
export function errorResult(text: string): McpToolResult {
  return { content: [{ type: 'text', text }], isError: true };
}

/* ---- sources ---------------------------------------------------------------- */

/**
 * Where an MCP server's tools come from. `specToolSource` is one over an ayepi spec; any other source (tools that
 * change at runtime, tools from another registry) implements this.
 */
export interface McpToolSource {
  /** The tools offered now. */
  tools(): readonly McpTool[];
  /**
   * Run a tool. `undefined` means there is no such tool (a `-32602` error to the client); a thrown error becomes an
   * `isError` result.
   */
  call(name: string, args: Readonly<Record<string, unknown>>, signal: AbortSignal): Promise<McpToolResult | undefined>;
  /**
   * Hear about the tool list changing. A source that has this advertises `tools.listChanged` and the server sends
   * `notifications/tools/list_changed` each time. Returns an unsubscribe function.
   */
  onChange?(listener: () => void): () => void;
}

/** Where an MCP server's resources come from. */
export interface McpResourceSource {
  /** A page of the resources offered; `cursor` is a page's `nextCursor`. */
  list(cursor: string | undefined, signal: AbortSignal): Promise<McpResourcePage>;
  /** The URI templates a client can fill to read resources that aren't listed. None when absent. */
  templates?(signal: AbortSignal): readonly McpResourceTemplate[] | Promise<readonly McpResourceTemplate[]>;
  /** Read a resource. `undefined` means there is none at the URI (a `-32002` error to the client). */
  read(uri: string, signal: AbortSignal): Promise<readonly McpResourceContents[] | undefined>;
  /**
   * Hear about one resource changing until the returned function is called. A source that has this advertises
   * `resources.subscribe`: a client that subscribes to a URI gets `notifications/resources/updated` for it.
   */
  watch?(uri: string, onUpdate: () => void): () => void;
  /** Hear about the resource list changing (advertises `resources.listChanged`). Returns an unsubscribe function. */
  onChange?(listener: () => void): () => void;
}

/** Where an MCP server's prompts come from. */
export interface McpPromptSource {
  /** The prompts offered now. */
  prompts(): readonly McpPrompt[];
  /**
   * Fill a prompt. `undefined` means there is no such prompt (a `-32602` error). The server checks the prompt's
   * required arguments are present before calling this.
   */
  get(name: string, args: Readonly<Record<string, string>>, signal: AbortSignal): Promise<McpPromptResult | undefined>;
  /** Hear about the prompt list changing (advertises `prompts.listChanged`). Returns an unsubscribe function. */
  onChange?(listener: () => void): () => void;
}

/** What an MCP server offers. A capability is advertised only when its source is given. */
export interface McpSources {
  readonly tools?: McpToolSource;
  readonly resources?: McpResourceSource;
  readonly prompts?: McpPromptSource;
}

/* ---- the server ------------------------------------------------------------ */

/** Options for {@link mcpSourceServer} and {@link mcpToolServer}. */
export interface McpToolServerOptions {
  /** Server identity returned by `initialize` (default `{ name: 'ayepi-mcp', version: '0.0.0' }`). */
  readonly serverInfo?: { readonly name: string; readonly version: string };
  /** Guidance for the client's model, returned by `initialize`. */
  readonly instructions?: string;
}

/** What {@link McpServer.handle} takes besides the message. */
export interface McpHandleOptions {
  /** Aborts a call in progress (the transport's request went away). */
  readonly signal?: AbortSignal;
  /** The client session the message came in on; resource subscriptions belong to it. Default: the sole session. */
  readonly session?: string;
}

/** Hears a server notification; `session` is the one session it is for, or `undefined` for every session. */
export type McpNotificationListener = (message: JsonRpcNotification, session: string | undefined) => void;

/** An MCP server over JSON-RPC 2.0, decoupled from any transport. */
export interface McpServer {
  /** The tool definitions this server exposes now (none without a tool source). */
  tools(): readonly McpTool[];
  /**
   * Handle one parsed JSON-RPC message and return the response, or `null` for a notification or a client's response
   * (neither is answered).
   */
  handle(message: unknown, options?: McpHandleOptions): Promise<JsonRpcResponse | null>;
  /** Hear the notifications the server sends on its own. */
  onNotification(listener: McpNotificationListener): () => void;
  /** End a client session: drop its resource subscriptions. Default: the sole session. */
  endSession(session?: string): void;
  /** Stop listening to the sources and drop every subscription. */
  close(): void;
}

/** Whether a string is a protocol version this package speaks. */
export function isProtocolVersion(version: string): version is McpProtocolVersion {
  return MCP_PROTOCOL_VERSIONS.some((known) => known === version);
}

/** The message of anything thrown. */
export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** A JSON-RPC error a request handler answers with: thrown, and sent back with its code. */
class McpFault extends Error {
  readonly code: number;

  constructor(code: number, message: string) {
    super(message);
    this.code = code;
  }
}

/** What a request handler gets. */
interface Call<M extends McpMethod> {
  readonly params: McpParamsOf<M>;
  readonly signal: AbortSignal;
  readonly session: string;
}

/** The server's answer to every request method. */
type Handlers = { readonly [M in McpMethod]: (call: Call<M>) => McpResultOf<M> | Promise<McpResultOf<M>> };

/** The source a method needs, or the fault of a capability the server doesn't have. */
function offered<T>(source: T | undefined, method: McpMethod): T {
  if (source === undefined) { throw new McpFault(JSON_RPC_ERRORS.methodNotFound, `method not found: ${method}`); }
  return source;
}

/** The required arguments a prompt call leaves out. */
function missingArguments(prompt: McpPrompt, args: Readonly<Record<string, string>>): string[] {
  return (prompt.arguments ?? []).filter((arg) => arg.required === true && args[arg.name] === undefined).map((arg) => arg.name);
}


/**
 * An MCP server over {@link McpSources}.
 *
 * - `initialize` → `{ protocolVersion, capabilities, serverInfo, instructions? }`; the version is the client's when
 *   this server speaks it, else the newest it does. `capabilities` names each source given: `tools: { listChanged }`,
 *   `resources: { subscribe, listChanged }`, `prompts: { listChanged }`.
 * - `ping` → `{}`.
 * - `tools/*`, `resources/*`, `prompts/*` → the source's answer. A method for a source not given is `-32601`; bad
 *   params, an unknown tool or prompt, or a prompt call missing a required argument is `-32602`; a resource that
 *   isn't there is `-32002`; a tool that throws is an `isError` result; any other failure is `-32603`.
 * - any other request → `-32601`. A message that is not JSON-RPC → `-32600`.
 *
 * Notifications (`notifications/initialized`, `notifications/cancelled`, …) and client responses get no answer.
 */
export function mcpSourceServer(sources: McpSources, opts: McpToolServerOptions = {}): McpServer {
  const serverInfo = opts.serverInfo ?? DEFAULT_SERVER_INFO;
  const listeners = new Set<McpNotificationListener>();
  /** Each session's subscriptions: URI → stop watching. */
  const subscriptions = new Map<string, Map<string, () => void>>();
  const send = (message: JsonRpcNotification, session?: string): void => {
    for (const listener of [...listeners]) { listener(message, session); }
  };
  const stops = [
    sources.tools?.onChange?.(() => { send(notification('notifications/tools/list_changed')); }),
    sources.resources?.onChange?.(() => { send(notification('notifications/resources/list_changed')); }),
    sources.prompts?.onChange?.(() => { send(notification('notifications/prompts/list_changed')); }),
  ];
  const [toolsChange, resourcesChange, promptsChange] = stops;

  const capabilities: McpServerCapabilities = {
    ...(sources.tools === undefined ? {} : { tools: { listChanged: toolsChange !== undefined } }),
    ...(sources.resources === undefined ? {} : { resources: { subscribe: sources.resources.watch !== undefined, listChanged: resourcesChange !== undefined } }),
    ...(sources.prompts === undefined ? {} : { prompts: { listChanged: promptsChange !== undefined } }),
  };

  const negotiate = (requested: string): McpProtocolVersion => (isProtocolVersion(requested) ? requested : MCP_PROTOCOL_VERSIONS[0]);

  function endSession(session: string = SOLE_SESSION): void {
    const held = subscriptions.get(session);
    subscriptions.delete(session);
    for (const stop of held?.values() ?? []) { stop(); }
  }

  /** The watch a subscription needs: resources that can be watched, or the fault of a server that can't. */
  function watcher(method: McpMethod): (uri: string, onUpdate: () => void) => () => void {
    const resources = offered(sources.resources, method);
    const watch = offered(resources.watch, method);
    return (uri, onUpdate) => watch.call(resources, uri, onUpdate);
  }

  const handlers: Handlers = {
    'initialize': ({ params }) => ({
      protocolVersion: negotiate(params.protocolVersion),
      capabilities,
      serverInfo,
      ...(opts.instructions === undefined ? {} : { instructions: opts.instructions }),
    }),
    'ping': () => ({}),
    'tools/list': () => ({ tools: [...offered(sources.tools, 'tools/list').tools()] }),
    'tools/call': async ({ params, signal }) => {
      const tools = offered(sources.tools, 'tools/call');
      let result: McpToolResult | undefined;
      try {
        result = await tools.call(params.name, params.arguments ?? {}, signal);
      } catch (error) {
        result = errorResult(messageOf(error));
      }
      if (result === undefined) { throw new McpFault(JSON_RPC_ERRORS.invalidParams, `unknown tool "${params.name}"`); }
      return result;
    },
    'resources/list': ({ params, signal }) => offered(sources.resources, 'resources/list').list(params?.cursor, signal),
    'resources/templates/list': async ({ signal }) => ({ resourceTemplates: [...await offered(sources.resources, 'resources/templates/list').templates?.(signal) ?? []] }),
    'resources/read': async ({ params, signal }) => {
      const contents = await offered(sources.resources, 'resources/read').read(params.uri, signal);
      if (contents === undefined) { throw new McpFault(JSON_RPC_ERRORS.resourceNotFound, `resource not found: ${params.uri}`); }
      return { contents: [...contents] };
    },
    'resources/subscribe': ({ params, session }) => {
      const watch = watcher('resources/subscribe');
      const held = subscriptions.get(session) ?? new Map<string, () => void>();
      subscriptions.set(session, held);
      if (!held.has(params.uri)) {
        held.set(params.uri, watch(params.uri, () => { send(notification('notifications/resources/updated', { uri: params.uri }), session); }));
      }
      return {};
    },
    'resources/unsubscribe': ({ params, session }) => {
      watcher('resources/unsubscribe');
      const held = subscriptions.get(session);
      held?.get(params.uri)?.();
      held?.delete(params.uri);
      return {};
    },
    'prompts/list': () => ({ prompts: [...offered(sources.prompts, 'prompts/list').prompts()] }),
    'prompts/get': async ({ params, signal }) => {
      const prompts = offered(sources.prompts, 'prompts/get');
      const args = params.arguments ?? {};
      const unknown = new McpFault(JSON_RPC_ERRORS.invalidParams, `unknown prompt "${params.name}"`);
      const prompt = prompts.prompts().find((p) => p.name === params.name);
      if (prompt === undefined) { throw unknown; }
      const missing = missingArguments(prompt, args);
      if (missing.length > 0) { throw new McpFault(JSON_RPC_ERRORS.invalidParams, `prompt "${params.name}" needs ${missing.join(', ')}`); }
      const result = await prompts.get(params.name, args, signal);
      if (result === undefined) { throw unknown; }
      return result;
    },
  };

  /** Run one method's handler with its params checked against the method's schema. */
  async function dispatch<M extends McpMethod>(method: M, raw: unknown, signal: AbortSignal, session: string): Promise<McpResultOf<M>> {
    const params = MCP_PARAMS[method].safeParse(raw);
    if (!params.success) { throw new McpFault(JSON_RPC_ERRORS.invalidParams, `bad params for ${method}: ${z.prettifyError(params.error)}`); }
    const handler: (call: Call<M>) => McpResultOf<M> | Promise<McpResultOf<M>> = handlers[method];
    return handler({ params: params.data, signal, session });
  }

  const isMethod = (method: string): method is McpMethod => Object.hasOwn(MCP_PARAMS, method);

  async function handle(message: unknown, options: McpHandleOptions = {}): Promise<JsonRpcResponse | null> {
    const request = JsonRpcRequest.safeParse(message);
    if (!request.success) {
      return JsonRpcResponseMessage.safeParse(message).success ? null : rpcError(null, JSON_RPC_ERRORS.invalidRequest, 'invalid JSON-RPC request');
    }
    const { id, method, params } = request.data;
    if (id === undefined) { return null; }
    if (!isMethod(method)) { return rpcError(id, JSON_RPC_ERRORS.methodNotFound, `method not found: ${method}`); }
    try {
      const result: unknown = await dispatch(method, params, options.signal ?? new AbortController().signal, options.session ?? SOLE_SESSION);
      return { jsonrpc: '2.0', id, result };
    } catch (error) {
      return rpcError(id, error instanceof McpFault ? error.code : JSON_RPC_ERRORS.internal, messageOf(error));
    }
  }

  return {
    tools: () => sources.tools?.tools() ?? [],
    handle,
    onNotification(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    endSession,
    close() {
      listeners.clear();
      for (const stop of stops) { stop?.(); }
      for (const session of [...subscriptions.keys()]) { endSession(session); }
    },
  };
}

/** An MCP server offering tools only: {@link mcpSourceServer} with just a tool source. */
export function mcpToolServer(source: McpToolSource, opts: McpToolServerOptions = {}): McpServer {
  return mcpSourceServer({ tools: source }, opts);
}
