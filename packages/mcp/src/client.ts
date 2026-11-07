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
  JsonRpcRequest, JsonRpcResponseMessage, MCP_PROTOCOL_VERSIONS, messageOf,
  type JsonRpcNotification, type McpProtocolVersion,
} from './protocol';
import {
  MCP_RESULTS,
  type McpImplementation, type McpInitializeResult, type McpMethod, type McpParamsOf, type McpPrompt, type McpPromptResult,
  type McpResource, type McpResourceContents, type McpResourceTemplate, type McpResultOf, type McpTool, type McpToolResult,
} from './shapes';
import type { LineReader, LineWriter } from './stdio';
import { MCP_SESSION_HEADER, MCP_VERSION_HEADER } from './http';
import { readEvents } from './sse';

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
  /** Hear the messages the server sends on its own, unchecked. Returns an unsubscribe function. */
  onMessage(listener: (message: unknown) => void): () => void;
  /** The handshake agreed on this protocol version: every later message carries it. */
  opened(version: McpProtocolVersion): void;
  /** The handshake is done (`notifications/initialized` sent): start hearing the messages the server sends on its own. */
  listen(): void;
  /** Stop: end the session and fail requests still waiting. */
  close(): Promise<void>;
}

/** The listeners of server messages, shared by the transports. */
class Listeners {
  readonly #listeners = new Set<(message: unknown) => void>();

  add(listener: (message: unknown) => void): () => void {
    this.#listeners.add(listener);
    return () => { this.#listeners.delete(listener); };
  }

  emit(message: unknown): void {
    for (const listener of [...this.#listeners]) { listener(message); }
  }
}

/** The response with an id, if the message is one. */
function responseId(message: unknown): number | string | null | undefined {
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
  readonly #listeners = new Listeners();
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
  readonly #listeners = new Listeners();
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
  /** The next request id (`0` was the handshake's). */
  #nextId = 1;

  private constructor(transport: McpClientTransport, server: McpInitializeResult) {
    this.#transport = transport;
    this.server = server;
  }

  /** Connect over a transport: the handshake, refusing a server that answers with a version this package doesn't speak. */
  static async connect(transport: McpClientTransport, opts: McpConnectOptions): Promise<McpClient> {
    const asked = opts.protocolVersion ?? MCP_PROTOCOL_VERSIONS[0];
    const server = await call(transport, 0, 'initialize', { protocolVersion: asked, capabilities: {}, clientInfo: opts.clientInfo }, opts.signal);
    const version = SpokenVersion.safeParse(server.protocolVersion);
    if (!version.success) {
      await transport.close();
      throw new Error(`the server speaks MCP ${server.protocolVersion}, which this client doesn't`);
    }
    transport.opened(version.data);
    await transport.notify({ jsonrpc: '2.0', method: 'notifications/initialized' });
    transport.listen();
    return new McpClient(transport, server);
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
