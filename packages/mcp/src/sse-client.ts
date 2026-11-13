/**
 * The client side of the HTTP + SSE transport of MCP 2024-11-05, for servers that predate Streamable HTTP: a `GET`
 * event stream that first names the endpoint to `POST` messages to (an `endpoint` event), then carries every message
 * the server sends (`message` events), answers included.
 *
 * @module
 */

import { refusedCaller, responseId, type JsonRpcOutgoingRequest, type McpClientTransport } from './client';
import { Listeners } from './listeners';
import { messageOf, type JsonRpcNotification, type JsonRpcResponse } from './protocol';
import { readEventStream } from './sse';

/** Options for {@link McpSseClientTransport}. */
export interface McpSseClientOptions {
  /** The fetch to use (default the global `fetch`). */
  readonly fetch?: typeof fetch;
  /** Headers every request carries (static, or computed per request, e.g. a fresh auth token). */
  readonly headers?: Readonly<Record<string, string>> | (() => Readonly<Record<string, string>>);
}

/**
 * The HTTP + SSE client transport. The event stream opens with the first message sent; the endpoint it names must be
 * on the stream's own origin. Answers are matched to requests by id; every other message on the stream is a server
 * message. When the stream ends, requests still waiting fail. A refused caller (`401`, `403`) throws an
 * `McpHttpError` carrying the server's `WWW-Authenticate` challenge.
 */
export class McpSseClientTransport implements McpClientTransport {
  readonly #url: string;
  readonly #fetch: typeof fetch;
  readonly #headers: McpSseClientOptions['headers'];
  readonly #listeners = new Listeners<unknown>();
  readonly #stop = new AbortController();
  readonly #waiting = new Map<number | string, { resolve: (message: unknown) => void; reject: (error: Error) => void }>();
  #endpoint: Promise<string> | undefined;
  #ended: Error | undefined;

  constructor(url: string, opts: McpSseClientOptions = {}) {
    this.#url = url;
    this.#fetch = opts.fetch ?? globalThis.fetch.bind(globalThis);
    this.#headers = opts.headers;
  }

  async request(message: JsonRpcOutgoingRequest, signal: AbortSignal): Promise<unknown> {
    const endpoint = await this.#open();
    if (this.#ended !== undefined) { throw this.#ended; }
    const answer = new Promise<unknown>((resolve, reject) => {
      const giveUp = (): void => {
        this.#waiting.delete(message.id);
        reject(new Error(`${message.method} was cancelled`));
      };
      signal.addEventListener('abort', giveUp, { once: true });
      this.#waiting.set(message.id, {
        resolve: (value) => { signal.removeEventListener('abort', giveUp); resolve(value); },
        reject: (error) => { signal.removeEventListener('abort', giveUp); reject(error); },
      });
    });
    try {
      await this.#post(endpoint, message, signal);
    } catch (error) {
      this.#waiting.delete(message.id);
      throw error;
    }
    return answer;
  }

  async notify(message: JsonRpcNotification): Promise<void> {
    await this.#post(await this.#open(), message, this.#stop.signal);
  }

  async respond(message: JsonRpcResponse): Promise<void> {
    await this.#post(await this.#open(), message, this.#stop.signal);
  }

  onMessage(listener: (message: unknown) => void): () => void {
    return this.#listeners.add(listener);
  }

  opened(): void {
    // messages on this transport carry no protocol version
  }

  listen(): void {
    // the event stream is read from the start
  }

  close(): Promise<void> {
    this.#stop.abort();
    this.#end(new Error('the client closed'));
    return Promise.resolve();
  }

  #headersFor(extra: Readonly<Record<string, string>>): Record<string, string> {
    const base = typeof this.#headers === 'function' ? this.#headers() : this.#headers ?? {};
    return { ...base, ...extra };
  }

  async #post(endpoint: string, message: object, signal: AbortSignal): Promise<void> {
    const response = await this.#fetch(endpoint, {
      method: 'POST',
      headers: this.#headersFor({ 'content-type': 'application/json' }),
      body: JSON.stringify(message),
      signal: AbortSignal.any([signal, this.#stop.signal]),
    });
    await refusedCaller(response, endpoint);
    await response.body?.cancel();
    if (!response.ok) { throw new Error(`HTTP ${response.status} from ${endpoint}`); }
  }

  /** The endpoint to post to, opening the event stream the first time. */
  #open(): Promise<string> {
    this.#endpoint ??= this.#connect();
    return this.#endpoint;
  }

  async #connect(): Promise<string> {
    const response = await this.#fetch(this.#url, { method: 'GET', headers: this.#headersFor({ accept: 'text/event-stream' }), signal: this.#stop.signal });
    await refusedCaller(response, this.#url);
    if (!response.ok || response.body === null) {
      await response.body?.cancel();
      throw new Error(`HTTP ${response.status}: ${this.#url} opened no event stream`);
    }
    const body = response.body;
    return new Promise<string>((resolve, reject) => {
      let named = false;
      /** The stream ended: fail what waits, and the opening when no endpoint was named. */
      const fail = (error: Error): void => {
        this.#end(error);
        if (!named) { reject(error); }
      };
      readEventStream(body, (event) => {
        if (event.event === 'endpoint') {
          const endpoint = new URL(event.data, this.#url);
          if (endpoint.origin !== new URL(this.#url).origin) {
            reject(new Error(`the server named an endpoint on another origin (${endpoint.origin})`));
            return true;
          }
          named = true;
          resolve(endpoint.href);
        } else if (event.event === 'message') {
          this.#message(event.data);
        }
        return false;
      }).then(
        () => { fail(new Error('the server closed its event stream')); },
        (error: unknown) => { fail(new Error(`reading the event stream failed: ${messageOf(error)}`)); },
      );
    });
  }

  /** One message on the stream: an answer to a waiting request, or a server message. */
  #message(data: string): void {
    let message: unknown;
    try {
      message = JSON.parse(data);
    } catch {
      return;
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

  #end(error: Error): void {
    this.#ended ??= error;
    for (const waiting of this.#waiting.values()) { waiting.reject(error); }
    this.#waiting.clear();
  }
}
