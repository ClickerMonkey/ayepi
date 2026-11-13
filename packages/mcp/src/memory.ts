/**
 * The in-process client transport: an {@link McpClient} talking straight to an {@link McpServer} with no I/O, for
 * tests and for hosts that hold both ends.
 *
 * @module
 */

import type { JsonRpcOutgoingRequest, McpClientTransport } from './client';
import { Listeners } from './listeners';
import type { JsonRpcNotification, JsonRpcResponse, McpAuthInfo, McpServer } from './protocol';

/** Options for {@link McpMemoryClientTransport}. */
export interface McpMemoryClientOptions {
  /** The session this client is (default a fresh `crypto.randomUUID()`, so each client is its own session). */
  readonly session?: string;
  /** The caller the sources see, as an HTTP authorizer would name it. */
  readonly auth?: McpAuthInfo;
}

/**
 * A client transport that hands each message to a server's `handle` in the same process. The client hears the
 * server's notifications for every session and for its own. A request whose signal aborts fails at once (the client
 * also sends `notifications/cancelled`, which stops it on the server). `close` ends the session.
 *
 * @example
 * ```ts
 * const client = await McpClient.connect(new McpMemoryClientTransport(server), { clientInfo: { name: 'test', version: '1' } });
 * ```
 */
export class McpMemoryClientTransport implements McpClientTransport {
  readonly #server: McpServer;
  readonly #session: string;
  readonly #auth: McpAuthInfo | undefined;
  readonly #listeners = new Listeners<unknown>();
  #stop: (() => void) | undefined;
  #closed = false;

  constructor(server: McpServer, opts: McpMemoryClientOptions = {}) {
    this.#server = server;
    this.#session = opts.session ?? crypto.randomUUID();
    this.#auth = opts.auth;
  }

  /** The session this client is. */
  get session(): string {
    return this.#session;
  }

  async request(message: JsonRpcOutgoingRequest, signal: AbortSignal): Promise<unknown> {
    if (this.#closed) { throw new Error('the client closed'); }
    signal.throwIfAborted();
    const stop = new AbortController();
    const aborted = new Promise<never>((_resolve, reject) => {
      signal.addEventListener('abort', () => { reject(new Error(`${message.method} was cancelled`)); }, { once: true, signal: stop.signal });
    });
    try {
      return await Promise.race([this.#server.handle(message, this.#options(signal)), aborted]);
    } finally {
      stop.abort();
    }
  }

  async notify(message: JsonRpcNotification): Promise<void> {
    await this.#server.handle(message, this.#options());
  }

  async respond(message: JsonRpcResponse): Promise<void> {
    await this.#server.handle(message, this.#options());
  }

  onMessage(listener: (message: unknown) => void): () => void {
    return this.#listeners.add(listener);
  }

  opened(): void {
    // messages in process carry no protocol version
  }

  listen(): void {
    this.#stop ??= this.#server.onNotification((message, only) => {
      if (only === undefined || only === this.#session) { this.#listeners.emit(message); }
    });
  }

  async close(): Promise<void> {
    this.#closed = true;
    this.#stop?.();
    this.#stop = undefined;
    this.#server.endSession(this.#session);
  }

  #options(signal?: AbortSignal): { signal?: AbortSignal; session: string; auth?: McpAuthInfo } {
    return { ...(signal === undefined ? {} : { signal }), session: this.#session, ...(this.#auth === undefined ? {} : { auth: this.#auth }) };
  }
}
