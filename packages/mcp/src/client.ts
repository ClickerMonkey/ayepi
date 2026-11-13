/**
 * An MCP client: the `initialize` handshake, then typed calls for tools, resources and prompts, with every answer
 * checked against the result schema of its method. It talks through an {@link McpClientTransport}:
 * {@link McpHttpClientTransport} (Streamable HTTP) or {@link McpStdioClientTransport} (newline-delimited JSON over an
 * injected reader and writer, such as a child process's stdio).
 *
 * @module
 */

import { z } from 'zod';
import {
  JSON_RPC_ERRORS, JsonRpcRequest, JsonRpcResponseMessage, MCP_PROTOCOL_VERSIONS, messageOf, rpcError,
  type JsonRpcNotification, type JsonRpcResponse, type McpProtocolVersion,
} from './protocol';
import {
  JsonRpcId, MCP_RESULTS, McpClientNotifications, McpElicitRequest,
  type McpElicitResult, type McpRoot,
  type McpImplementation, type McpInitializeResult, type McpMethod, type McpParamsOf, type McpPrompt, type McpPromptResult,
  type McpResource, type McpResourceContents, type McpResourceTemplate, type McpResultOf, type McpTool, type McpToolResult,
} from './shapes';
import type { LineReader, LineWriter } from './stdio';
import { MCP_SESSION_HEADER, MCP_VERSION_HEADER } from './http';
import { readEvents } from './sse';
import { Listeners } from './listeners';

/* ---- errors --------------------------------------------------------------- */

/** A JSON-RPC error the server answered with. */
export class McpError extends Error {
  /** The JSON-RPC error code (see `JSON_RPC_ERRORS`). */
  readonly code: number;
  readonly data: unknown;

  constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.name = 'McpError';
    this.code = code;
    this.data = data;
  }
}

/** A tool answered with `isError: true`, read by {@link McpClient.callToolAs}. Its message is the result's text. */
export class McpToolError extends Error {
  /** The tool that failed. */
  readonly tool: string;
  /** What it answered. */
  readonly result: McpToolResult;

  constructor(tool: string, result: McpToolResult) {
    super(result.content.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('\n') || `tool "${tool}" failed`);
    this.name = 'McpToolError';
    this.tool = tool;
    this.result = result;
  }
}

/* ---- transports ----------------------------------------------------------- */

/** A request the client sends. */
export interface JsonRpcOutgoingRequest {
  readonly jsonrpc: '2.0';
  readonly id: number;
  readonly method: string;
  readonly params?: unknown;
}

/** How a client reaches a server. */
export interface McpClientTransport {
  /** Send a request; resolves with the server's response message, unchecked. `signal` gives up on it. */
  request(message: JsonRpcOutgoingRequest, signal: AbortSignal): Promise<unknown>;
  /** Send a notification. */
  notify(message: JsonRpcNotification): Promise<void>;
  /** Answer a request the server sent (`elicitation/create`, `roots/list`, `ping`). */
  respond(message: JsonRpcResponse): Promise<void>;
  /** Hear the messages the server sends on its own, unchecked. Returns an unsubscribe function. */
  onMessage(listener: (message: unknown) => void): () => void;
  /** The handshake agreed on this protocol version: every later message carries it. */
  opened(version: McpProtocolVersion): void;
  /** The handshake is done (`notifications/initialized` sent): start hearing the messages the server sends on its own. */
  listen(): void;
  /** Stop: end the session and fail requests still waiting. */
  close(): Promise<void>;
}

/**
 * An HTTP answer that is not MCP: the server refused the caller (`401`, `403`) or failed. `wwwAuthenticate` carries
 * the server's challenge, where an MCP server names its protected-resource metadata for OAuth (see `oauth`).
 */
export class McpHttpError extends Error {
  readonly status: number;
  /** The `WWW-Authenticate` header, when the server sent one. */
  readonly wwwAuthenticate: string | undefined;

  constructor(status: number, message: string, wwwAuthenticate: string | undefined) {
    super(message);
    this.name = 'McpHttpError';
    this.status = status;
    this.wwwAuthenticate = wwwAuthenticate;
  }
}

/** Throw an {@link McpHttpError} for a refused caller (`401`, `403`), which has no MCP answer to read. */
export async function refusedCaller(response: Response, url: string): Promise<void> {
  if (response.status !== 401 && response.status !== 403) { return; }
  await response.body?.cancel();
  throw new McpHttpError(response.status, `HTTP ${response.status} from ${url}`, response.headers.get('www-authenticate') ?? undefined);
}

/** The response with an id, if the message is one. */
export function responseId(message: unknown): number | string | null | undefined {
  const response = JsonRpcResponseMessage.safeParse(message);
  return response.success ? response.data.id : undefined;
}

/** Options for {@link McpHttpClientTransport}. */
export interface McpHttpClientOptions {
  /** The fetch to use (default the global `fetch`). */
  readonly fetch?: typeof fetch;
  /** Headers every request carries (static, or computed per request, e.g. a fresh auth token). */
  readonly headers?: Readonly<Record<string, string>> | (() => Readonly<Record<string, string>>);
  /** Open the `GET` event stream for server notifications once the handshake is done (default `true`). */
  readonly events?: boolean;
}

/**
 * The client side of MCP Streamable HTTP. Requests are `POST`ed; a response comes back as JSON or as an event stream
 * whose other messages are server notifications. The session id the server gives on `initialize` rides on every
 * later request, and so does the agreed protocol version. After the handshake a `GET` event stream carries the
 * server's own notifications (a server that answers `405` has none). `close` ends the stream and `DELETE`s the
 * session.
 */
export class McpHttpClientTransport implements McpClientTransport {
  readonly #url: string;
  readonly #fetch: typeof fetch;
  readonly #headers: McpHttpClientOptions['headers'];
  readonly #events: boolean;
  readonly #listeners = new Listeners<unknown>();
  readonly #stop = new AbortController();
  #session: string | undefined;
  #version: McpProtocolVersion | undefined;

  constructor(url: string, opts: McpHttpClientOptions = {}) {
    this.#url = url;
    this.#fetch = opts.fetch ?? globalThis.fetch.bind(globalThis);
    this.#headers = opts.headers;
    this.#events = opts.events ?? true;
  }

  /** The session the server gave, once it has. */
  get session(): string | undefined {
    return this.#session;
  }

  async request(message: JsonRpcOutgoingRequest, signal: AbortSignal): Promise<unknown> {
    const response = await this.#post(message, signal);
    await refusedCaller(response, this.#url);
    if ((response.headers.get('content-type') ?? '').includes('text/event-stream') && response.body !== null) {
      let answer: unknown;
      await readEvents(response.body, (data) => {
        if (responseId(data) === message.id) { answer = data; return true; }
        this.#listeners.emit(data);
        return false;
      });
      if (answer === undefined) { throw new Error(`the event stream ended without an answer to ${message.method}`); }
      return answer;
    }
    const text = await response.text();
    try {
      return JSON.parse(text);
    } catch {
      throw new Error(`HTTP ${response.status} from ${this.#url}: ${text.slice(0, 200)}`);
    }
  }

  async notify(message: JsonRpcNotification): Promise<void> {
    const response = await this.#post(message, this.#stop.signal);
    await response.body?.cancel();
    if (!response.ok) { throw new Error(`HTTP ${response.status} for ${message.method}`); }
  }

  async respond(message: JsonRpcResponse): Promise<void> {
    const response = await this.#post(message, this.#stop.signal);
    await response.body?.cancel();
    if (!response.ok) { throw new Error(`HTTP ${response.status} for the answer to request ${String(message.id)}`); }
  }

  onMessage(listener: (message: unknown) => void): () => void {
    return this.#listeners.add(listener);
  }

  opened(version: McpProtocolVersion): void {
    this.#version = version;
  }

  listen(): void {
    if (this.#events) { void this.#listen().catch(() => undefined); }
  }

  async close(): Promise<void> {
    this.#stop.abort();
    if (this.#session === undefined) { return; }
    const headers = this.#headersFor();
    this.#session = undefined;
    try {
      const response = await this.#fetch(this.#url, { method: 'DELETE', headers });
      await response.body?.cancel();
    } catch {
      // the server is gone already, and its session with it
    }
  }

  #headersFor(extra: Readonly<Record<string, string>> = {}): Record<string, string> {
    const base = typeof this.#headers === 'function' ? this.#headers() : this.#headers ?? {};
    return {
      ...base,
      ...extra,
      ...(this.#session === undefined ? {} : { [MCP_SESSION_HEADER]: this.#session }),
      ...(this.#version === undefined ? {} : { [MCP_VERSION_HEADER]: this.#version }),
    };
  }

  async #post(message: object, signal: AbortSignal): Promise<Response> {
    const response = await this.#fetch(this.#url, {
      method: 'POST',
      headers: this.#headersFor({ 'content-type': 'application/json', accept: 'application/json, text/event-stream' }),
      body: JSON.stringify(message),
      signal: AbortSignal.any([signal, this.#stop.signal]),
    });
    this.#session = response.headers.get(MCP_SESSION_HEADER) ?? this.#session;
    return response;
  }

  /** Read the server's notification stream until it ends or the transport closes. */
  async #listen(): Promise<void> {
    const response = await this.#fetch(this.#url, { method: 'GET', headers: this.#headersFor({ accept: 'text/event-stream' }), signal: this.#stop.signal });
    if (!response.ok || response.body === null) {
      await response.body?.cancel();
      return;
    }
    await readEvents(response.body, (data) => { this.#listeners.emit(data); return false; });
  }
}

/** Options for {@link McpStdioClientTransport}: the server's output to read and its input to write. */
export interface McpStdioClientOptions {
  /** Lines the server writes (its stdout). */
  readonly input: LineReader;
  /** Where to write lines for the server (its stdin). */
  readonly output: LineWriter;
}

/**
 * The client side of the stdio transport: one JSON message per line each way. Responses are matched to requests by
 * id; every other message the server writes is a server message. When the server's output ends, requests still
 * waiting fail.
 */
export class McpStdioClientTransport implements McpClientTransport {
  readonly #output: LineWriter;
  readonly #listeners = new Listeners<unknown>();
  readonly #waiting = new Map<number | string, { resolve: (message: unknown) => void; reject: (error: Error) => void }>();
  #ended: Error | undefined;

  constructor(opts: McpStdioClientOptions) {
    this.#output = opts.output;
    void this.#read(opts.input);
  }

  request(message: JsonRpcOutgoingRequest, signal: AbortSignal): Promise<unknown> {
    if (this.#ended !== undefined) { return Promise.reject(this.#ended); }
    return new Promise<unknown>((resolve, reject) => {
      const giveUp = (): void => {
        this.#waiting.delete(message.id);
        reject(new Error(`${message.method} was cancelled`));
      };
      signal.addEventListener('abort', giveUp, { once: true });
      this.#waiting.set(message.id, {
        resolve: (answer) => { signal.removeEventListener('abort', giveUp); resolve(answer); },
        reject: (error) => { signal.removeEventListener('abort', giveUp); reject(error); },
      });
      Promise.resolve(this.#output.write(JSON.stringify(message))).catch((error: unknown) => {
        this.#waiting.get(message.id)?.reject(new Error(messageOf(error)));
        this.#waiting.delete(message.id);
      });
    });
  }

  async notify(message: JsonRpcNotification): Promise<void> {
    await this.#output.write(JSON.stringify(message));
  }

  async respond(message: JsonRpcResponse): Promise<void> {
    await this.#output.write(JSON.stringify(message));
  }

  onMessage(listener: (message: unknown) => void): () => void {
    return this.#listeners.add(listener);
  }

  opened(): void {
    // stdio messages carry no protocol version
  }

  listen(): void {
    // the server's output is read from the start
  }

  close(): Promise<void> {
    this.#end(new Error('the client closed'));
    return Promise.resolve();
  }

  async #read(input: LineReader): Promise<void> {
    try {
      for await (const line of input) {
        const trimmed = line.trim();
        if (trimmed === '') { continue; }
        let message: unknown;
        try {
          message = JSON.parse(trimmed);
        } catch {
          continue;
        }
        const id = responseId(message);
        const waiting = id === undefined || id === null ? undefined : this.#waiting.get(id);
        if (waiting !== undefined && id !== undefined && id !== null) {
          this.#waiting.delete(id);
          waiting.resolve(message);
        } else {
          this.#listeners.emit(message);
        }
      }
      this.#end(new Error('the server closed its output'));
    } catch (error) {
      this.#end(new Error(`reading the server failed: ${messageOf(error)}`));
    }
  }

  #end(error: Error): void {
    this.#ended ??= error;
    for (const waiting of this.#waiting.values()) { waiting.reject(error); }
    this.#waiting.clear();
  }
}

/* ---- the client ----------------------------------------------------------- */

/** A notification the server sent. */
export interface McpNotice {
  readonly method: string;
  readonly params?: unknown;
}

/** Options for {@link McpClient.connect}. */
export interface McpConnectOptions {
  /** Who the client is, sent in `initialize`. */
  readonly clientInfo: McpImplementation;
  /** The protocol version to ask for (default the newest this package speaks). */
  readonly protocolVersion?: McpProtocolVersion;
  /** Gives up on the handshake. */
  readonly signal?: AbortSignal;
  /** How the client answers the requests a server sends it; the capabilities it advertises follow from these. */
  readonly handlers?: McpClientHandlers;
}

/**
 * How a client answers the requests a server sends it. `ping` is always answered. A server request the client has
 * no handler for (and `sampling/createMessage`, which this client never offers) gets `-32601`. A handler that throws
 * answers `-32603` with its message. `signal` aborts when the server cancels its request.
 */
export interface McpClientHandlers {
  /** `elicitation/create`: ask the person to fill a form (advertises the `elicitation` capability). */
  readonly elicit?: (request: McpElicitRequest, signal: AbortSignal) => Promise<McpElicitResult>;
  /** `roots/list`: the folders the server may work in (advertises `roots`, with `listChanged`). */
  readonly roots?: (signal: AbortSignal) => Promise<readonly McpRoot[]>;
}

/** The capabilities a client with these handlers advertises in `initialize`. */
function clientCapabilities(handlers: McpClientHandlers): Record<string, object> {
  return {
    ...(handlers.elicit === undefined ? {} : { elicitation: {} }),
    ...(handlers.roots === undefined ? {} : { roots: { listChanged: true } }),
  };
}

/** A request the server sent: a JSON-RPC request with a method and an id. */
const ServerRequest = z.object({ jsonrpc: z.literal('2.0'), id: JsonRpcId, method: z.string(), params: z.unknown().optional() });

/**
 * Answer the server's requests through `handlers` until the returned function is called. Requests in flight are
 * aborted when the server cancels them (`notifications/cancelled`) and when answering stops.
 */
function answerServer(transport: McpClientTransport, handlers: McpClientHandlers): () => void {
  const inFlight = new Map<string | number, AbortController>();
  const answer = async (id: string | number, method: string, params: unknown, signal: AbortSignal): Promise<JsonRpcResponse> => {
    if (method === 'ping') { return { jsonrpc: '2.0', id, result: {} }; }
    if (method === 'elicitation/create' && handlers.elicit !== undefined) {
      const request = McpElicitRequest.safeParse(params);
      if (!request.success) { return rpcError(id, JSON_RPC_ERRORS.invalidParams, `invalid elicitation: ${z.prettifyError(request.error)}`); }
      return { jsonrpc: '2.0', id, result: await handlers.elicit(request.data, signal) };
    }
    if (method === 'roots/list' && handlers.roots !== undefined) {
      return { jsonrpc: '2.0', id, result: { roots: [...await handlers.roots(signal)] } };
    }
    return rpcError(id, JSON_RPC_ERRORS.methodNotFound, `this client does not answer ${method}`);
  };
  const stop = transport.onMessage((message) => {
    const cancelled = JsonRpcRequest.safeParse(message);
    if (cancelled.success && cancelled.data.method === 'notifications/cancelled') {
      const params = McpClientNotifications['notifications/cancelled'].safeParse(cancelled.data.params);
      if (params.success) { inFlight.get(params.data.requestId)?.abort(params.data.reason); }
      return;
    }
    const request = ServerRequest.safeParse(message);
    if (!request.success) { return; }
    const { id, method, params } = request.data;
    const control = new AbortController();
    inFlight.set(id, control);
    void answer(id, method, params, control.signal)
      .catch((error: unknown) => rpcError(id, JSON_RPC_ERRORS.internal, messageOf(error)))
      .then(async (response) => {
        inFlight.delete(id);
        if (!control.signal.aborted) { await transport.respond(response); }
      })
      .catch(() => undefined);
  });
  return () => {
    stop();
    for (const control of inFlight.values()) { control.abort('the client closed'); }
    inFlight.clear();
  };
}

/** Options for one call. */
export interface McpCallOptions {
  /** Cancels the call: the server is sent `notifications/cancelled`. */
  readonly signal?: AbortSignal;
}

/** A page of items, and the cursor of the next one. */
interface Page<T> {
  readonly items: readonly T[];
  readonly nextCursor?: string | undefined;
}

/** A list method's params for a page. */
function pageParams(cursor: string | undefined): { cursor?: string } {
  return cursor === undefined ? {} : { cursor };
}

/** Whether the version a server answered with is one this package speaks. */
const SpokenVersion = z.enum(MCP_PROTOCOL_VERSIONS);

/**
 * A connected MCP client. {@link McpClient.connect} does the handshake (`initialize`, then
 * `notifications/initialized`); the methods then call the server, checking each answer against its method's result
 * schema. A JSON-RPC error answer throws an {@link McpError}.
 *
 * @example
 * ```ts
 * const client = await McpClient.connect(new McpHttpClientTransport('http://127.0.0.1:4400/'), { clientInfo: { name: 'me', version: '1' } });
 * const tools = await client.listTools();
 * const result = await client.callTool('add', { a: 1, b: 2 });
 * await client.close();
 * ```
 */
export class McpClient {
  /** What the server answered `initialize` with: its version, capabilities, identity and instructions. */
  readonly server: McpInitializeResult;
  readonly #transport: McpClientTransport;
  /** Stops answering the server's requests. */
  readonly #stopAnswering: () => void;
  /** The next request id (`0` was the handshake's). */
  #nextId = 1;

  private constructor(transport: McpClientTransport, server: McpInitializeResult, stopAnswering: () => void) {
    this.#transport = transport;
    this.server = server;
    this.#stopAnswering = stopAnswering;
  }

  /**
   * Connect over a transport: the handshake, refusing a server that answers with a version this package doesn't
   * speak. From then on the server's own requests are answered through `opts.handlers`.
   */
  static async connect(transport: McpClientTransport, opts: McpConnectOptions): Promise<McpClient> {
    const asked = opts.protocolVersion ?? MCP_PROTOCOL_VERSIONS[0];
    const handlers = opts.handlers ?? {};
    const server = await call(transport, 0, 'initialize', { protocolVersion: asked, capabilities: clientCapabilities(handlers), clientInfo: opts.clientInfo }, opts.signal);
    const version = SpokenVersion.safeParse(server.protocolVersion);
    if (!version.success) {
      await transport.close();
      throw new Error(`the server speaks MCP ${server.protocolVersion}, which this client doesn't`);
    }
    transport.opened(version.data);
    // answer before `initialized`: a server may ask for the roots as soon as it hears it
    const stopAnswering = answerServer(transport, handlers);
    await transport.notify({ jsonrpc: '2.0', method: 'notifications/initialized' });
    transport.listen();
    return new McpClient(transport, server, stopAnswering);
  }

  /** Tell the server the roots changed (`notifications/roots/list_changed`); it asks for them again. */
  async rootsChanged(): Promise<void> {
    await this.#transport.notify({ jsonrpc: '2.0', method: 'notifications/roots/list_changed' });
  }

  /** Call any request method this package speaks, with its params and result checked by type. */
  request<M extends McpMethod>(method: M, params: McpParamsOf<M>, opts: McpCallOptions = {}): Promise<McpResultOf<M>> {
    return call(this.#transport, this.#nextId++, method, params, opts.signal);
  }

  /** Check the server is there. */
  async ping(opts?: McpCallOptions): Promise<void> {
    await this.request('ping', {}, opts);
  }

  /** Every tool, across pages. */
  listTools(opts?: McpCallOptions): Promise<McpTool[]> {
    return this.#all(async (cursor) => { const page = await this.request('tools/list', pageParams(cursor), opts); return { items: page.tools, nextCursor: page.nextCursor }; });
  }

  /** Call a tool. A tool that failed answers with `isError: true`, not a throw. */
  callTool(name: string, args: Readonly<Record<string, unknown>> = {}, opts?: McpCallOptions): Promise<McpToolResult> {
    return this.request('tools/call', { name, arguments: { ...args } }, opts);
  }

  /**
   * Call a tool and read its value: its `structuredContent` when it has one, else the JSON of its first text block,
   * checked against `schema`. A tool that failed throws an {@link McpToolError}; a value that isn't JSON or doesn't fit
   * the schema throws an `Error` naming the tool.
   */
  async callToolAs<S extends z.ZodType>(name: string, args: Readonly<Record<string, unknown>>, schema: S, opts?: McpCallOptions): Promise<z.output<S>> {
    const result = await this.callTool(name, args, opts);
    if (result.isError === true) { throw new McpToolError(name, result); }
    const parsed = schema.safeParse(result.structuredContent ?? McpClient.#textJson(name, result));
    if (!parsed.success) { throw new Error(`the result of tool "${name}" doesn't fit: ${z.prettifyError(parsed.error)}`); }
    return parsed.data;
  }

  /**
   * The next notification with a method: resolves when the server sends one. `signal` gives up waiting (the promise
   * rejects with its reason).
   */
  nextNotification(method: string, opts: McpCallOptions = {}): Promise<McpNotice> {
    return new Promise<McpNotice>((resolve, reject) => {
      const signal = opts.signal;
      const giveUp = (): void => {
        stop();
        reject(new Error(`stopped waiting for ${method}`));
      };
      const stop = this.onNotification((notice) => {
        if (notice.method !== method) { return; }
        stop();
        signal?.removeEventListener('abort', giveUp);
        resolve(notice);
      });
      if (signal?.aborted === true) { giveUp(); }
      signal?.addEventListener('abort', giveUp, { once: true });
    });
  }

  /** The JSON of a result's first text block. */
  static #textJson(name: string, result: McpToolResult): unknown {
    const text = result.content.find((block) => block.type === 'text');
    if (text === undefined) { throw new Error(`the result of tool "${name}" has no text`); }
    try {
      return JSON.parse(text.text);
    } catch {
      throw new Error(`the result of tool "${name}" is not JSON: ${text.text.slice(0, 200)}`);
    }
  }

  /** Every listed resource, across pages. */
  listResources(opts?: McpCallOptions): Promise<McpResource[]> {
    return this.#all(async (cursor) => { const page = await this.request('resources/list', pageParams(cursor), opts); return { items: page.resources, nextCursor: page.nextCursor }; });
  }

  /** Every resource template, across pages. */
  listResourceTemplates(opts?: McpCallOptions): Promise<McpResourceTemplate[]> {
    return this.#all(async (cursor) => {
      const page = await this.request('resources/templates/list', pageParams(cursor), opts);
      return { items: page.resourceTemplates, nextCursor: page.nextCursor };
    });
  }

  /** Read a resource's contents. */
  async readResource(uri: string, opts?: McpCallOptions): Promise<McpResourceContents[]> {
    return (await this.request('resources/read', { uri }, opts)).contents;
  }

  /** Hear `notifications/resources/updated` for a URI. */
  async subscribe(uri: string, opts?: McpCallOptions): Promise<void> {
    await this.request('resources/subscribe', { uri }, opts);
  }

  /** Stop hearing about a URI. */
  async unsubscribe(uri: string, opts?: McpCallOptions): Promise<void> {
    await this.request('resources/unsubscribe', { uri }, opts);
  }

  /** Every prompt, across pages. */
  listPrompts(opts?: McpCallOptions): Promise<McpPrompt[]> {
    return this.#all(async (cursor) => { const page = await this.request('prompts/list', pageParams(cursor), opts); return { items: page.prompts, nextCursor: page.nextCursor }; });
  }

  /** Fill a prompt with its arguments. */
  getPrompt(name: string, args: Readonly<Record<string, string>> = {}, opts?: McpCallOptions): Promise<McpPromptResult> {
    return this.request('prompts/get', { name, arguments: { ...args } }, opts);
  }

  /** Hear the server's notifications (`notifications/tools/list_changed`, `notifications/resources/updated`, …). */
  onNotification(listener: (notice: McpNotice) => void): () => void {
    return this.#transport.onMessage((message) => {
      const notice = JsonRpcRequest.safeParse(message);
      if (notice.success && notice.data.id === undefined) {
        listener({ method: notice.data.method, ...(notice.data.params === undefined ? {} : { params: notice.data.params }) });
      }
    });
  }

  /** End the session. */
  close(): Promise<void> {
    this.#stopAnswering();
    return this.#transport.close();
  }

  /** Every item of a list, following `nextCursor` until the last page (or a cursor seen before). */
  async #all<T>(page: (cursor: string | undefined) => Promise<Page<T>>): Promise<T[]> {
    const items: T[] = [];
    const seen = new Set<string>();
    let cursor: string | undefined;
    do {
      if (cursor !== undefined) { seen.add(cursor); }
      const got = await page(cursor);
      items.push(...got.items);
      cursor = got.nextCursor;
    } while (cursor !== undefined && !seen.has(cursor));
    return items;
  }
}

/** Send one request and check its answer against the method's result schema. */
async function call<M extends McpMethod>(transport: McpClientTransport, id: number, method: M, params: McpParamsOf<M>, signal: AbortSignal | undefined): Promise<McpResultOf<M>> {
  const message: JsonRpcOutgoingRequest = { jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) };
  const own = signal ?? new AbortController().signal;
  const cancel = (): void => {
    transport.notify({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: id, reason: messageOf(own.reason) } }).catch(() => undefined);
  };
  own.addEventListener('abort', cancel, { once: true });
  try {
    const answer = JsonRpcResponseMessage.safeParse(await transport.request(message, own));
    if (!answer.success) { throw new Error(`the server's answer to ${method} is not a JSON-RPC response`); }
    const { error, result } = answer.data;
    if (error !== undefined) { throw new McpError(error.code, error.message, error.data); }
    const checked = MCP_RESULTS[method].safeParse(result);
    if (!checked.success) { throw new Error(`the server's answer to ${method} doesn't fit MCP: ${z.prettifyError(checked.error)}`); }
    return checked.data;
  } finally {
    own.removeEventListener('abort', cancel);
  }
}
