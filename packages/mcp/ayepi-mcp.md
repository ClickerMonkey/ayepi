<!--
ayepi-mcp.md — reference for `@ayepi/mcp`, written for coding agents.

Copy this file into any project that depends on `@ayepi/mcp` (e.g. into your repo's
`docs/` or `.claude/` directory) and reference it from your agents and slash commands.
It documents the public API, the patterns the package expects, and how it works under the
hood, with copy-pasteable examples. Keep it in sync with the installed package version.
-->

# `@ayepi/mcp` — overview

`@ayepi/mcp` turns any [`@ayepi/core`](./ayepi-core.md) **spec** into
[Model Context Protocol](https://modelcontextprotocol.io) (MCP) **tools** — one tool
per endpoint, with a JSON-Schema input derived from the endpoint's zod config and a
description taken from its docs. Tool calls are **executed against a running app**
through the typed `@ayepi/core` client, so an MCP `tools/call` is a real end-to-end
request through your middleware, validation, and handlers — no network required.

```sh
pnpm add @ayepi/mcp @ayepi/core zod   # @ayepi/core and zod are peer deps
```

```ts
import { spec, endpoint, server } from '@ayepi/core';
import { mcpServer, mcpTools, serveStdio } from '@ayepi/mcp';
import { z } from 'zod';
```

There is **no external MCP SDK** — this package implements the minimal MCP-over-JSON-RPC
protocol itself (just enough for `initialize` / `tools/list` / `tools/call`). The
transport is kept out of the protocol core, so everything is unit-testable without I/O.

Three layers, smallest first:

| Export | Input | Output |
| --- | --- | --- |
| `mcpTools(spec, opts?)` | a spec | `McpTool[]` (pure, no execution) |
| `mcpServer(app, spec, opts?)` | an app + spec | an `McpServer` that `handle`s JSON-RPC requests |
| `serveStdio(server, { input, output })` | an `McpServer` + injected I/O | drives the server over newline-delimited JSON |

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

## `mcpServer(app, spec, opts?)`

Wraps an app + spec into an MCP server that handles JSON-RPC 2.0 requests and executes
tool calls against the app.

```ts
export interface McpServerOptions extends McpToolsOptions {
  readonly baseUrl?: string;                  // internal client base URL (default 'http://mcp.local')
  readonly serverInfo?: { name: string; version: string };
  readonly headers?: Record<string, string> | (() => Record<string, string>);
}

export interface McpServer {
  tools(): McpTool[];
  handle(request: unknown): Promise<unknown>; // one JSON-RPC request -> one response (or null)
}

export function mcpServer(app: Server<AnySpec>, spec: AnySpec, opts?: McpServerOptions): McpServer;
```

Internally it builds a `@ayepi/core` client wired to **`app.fetch`**:

```ts
client(spec, { baseUrl, fetchImpl: app.fetch, headers });
```

so a `tools/call` is dispatched in-process — no actual sockets. `baseUrl` only shapes the
request URL (the path/query the app sees); it never reaches the network. `headers` may be
a function for per-call auth tokens, mirroring the core client.

```ts
const app = server(api, [handlers]);
const mcp = mcpServer(app, api, {
  serverInfo: { name: 'my-api', version: '1.0.0' },
  headers: () => ({ authorization: `Bearer ${currentToken()}` }),
});
```

### Supported JSON-RPC / MCP methods

`handle(request)` takes an **already-parsed** request object and returns the response
object (or `null`). It never reads from any stream — transport is your job (see
`serveStdio`).

| Method | Result |
| --- | --- |
| `initialize` | `{ protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo }` |
| `tools/list` | `{ tools: McpTool[] }` |
| `tools/call` | executes the tool; see below |
| *anything else* | JSON-RPC error `-32601` (method not found) |

**`tools/call`** params are `{ name, arguments }`:

- Resolves the (prefixed) tool name to its endpoint, then runs
  `client.call(endpointName, arguments)`.
- **Success** → `{ content: [{ type: 'text', text: JSON.stringify(result ?? null) }] }`.
  A `204 No Content` endpoint (handler returns nothing) serializes to the string `"null"`.
- **Thrown error** (e.g. an `ApiError` from validation or a declared `fail()`), →
  `{ content: [{ type: 'text', text: errorMessage }], isError: true }`. The loop never
  throws; non-`Error` throws are stringified via `String(e)`.
- **Unknown tool name** → an `isError` result (`unknown tool "<name>"`), **not** a
  JSON-RPC error. (The spec allows `-32602` here; this package chose the `isError`
  convention consistently so a bad tool name reads like any other tool failure.)

### Error & notification semantics

- **Malformed request** (not an object, wrong `jsonrpc`, non-string `method`, `null`) →
  JSON-RPC error **`-32600`** with `id: null`.
- **Unknown method** → JSON-RPC error **`-32601`**.
- **Notifications** — a request with **no `id` field** — never produce a response:
  `handle` returns `null`. A `tools/call` notification **still executes** the tool (its
  result is just discarded), matching JSON-RPC notification semantics.

```ts
await mcp.handle({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
// → { jsonrpc: '2.0', id: 1, result: { tools: [...] } }

await mcp.handle({ jsonrpc: '2.0', method: 'tools/list' }); // notification
// → null  (no response written)

await mcp.handle({ jsonrpc: '2.0', id: 2, method: 'tools/call',
  params: { name: 'getUser', arguments: { id: 'u1' } } });
// → { jsonrpc: '2.0', id: 2, result: { content: [{ type: 'text', text: '{"id":"u1",...}' }] } }
```

> **Query-param gotcha (inherited from HTTP):** query values cross the wire as strings.
> If an endpoint declares `query: z.object({ verbose: z.boolean() })`, the tool argument
> `true` arrives as `"true"` and fails boolean validation → `isError`. Use
> `z.coerce.boolean()` / `z.coerce.number()` for query params, as you would for any
> ayepi HTTP endpoint.

---

## `serveStdio(server, { input, output })`

An **optional**, thin newline-delimited-JSON loop. It is the only place transport lives,
and it is fully **injected** — no `process.stdin`/`process.stdout` — so it round-trips in
tests with in-memory fakes.

```ts
export interface LineReader { [Symbol.asyncIterator](): AsyncIterator<string>; }
export interface LineWriter { write(line: string): void | Promise<void>; }
export interface ServeStdioOptions { readonly input: LineReader; readonly output: LineWriter; }

export function serveStdio(server: McpServer, opts: ServeStdioOptions): Promise<void>;
```

Each input line is trimmed (blank lines skipped), `JSON.parse`d, and handed to
`server.handle`. Every non-`null` response is written back as **one JSON line** (a
trailing newline is appended by your writer/transport as needed). A line that fails to
parse yields a `-32600` invalid-request response so the loop never throws. Resolves when
the input is exhausted.

Wiring it to Node stdio (you provide the adapter — the package never imports `node:*`):

```ts
import { createInterface } from 'node:readline';

const rl = createInterface({ input: process.stdin });
await serveStdio(mcp, {
  input: rl, // readline's async iterator yields lines
  output: { write: (line) => process.stdout.write(line + '\n') },
});
```

In tests, fakes are trivial:

```ts
const input = { async *[Symbol.asyncIterator]() { yield JSON.stringify(req); } };
const out: string[] = [];
await serveStdio(mcp, { input, output: { write: (l) => void out.push(l) } });
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
  each endpoint's `cfg` (the `EndpointConfig` zod schemas + `doc`); `mcpServer` executes
  via the same `client()` documented there.
- **Peer deps**: `@ayepi/core` and `zod` (`^4`). No other runtime dependencies — the MCP
  protocol surface is implemented in this package.
- **Constants**: protocol version `2024-11-05`; JSON-RPC error codes `-32600`
  (invalid request) and `-32601` (method not found) are the only ones emitted.
