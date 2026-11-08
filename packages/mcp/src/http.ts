/**
 * The MCP Streamable HTTP transport as a web-standard `fetch` handler: serve it with any runtime adapter that takes
 * `(Request) => Promise<Response>`.
 *
 * - `POST` carries one JSON-RPC message (or a batch). Requests are answered with `application/json`; a body of only
 *   notifications and responses gets `202 Accepted`.
 * - `GET` with `Accept: text/event-stream` opens a server-sent event stream for the server's own notifications
 *   (`notifications/tools/list_changed`, and `notifications/resources/updated` for the URIs the session subscribed
 *   to). It starts with a `: stream open` comment, so it opens at once even
 *   through adapters that send headers with the first chunk.
 * - `DELETE` ends a session, and its resource subscriptions with it.
 *
 * `initialize` starts a session: its response carries an `Mcp-Session-Id` header that every later request sends back.
 * A request for no session (other than `initialize`) is `400`, for an unknown or ended one `404`. A request whose
 * `MCP-Protocol-Version` header names a version this server doesn't speak is `400`. A body over `maxBody` bytes is
 * `413`; text that isn't JSON is `400` with a `-32700` error. With an authorizer, every request is checked first: a
 * refused one is `401` or `403`, and a session belongs to the subject that started it.
 *
 * @module
 */

import { z } from 'zod';
import {
  JSON_RPC_ERRORS, JsonRpcRequest, messageOf, rpcError,
  type JsonRpcNotification, type JsonRpcResponse, type McpAuthInfo, type McpServer, isProtocolVersion,
} from './protocol';
import type { McpAuthorizer } from './auth';

/** The session header (`Mcp-Session-Id`). */
export const MCP_SESSION_HEADER = 'mcp-session-id';
/** The protocol version header clients send after `initialize`. */
export const MCP_VERSION_HEADER = 'mcp-protocol-version';

/** Default body limit: 1 MiB. */
const DEFAULT_MAX_BODY = 1024 * 1024;

/** Options for {@link mcpHttp}. */
export interface McpHttpOptions {
  /** The largest request body accepted, in bytes (default 1 MiB). */
  readonly maxBody?: number;
  /**
   * Origins allowed to call (the `Origin` header). A request from any other origin is `403`, which guards a server on
   * localhost against DNS rebinding. Requests without an `Origin` (non-browser clients) are always allowed. Default:
   * every origin.
   */
  readonly allowedOrigins?: readonly string[];
  /** Makes session ids (default `crypto.randomUUID()`). */
  readonly sessionId?: () => string;
  /**
   * Checks every request before its body is read (see {@link BearerAuth}). A refused request gets the authorizer's
   * status (`401` with its `WWW-Authenticate` challenge, or `403`). The caller it names reaches the sources, and a
   * session belongs to the subject that started it: another subject naming it is `404`. Default: everyone may call.
   */
  readonly authorize?: McpAuthorizer;
}

/** A Streamable HTTP endpoint for an {@link McpServer}. */
export interface McpHttpHandler {
  /** Answer one HTTP request. */
  fetch(request: Request): Promise<Response>;
  /** End every session and close every event stream. */
  close(): void;
}

/** One client's session: the writers of its open event streams. */
interface Session {
  readonly id: string;
  /** Who started it (`undefined` without an authorizer). */
  readonly auth: McpAuthInfo | undefined;
  readonly streams: Set<WritableStreamDefaultWriter<Uint8Array>>;
}

const Batch = z.array(z.unknown()).min(1);

/** The comment an event stream starts with. */
const OPENED = new TextEncoder().encode(': stream open\n\n');

/** The body was larger than allowed. */
class TooLarge extends Error {}

/** Close an event stream; one the client already cancelled is closed already. */
function closeStream(writer: WritableStreamDefaultWriter<Uint8Array>): void {
  writer.close().catch(() => undefined);
}

/** Read a body as text, refusing it once it passes `limit` bytes. */
async function readLimited(request: Request, limit: number): Promise<string> {
  const declared = Number(request.headers.get('content-length') ?? '0');
  if (declared > limit) { throw new TooLarge(); }
  const body = request.body;
  if (body === null) { return ''; }
  const reader = body.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) { break; }
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel();
      throw new TooLarge();
    }
    parts.push(value);
  }
  const all = new Uint8Array(size);
  let at = 0;
  for (const part of parts) {
    all.set(part, at);
    at += part.byteLength;
  }
  return new TextDecoder().decode(all);
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}

function failure(status: number, code: number, message: string, headers: Record<string, string> = {}): Response {
  return json(status, rpcError(null, code, message), headers);
}

/** Whether a parsed message is an `initialize` request. */
function isInitialize(message: unknown): boolean {
  const request = JsonRpcRequest.safeParse(message);
  return request.success && request.data.method === 'initialize' && request.data.id !== undefined;
}

/** Serve an {@link McpServer} over MCP Streamable HTTP. */
export function mcpHttp(server: McpServer, opts: McpHttpOptions = {}): McpHttpHandler {
  const maxBody = opts.maxBody ?? DEFAULT_MAX_BODY;
  const sessionId = opts.sessionId ?? (() => crypto.randomUUID());
  const sessions = new Map<string, Session>();
  const encoder = new TextEncoder();

  const unsubscribe = server.onNotification((message: JsonRpcNotification, only: string | undefined) => {
    const frame = encoder.encode(`event: message\ndata: ${JSON.stringify(message)}\n\n`);
    const targets = only === undefined ? [...sessions.values()] : [sessions.get(only)].filter((target) => target !== undefined);
    for (const session of targets) {
      for (const writer of session.streams) {
        // a stream the client cancelled refuses the write: forget it
        writer.write(frame).catch(() => { session.streams.delete(writer); });
      }
    }
  });

  function endSession(session: Session): void {
    sessions.delete(session.id);
    server.endSession(session.id);
    for (const writer of session.streams) { closeStream(writer); }
  }

  /** The session a request names, or the response that refuses it. A session another subject started is unknown here. */
  function sessionOf(request: Request, auth: McpAuthInfo | undefined): Session | Response {
    const id = request.headers.get(MCP_SESSION_HEADER);
    if (id === null) { return failure(400, JSON_RPC_ERRORS.invalidRequest, `missing ${MCP_SESSION_HEADER} header`); }
    const session = sessions.get(id);
    if (session === undefined || session.auth?.subject !== auth?.subject) { return failure(404, JSON_RPC_ERRORS.invalidRequest, 'unknown or ended session'); }
    const version = request.headers.get(MCP_VERSION_HEADER);
    if (version !== null && !isProtocolVersion(version)) { return failure(400, JSON_RPC_ERRORS.invalidRequest, `unsupported protocol version ${version}`); }
    return session;
  }

  async function post(request: Request, auth: McpAuthInfo | undefined): Promise<Response> {
    let text: string;
    try {
      text = await readLimited(request, maxBody);
    } catch (error) {
      return error instanceof TooLarge
        ? failure(413, JSON_RPC_ERRORS.invalidRequest, `the body is over ${maxBody} bytes`)
        : failure(400, JSON_RPC_ERRORS.invalidRequest, `the body could not be read: ${messageOf(error)}`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return failure(400, JSON_RPC_ERRORS.parse, 'parse error');
    }
    const batch = Batch.safeParse(parsed);
    const messages = batch.success ? batch.data : [parsed];

    const headers: Record<string, string> = {};
    let session: Session;
    if (messages.some(isInitialize)) {
      const id = sessionId();
      session = { id, auth, streams: new Set() };
      sessions.set(id, session);
      headers[MCP_SESSION_HEADER] = id;
    } else {
      const found = sessionOf(request, auth);
      if (found instanceof Response) { return found; }
      session = found;
    }

    const replies: JsonRpcResponse[] = [];
    for (const message of messages) {
      const reply = await server.handle(message, { signal: request.signal, session: session.id, ...(auth === undefined ? {} : { auth }) });
      if (reply !== null) { replies.push(reply); }
    }
    if (replies.length === 0) { return new Response(null, { status: 202, headers }); }
    return json(200, batch.success ? replies : replies[0], headers);
  }

  function get(request: Request, auth: McpAuthInfo | undefined): Response {
    if (!(request.headers.get('accept') ?? '').includes('text/event-stream')) {
      return new Response(null, { status: 405, headers: { allow: 'POST, DELETE' } });
    }
    const session = sessionOf(request, auth);
    if (session instanceof Response) { return session; }
    const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
    const writer = writable.getWriter();
    session.streams.add(writer);
    // an SSE comment first, so adapters that send headers with the first chunk open the stream right away
    writer.write(OPENED).catch(() => { session.streams.delete(writer); });
    request.signal.addEventListener('abort', () => {
      session.streams.delete(writer);
      closeStream(writer);
    });
    return new Response(readable, { status: 200, headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' } });
  }

  function remove(request: Request, auth: McpAuthInfo | undefined): Response {
    const session = sessionOf(request, auth);
    if (session instanceof Response) { return session; }
    endSession(session);
    return new Response(null, { status: 204 });
  }

  return {
    async fetch(request) {
      const origin = request.headers.get('origin');
      if (origin !== null && opts.allowedOrigins !== undefined && !opts.allowedOrigins.includes(origin)) {
        return failure(403, JSON_RPC_ERRORS.invalidRequest, `origin ${origin} is not allowed`);
      }
      let auth: McpAuthInfo | undefined;
      if (opts.authorize !== undefined) {
        const decision = await opts.authorize.authorize(request);
        if (!decision.ok) {
          return failure(decision.status, JSON_RPC_ERRORS.invalidRequest, decision.message, decision.challenge === undefined ? {} : { 'www-authenticate': decision.challenge });
        }
        auth = decision.auth;
      }
      switch (request.method) {
        case 'POST': return post(request, auth);
        case 'GET': return get(request, auth);
        case 'DELETE': return remove(request, auth);
        default: return new Response(null, { status: 405, headers: { allow: 'GET, POST, DELETE' } });
      }
    },
    close() {
      unsubscribe();
      for (const session of [...sessions.values()]) { endSession(session); }
    },
  };
}
