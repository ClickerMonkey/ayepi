<!--
ayepi-mcp.md — reference for `@ayepi/mcp`, written for coding agents.

Copy this file into any project that depends on `@ayepi/mcp` (e.g. into your repo's
`docs/` or `.claude/` directory) and reference it from your agents and slash commands.
It documents the public API, the patterns the package expects, and how it works under the
hood, with copy-pasteable examples. Keep it in sync with the installed package version.
-->

# `@ayepi/mcp` — overview

`@ayepi/mcp` is a [Model Context Protocol](https://modelcontextprotocol.io) (MCP) server and
client. On the server side it turns any [`@ayepi/core`](./ayepi-core.md) **spec** into MCP
**tools** — one tool per endpoint, with a JSON-Schema input derived from the endpoint's zod
config and a description taken from its docs — whose calls are **executed against a running
app** through the typed `@ayepi/core` client, so an MCP `tools/call` is a real end-to-end
request through your middleware, validation, and handlers with no network. It also serves any
other **tools, resources and prompts** you give it as sources. On the client side,
`McpClient` connects to any MCP server over Streamable HTTP or stdio.

```sh
pnpm add @ayepi/mcp @ayepi/core zod   # @ayepi/core and zod are peer deps
```

```ts
import { spec, endpoint, server } from '@ayepi/core';
import { McpClient, McpHttpClientTransport, mcpHttp, mcpServer, mcpSourceServer, mcpTools, serveStdio } from '@ayepi/mcp';
import { z } from 'zod';
```

There is **no external MCP SDK**: this package implements MCP over JSON-RPC itself:
`initialize` with version negotiation, `ping`, `tools/list` and `tools/call`,
`resources/list`, `resources/templates/list`, `resources/read`, `resources/subscribe` and
`resources/unsubscribe`, `prompts/list` and `prompts/get`, and the notifications
`notifications/{tools,resources,prompts}/list_changed` and `notifications/resources/updated`.
The transport is kept out of the protocol core, so everything is unit-testable without I/O.

Every MCP object (tools, tool results, content blocks, resources, templates, resource
contents, prompts, the `initialize` result) is a **zod schema first** with its type derived
from it (`McpTool`, `McpToolResult`, `McpContent`, `McpResource`, `McpResourceTemplate`,
`McpResourceContents`, `McpPrompt`, `McpPromptResult`, `McpInitializeResult`, …). `McpParams`
and `McpResults` map every request method to its params and result schemas; the server checks
params with the one and the client checks answers with the other, and `McpParamsOf<M>` /
`McpResultOf<M>` are their types.

Layers, smallest first:

| Export | Input | Output |
| --- | --- | --- |
| `mcpTools(spec, opts?)` | a spec | `McpTool[]` (pure, no execution) |
| `specToolSource(app, spec, opts?)` | an app + spec | an `McpToolSource` that runs tool calls against the app |
| `mcpSourceServer({ tools?, resources?, prompts? }, opts?)` | any sources | an `McpServer` that `handle`s JSON-RPC messages and sends notifications |
| `mcpToolServer(source, opts?)` | an `McpToolSource` | `mcpSourceServer({ tools: source }, opts)` |
| `mcpServer(app, spec, opts?)` | an app + spec | `mcpToolServer(specToolSource(app, spec, opts), opts)` |
| `serveStdio(server, { input, output })` | an `McpServer` + injected I/O | drives the server over newline-delimited JSON |
| `mcpHttp(server, opts?)` | an `McpServer` | a Streamable HTTP endpoint as a web-standard `fetch` handler |
| `McpClient.connect(transport, opts)` | an `McpHttpClientTransport` or `McpStdioClientTransport` | a connected client with typed calls |
--- | --- | --- |
| `mcpTools(spec, opts?)` | a spec | `McpTool[]` (pure, no execution) |
| `specToolSource(app, spec, opts?)` | an app + spec | an `McpToolSource` that runs tool calls against the app |
| `mcpToolServer(source, opts?)` | any `McpToolSource` | an `McpServer` that `handle`s JSON-RPC messages and sends notifications |
| `mcpServer(app, spec, opts?)` | an app + spec | `mcpToolServer(specToolSource(app, spec, opts), opts)` |
| `serveStdio(server, { input, output })` | an `McpServer` + injected I/O | drives the server over newline-delimited JSON |
| `mcpHttp(server, opts?)` | an `McpServer` | a Streamable HTTP endpoint as a web-standard `fetch` handler |
---

## `mcpTools(spec, opts?)`

Pure transform: a spec → an array of tool definitions. No app, no execution.

```ts
export interface McpTool {
  readonly name: string;          // endpoint name, optionally prefixed
  readonly description: string;   // from the endpoint's doc
  readonly inputSchema: object;   // JSON Schema (object)
}

export interface McpToolsOptions {
  readonly include?: (name: string, cfg: EndpointConfig) => boolean; // filter endpoints
  readonly namePrefix?: string;                                      // prefix every tool name
}

export function mcpTools(spec: AnySpec, opts?: McpToolsOptions): McpTool[];
```

For each (included) endpoint:

- **`name`** = `namePrefix + endpointName` (prefix defaults to `''`).
- **`description`** = `cfg.doc?.summary ?? cfg.doc?.description ?? name`.
- **`inputSchema`** = the merged input JSON Schema (see below).

```ts
const tools = mcpTools(api);
// filter + prefix: only non-GET endpoints, names like "api_createUser"
const writes = mcpTools(api, { include: (_n, c) => c.method !== 'GET', namePrefix: 'api_' });
```

### How inputs become JSON Schema

An ayepi endpoint splits its single `data` payload into disjoint **kinds**: path
`params`, `query`, and `body`. `mcpTools` merges them back into **one flat object
schema** — exactly the shape the client expects as `data`:

- `params`, `query`, and an **object** `body` each contribute their `properties` and
  `required` to a single `{ type: 'object', properties, required }` schema.
- A **non-object (raw) body** (e.g. `body: z.string()`) *is* the entire payload, so the
  input schema is that body's schema directly (e.g. `{ type: 'string' }`).
- An endpoint with **no input** gets `{ type: 'object', properties: {} }`.

JSON Schema is produced with zod v4's **`z.toJSONSchema(schema, { io: 'input' })`**.
(Core's own `jsonSchema` helper is `@internal` and not exported, so this package calls
`z.toJSONSchema` directly — the same primitive core uses under the hood.) A schema that
zod cannot represent (e.g. `z.custom()`, `z.function()`) **degrades gracefully** to a
placeholder `{ type: 'string', description: 'unrepresentable schema' }` rather than
throwing; an object field that is unrepresentable simply contributes no property.

### Files & streaming (gotchas)

- **`files`** (multipart fields): not expressible as a JSON tool argument, so each file
  field appears as a marked placeholder
  `{ type: 'string', description: 'file field (not transferable as a JSON tool argument)' }`.
  An LLM can see the field exists but cannot meaningfully fill it; uploads are not a good
  fit for text-only tool calls.
- **Streaming endpoints** (typed item streams or raw `streamIn`/`streamOut`): they are
  **still listed as tools** — `mcpTools` never excludes endpoints on its own; use
  `include` to drop them if you don't want them. Note that a `tools/call` against a
  raw-stream endpoint may not round-trip cleanly through a single JSON result; prefer
  `include: (_n, c) => !c.streamOut && !c.streamIn` if your clients can't handle streams.

---

## Sources: `McpToolSource`, `McpResourceSource`, `McpPromptSource`

A server's tools come from a **tool source**. `specToolSource` is the one over a spec; any
other implementation works the same way, including tools that change at runtime.

```ts
// McpTool is the shape mcpTools returns (above); McpToolResult is
// { content: McpContent[]; structuredContent?: object; isError?: boolean }, where McpContent is a
// text, image, audio, embedded resource or resource_link block.

export interface McpToolSource {
  tools(): readonly McpTool[];
  // undefined: no such tool (a -32602 error); a thrown error becomes an isError result
  call(name: string, args: Readonly<Record<string, unknown>>, signal: AbortSignal): Promise<McpToolResult | undefined>;
  // optional: a source with change events advertises tools.listChanged
  onChange?(listener: () => void): () => void;
}

export function textResult(text: string): McpToolResult;  // { content: [{ type: 'text', text }] }
export function errorResult(text: string): McpToolResult; // ... plus isError: true
```

A source that can change:

```ts
class LiveTools implements McpToolSource {
  readonly #tools = new Map<string, McpTool>();
  readonly #listeners = new Set<() => void>();
  add(tool: McpTool) { this.#tools.set(tool.name, tool); for (const l of this.#listeners) l(); }
  tools() { return [...this.#tools.values()]; }
  async call(name: string, args: Readonly<Record<string, unknown>>) {
    return this.#tools.has(name) ? textResult(JSON.stringify(args)) : undefined;
  }
  onChange(listener: () => void) { this.#listeners.add(listener); return () => { this.#listeners.delete(listener); }; }
}
const mcp = mcpToolServer(new LiveTools(), { serverInfo: { name: 'live', version: '1.0.0' } });
```

### Resources

```ts
export interface McpResourceSource {
  // a page of listed resources ({ resources, nextCursor? }); cursor is a page's nextCursor
  list(cursor: string | undefined, signal: AbortSignal): Promise<McpResourcePage>;
  // RFC 6570 URI templates for resources that aren't listed (none when absent)
  templates?(signal: AbortSignal): readonly McpResourceTemplate[] | Promise<readonly McpResourceTemplate[]>;
  // a resource's contents ({ uri, mimeType?, text } or { uri, mimeType?, blob }); undefined: none at the URI (-32002)
  read(uri: string, signal: AbortSignal): Promise<readonly McpResourceContents[] | undefined>;
  // optional: advertises resources.subscribe; called once per session and URI subscribed to
  watch?(uri: string, onUpdate: () => void): () => void;
  // optional: advertises resources.listChanged
  onChange?(listener: () => void): () => void;
}
```

A subscription belongs to the session it was made in (see `McpHandleOptions.session`): its
`notifications/resources/updated` goes to that session only, and it ends with
`resources/unsubscribe`, `server.endSession(session)` or `server.close()`.

### Prompts

```ts
export interface McpPromptSource {
  prompts(): readonly McpPrompt[]; // { name, title?, description?, arguments?: [{ name, description?, required? }] }
  // undefined: no such prompt (-32602). The server checks required arguments before calling this.
  get(name: string, args: Readonly<Record<string, string>>, signal: AbortSignal): Promise<McpPromptResult | undefined>;
  onChange?(listener: () => void): () => void; // advertises prompts.listChanged
}
```

---

## `specToolSource(app, spec, opts?)` and `mcpServer(app, spec, opts?)`

`specToolSource` offers a spec's endpoints as tools and executes calls against the app;
`mcpServer` is `mcpToolServer` over it.

```ts
export interface McpServerOptions extends McpToolsOptions, McpToolServerOptions {
  readonly baseUrl?: string;                  // internal client base URL (default 'http://mcp.local')
  readonly headers?: Record<string, string> | (() => Record<string, string>);
}

export function specToolSource(app: Server<AnySpec>, spec: AnySpec, opts?: McpServerOptions): McpToolSource;
export function mcpServer(app: Server<AnySpec>, spec: AnySpec, opts?: McpServerOptions): McpServer;
```

Internally it builds a `@ayepi/core` client wired to **`app.fetch`**:

```ts
client(spec, { baseUrl, fetchImpl: app.fetch, headers });
```

so a `tools/call` is dispatched in-process — no actual sockets. `baseUrl` only shapes the
request URL (the path/query the app sees); it never reaches the network. `headers` may be
a function for per-call auth tokens, mirroring the core client.

- **Success** → `{ content: [{ type: 'text', text: JSON.stringify(result ?? null) }] }`.
  A `204 No Content` endpoint (handler returns nothing) serializes to the string `"null"`.
- **Thrown error** (e.g. an `ApiError` from validation or a declared `fail()`) →
  `{ content: [{ type: 'text', text: errorMessage }], isError: true }`; non-`Error` throws
  are stringified via `String(e)`.

A spec's tools never change, so a spec server advertises `tools: { listChanged: false }`.

```ts
const app = server(api, [handlers]);
const mcp = mcpServer(app, api, {
  serverInfo: { name: 'my-api', version: '1.0.0' },
  headers: () => ({ authorization: `Bearer ${currentToken()}` }),
});
```

> **Query-param gotcha (inherited from HTTP):** query values cross the wire as strings.
> If an endpoint declares `query: z.object({ verbose: z.boolean() })`, the tool argument
> `true` arrives as `"true"` and fails boolean validation → `isError`. Use
> `z.coerce.boolean()` / `z.coerce.number()` for query params, as you would for any
> ayepi HTTP endpoint.

---

## `mcpSourceServer(sources, opts?)` and `mcpToolServer(source, opts?)`

```ts
export interface McpSources {
  readonly tools?: McpToolSource;
  readonly resources?: McpResourceSource;
  readonly prompts?: McpPromptSource;
}

export interface McpToolServerOptions {
  readonly serverInfo?: { readonly name: string; readonly version: string }; // default { name: 'ayepi-mcp', version: '0.0.0' }
  readonly instructions?: string; // returned by initialize
}

export interface McpHandleOptions {
  readonly signal?: AbortSignal; // reaches the source; a transport whose request goes away stops the call
  readonly session?: string;     // the client session; resource subscriptions belong to it (default: the sole session)
}

// session: the one session a notification is for, or undefined for every session
export type McpNotificationListener = (message: JsonRpcNotification, session: string | undefined) => void;

export interface McpServer {
  tools(): readonly McpTool[]; // [] without a tool source
  handle(message: unknown, options?: McpHandleOptions): Promise<JsonRpcResponse | null>;
  onNotification(listener: McpNotificationListener): () => void;
  endSession(session?: string): void; // drop a session's subscriptions
  close(): void;                      // stop listening to the sources, drop every subscription
}

export function mcpSourceServer(sources: McpSources, opts?: McpToolServerOptions): McpServer;
export function mcpToolServer(source: McpToolSource, opts?: McpToolServerOptions): McpServer; // { tools: source }
```

`handle(message)` takes one **already-parsed** JSON-RPC message and returns the response
object (or `null`). It never reads from any stream — that is the transports' job. Each
method's params are checked against `McpParams[method]` before its source is called.

| Method | Result |
| --- | --- |
| `initialize` | `{ protocolVersion, capabilities, serverInfo, instructions? }` |
| `ping` | `{}` |
| `tools/list` | `{ tools }` |
| `tools/call` | the tool source's result for `{ name, arguments }` |
| `resources/list` | the resource source's page for `{ cursor? }` |
| `resources/templates/list` | `{ resourceTemplates }` (empty when the source has no `templates`) |
| `resources/read` | `{ contents }` for `{ uri }` |
| `resources/subscribe` / `resources/unsubscribe` | `{}` for `{ uri }` |
| `prompts/list` | `{ prompts }` |
| `prompts/get` | the prompt source's `{ description?, messages }` for `{ name, arguments? }` |
| *anything else* | JSON-RPC error `-32601` (method not found) |

- **Capabilities**: `initialize` names each source given, and only those:
  `tools: { listChanged }`, `resources: { subscribe, listChanged }`, `prompts: { listChanged }`.
  `listChanged` is `true` when the source has `onChange`; `subscribe` when the resource source
  has `watch`. A method for a source (or `watch`) not given is `-32601`.
- **Version negotiation**: `MCP_PROTOCOL_VERSIONS` is `['2025-06-18', '2025-03-26', '2024-11-05']`.
  `initialize` answers with the client's `protocolVersion` when it is one of these, else the
  first (newest). `isProtocolVersion(v)` checks one. An `initialize` without a
  `protocolVersion` is `-32602`.
- **Errors**: params that don't fit the method, an unknown tool (`unknown tool "<name>"`) or
  prompt (`unknown prompt "<name>"`), and a prompt call missing a required argument
  (`prompt "<name>" needs <args>`) are **`-32602`**. A resource that isn't there is
  **`-32002`** (`resource not found: <uri>`). A tool that throws is an `isError` result. Any
  other failure while answering (a source that throws) is **`-32603`** with its message.
- **Malformed message** (not an object, wrong `jsonrpc`, non-string `method`, `null`) →
  **`-32600`** with `id: null`.
- **Notifications** (no `id`) and **responses a client sends** (`{ id, result }` /
  `{ id, error }`) are not answered: `handle` returns `null`, and a notification's method
  is not run.
- **Server notifications**: a source's `onChange` sends
  `notifications/{tools,resources,prompts}/list_changed` to every session; a watched resource
  sends `notifications/resources/updated` with `{ uri }` to the session that subscribed.

`JSON_RPC_ERRORS` names the codes: `parse` `-32700`, `invalidRequest` `-32600`,
`methodNotFound` `-32601`, `invalidParams` `-32602`, `internal` `-32603`,
`resourceNotFound` `-32002`. The message schemas `JsonRpcRequest`, `JsonRpcResponseMessage`,
`JsonRpcError`, `JsonRpcId` and `rpcError(id, code, message)` are exported for transports.

```ts
const mcp = mcpSourceServer({ tools, resources, prompts }, { serverInfo: { name: 'files', version: '1.0.0' } });
await mcp.handle({ jsonrpc: '2.0', id: 1, method: 'resources/read', params: { uri: 'mem://a.txt' } });
// → { jsonrpc: '2.0', id: 1, result: { contents: [{ uri: 'mem://a.txt', mimeType: 'text/plain', text: 'A' }] } }

await mcp.handle({ jsonrpc: '2.0', id: 2, method: 'prompts/get', params: { name: 'greet' } });
// → { jsonrpc: '2.0', id: 2, error: { code: -32602, message: 'prompt "greet" needs name' } }

await mcp.handle({ jsonrpc: '2.0', method: 'notifications/initialized' }); // notification
// → null  (no response written)
```

--- | --- |
| `initialize` | `{ protocolVersion, capabilities: { tools: { listChanged } }, serverInfo, instructions? }` |
| `ping` | `{}` |
| `tools/list` | `{ tools: McpTool[] }` |
| `tools/call` | the source's result for `{ name, arguments }` |
| *anything else* | JSON-RPC error `-32601` (method not found) |

- **Version negotiation**: `MCP_PROTOCOL_VERSIONS` is `['2025-06-18', '2025-03-26', '2024-11-05']`.
  `initialize` answers with the client's `protocolVersion` when it is one of these, else the
  first (newest). `isProtocolVersion(v)` checks one. An `initialize` without a
  `protocolVersion` is `-32602`.
- **`tools/call`**: params without a string `name` (or with non-object `arguments`) and an
  unknown tool are JSON-RPC errors **`-32602`** (`unknown tool "<name>"`); a tool that
  throws is an `isError` result.
- **Malformed message** (not an object, wrong `jsonrpc`, non-string `method`, `null`) →
  **`-32600`** with `id: null`. A failure while answering (a source whose `tools()` throws)
  → **`-32603`**.
- **Notifications** (no `id`) and **responses a client sends** (`{ id, result }` /
  `{ id, error }`) are not answered: `handle` returns `null`, and a notification's method
  is not run.
- **Server notifications**: when the source's `onChange` fires, every `onNotification`
  listener gets `{ jsonrpc: '2.0', method: 'notifications/tools/list_changed' }`.

`JSON_RPC_ERRORS` names the codes: `parse` `-32700`, `invalidRequest` `-32600`,
`methodNotFound` `-32601`, `invalidParams` `-32602`, `internal` `-32603`. The message
schemas `JsonRpcRequest` / `JsonRpcId` and `rpcError(id, code, message)` are exported for
transports.

```ts
await mcp.handle({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
// → { jsonrpc: '2.0', id: 1, result: { tools: [...] } }

await mcp.handle({ jsonrpc: '2.0', method: 'notifications/initialized' }); // notification
// → null  (no response written)

await mcp.handle({ jsonrpc: '2.0', id: 2, method: 'tools/call',
  params: { name: 'getUser', arguments: { id: 'u1' } } });
// → { jsonrpc: '2.0', id: 2, result: { content: [{ type: 'text', text: '{"id":"u1",...}' }] } }
```

---

## `serveStdio(server, { input, output })`

A thin newline-delimited-JSON loop, fully **injected** — no `process.stdin`/`process.stdout`
— so it round-trips in tests with in-memory fakes.

```ts
export interface LineReader { [Symbol.asyncIterator](): AsyncIterator<string>; }
export interface LineWriter { write(line: string): void | Promise<void>; }
export interface ServeStdioOptions { readonly input: LineReader; readonly output: LineWriter; }

export function serveStdio(server: McpServer, opts: ServeStdioOptions): Promise<void>;
```

Each input line is trimmed (blank lines skipped), `JSON.parse`d, and handed to
`server.handle`. Every non-`null` response is written back as **one JSON line**, and so is
every server notification while the input lasts (a trailing newline is your writer's to
add). A line that is not JSON gets a `-32700` parse error, so the loop never throws.
Resolves when the input is exhausted, and ends the sole session (dropping its subscriptions).

Wiring it to Node stdio (you provide the adapter — the package never imports `node:*`):

```ts
import { createInterface } from 'node:readline';

const rl = createInterface({ input: process.stdin });
await serveStdio(mcp, {
  input: rl, // readline's async iterator yields lines
  output: { write: (line) => process.stdout.write(line + '\n') },
});
```

---

## `mcpHttp(server, opts?)` — Streamable HTTP

```ts
export interface McpHttpOptions {
  readonly maxBody?: number;                    // bytes, default 1 MiB
  readonly allowedOrigins?: readonly string[];  // default: every origin
  readonly sessionId?: () => string;            // default crypto.randomUUID()
}

export interface McpHttpHandler {
  fetch(request: Request): Promise<Response>;
  close(): void; // end every session and event stream
}

export function mcpHttp(server: McpServer, opts?: McpHttpOptions): McpHttpHandler;
```

The MCP Streamable HTTP transport as a web-standard `fetch` handler, served by any adapter
that takes one — on Node, `@ayepi/node`'s `createRequestListener`:

```ts
import http from 'node:http';
import { createRequestListener } from '@ayepi/node';

const endpoint = mcpHttp(mcp, { allowedOrigins: ['http://localhost:5173'] });
http.createServer(createRequestListener(endpoint)).listen(4400);
```

| Request | Answer |
| --- | --- |
| `POST` one JSON-RPC message, or a batch array | `200 application/json` with the response(s); `202` when the body holds only notifications and responses |
| `POST` `initialize` | as above, plus an `Mcp-Session-Id` header (`MCP_SESSION_HEADER`) that every later request sends back |
| `GET` with `Accept: text/event-stream` | an SSE stream of the server's notifications (`event: message`, `data: <json>`), opening with a `: stream open` comment; `405` without that `Accept`. A notification for one session (a resource update it subscribed to) reaches only that session's streams |
| `DELETE` | ends the session: `204`, its event streams close and its resource subscriptions end |
| any other method | `405` |

Refusals: a request (other than one carrying `initialize`) with no session header is
`400`, with an unknown or ended session `404`; an `MCP-Protocol-Version` header
(`MCP_VERSION_HEADER`) naming a version the server does not speak is `400`; an `Origin`
outside `allowedOrigins` is `403` (requests without `Origin` pass); a body over
`maxBody` (declared or streamed) is `413`; a body that can't be read is `400`; text that
isn't JSON is `400` with a `-32700` error. Each refusal carries a JSON-RPC error body.
The request's `signal` reaches `handle`, so a client that disconnects stops its tool call,
and the request's session id is passed as `handle`'s `session`.

---

## `McpClient` — calling an MCP server

```ts
export interface McpConnectOptions {
  readonly clientInfo: { name: string; version: string; title?: string };
  readonly protocolVersion?: McpProtocolVersion; // default the newest
  readonly signal?: AbortSignal;
}

export class McpClient {
  static connect(transport: McpClientTransport, opts: McpConnectOptions): Promise<McpClient>;
  readonly server: McpInitializeResult; // protocolVersion, capabilities, serverInfo, instructions?
  request<M extends McpMethod>(method: M, params: McpParamsOf<M>, opts?: { signal?: AbortSignal }): Promise<McpResultOf<M>>;
  ping(opts?): Promise<void>;
  listTools(opts?): Promise<McpTool[]>;                       // every page
  callTool(name, args?, opts?): Promise<McpToolResult>;       // a failed tool is isError, not a throw
  listResources(opts?): Promise<McpResource[]>;               // every page
  listResourceTemplates(opts?): Promise<McpResourceTemplate[]>;
  readResource(uri, opts?): Promise<McpResourceContents[]>;
  subscribe(uri, opts?): Promise<void>;
  unsubscribe(uri, opts?): Promise<void>;
  listPrompts(opts?): Promise<McpPrompt[]>;                   // every page
  getPrompt(name, args?, opts?): Promise<McpPromptResult>;
  onNotification(listener: (notice: { method: string; params?: unknown }) => void): () => void;
  close(): Promise<void>;
}
```

`connect` sends `initialize`, refuses (and closes) a server that answers with a protocol
version this package doesn't speak, then sends `notifications/initialized` and starts
listening for server notifications. Every answer is checked against
`McpResults[method]`: a JSON-RPC error answer throws an **`McpError`** (`code`, `message`,
`data`); an answer that doesn't fit throws an `Error` naming the method. The `list*` methods
follow `nextCursor` to the last page, stopping at a cursor seen before. A call whose `signal`
aborts sends `notifications/cancelled` with its request id.

### Transports

```ts
export interface McpClientTransport {
  request(message: { jsonrpc: '2.0'; id: number; method: string; params?: unknown }, signal: AbortSignal): Promise<unknown>;
  notify(message: JsonRpcNotification): Promise<void>;
  onMessage(listener: (message: unknown) => void): () => void; // messages the server sends on its own
  opened(version: McpProtocolVersion): void;                    // the agreed version, for later messages
  listen(): void;                                               // the handshake is done: start hearing the server
  close(): Promise<void>;
}

new McpHttpClientTransport(url, {
  fetch?: typeof fetch,                                          // default the global fetch
  headers?: Record<string, string> | (() => Record<string, string>), // e.g. a fresh auth token per request
  events?: boolean,                                              // open the GET event stream (default true)
});
new McpStdioClientTransport({ input: LineReader, output: LineWriter }); // e.g. a child process's stdout/stdin
```

- **`McpHttpClientTransport`** `POST`s each message with
  `Accept: application/json, text/event-stream`. A JSON answer is read as is; an event-stream
  answer is read until the response with the request's id, and its other messages go to
  `onMessage`. The `Mcp-Session-Id` the server gives rides on every later request, and so does
  `MCP-Protocol-Version` once agreed. After the handshake a `GET` event stream carries server
  notifications (a server that answers it with an error has none). `close` ends that stream
  and `DELETE`s the session. A reply that isn't JSON throws `HTTP <status> from <url>: <text>`.
- **`McpStdioClientTransport`** writes one JSON line per message and reads the server's lines,
  matching responses to requests by id; every other line that is JSON goes to `onMessage`.
  When the server's output ends, requests still waiting fail, and so does every later one.

```ts
const client = await McpClient.connect(new McpHttpClientTransport('http://127.0.0.1:4400/'), { clientInfo: { name: 'me', version: '1' } });
const stop = client.onNotification((n) => { if (n.method === 'notifications/resources/updated') reload(); });
await client.subscribe('file:///notes/today.md');
const [contents] = await client.readResource('file:///notes/today.md');
const prompt = await client.getPrompt('summarize', { topic: 'cats' });
await client.close();
```

---

## End-to-end example

```ts
import { spec, endpoint, server, implement } from '@ayepi/core';
import { mcpServer } from '@ayepi/mcp';
import { z } from 'zod';

const api = spec({
  endpoints: {
    getUser: endpoint({
      method: 'GET',
      path: ':id',
      params: z.object({ id: z.string() }),
      query: z.object({ verbose: z.coerce.boolean().optional() }),
      response: z.object({ id: z.string(), name: z.string() }),
      doc: { summary: 'Fetch a user by id' },
    }),
  },
});

const app = server(api, [implement(api).handlers({ getUser: ({ data }) => ({ id: data.id, name: 'Ada' }) })]);
const mcp = mcpServer(app, api, { serverInfo: { name: 'users', version: '1.0.0' } });

const res = await mcp.handle({
  jsonrpc: '2.0', id: 1, method: 'tools/call',
  params: { name: 'getUser', arguments: { id: 'u1' } },
});
// res.result.content[0].text === '{"id":"u1","name":"Ada"}'
```

---

## Cross-references & notes

- **Spec / endpoints / client**: see [`ayepi-core.md`](./ayepi-core.md). `mcpTools` reads
  each endpoint's `cfg` (the `EndpointConfig` zod schemas + `doc`); `specToolSource`
  executes via the same `client()` documented there.
- **Serving HTTP on Node**: [`ayepi-node.md`](./ayepi-node.md) (`createRequestListener`
  takes any `fetch` handler).
- **Peer deps**: `@ayepi/core` and `zod` (`^4`). No other runtime dependencies — the MCP
  protocol surface is implemented in this package.
