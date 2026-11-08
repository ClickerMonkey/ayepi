# @ayepi/mcp

Expose any [`@ayepi/core`](https://www.npmjs.com/package/@ayepi/core) spec as
[Model Context Protocol](https://modelcontextprotocol.io) (MCP) tools — schema-validated
from your zod endpoint definitions and executed against your running app.

```sh
pnpm add @ayepi/mcp @ayepi/core zod
```

`@ayepi/core` and `zod` (`^4`) are **peer dependencies**. There is no external MCP SDK —
this package implements MCP over JSON-RPC itself, with stdio and Streamable HTTP transports.

```ts
import { spec, endpoint, server, implement } from '@ayepi/core';
import { mcpServer, mcpTools, serveStdio } from '@ayepi/mcp';

const app = server(api, [implement(api).handlers(handlers)]);
const mcp = mcpServer(app, api, { serverInfo: { name: 'my-api', version: '1.0.0' } });

// one tool per endpoint; inputSchema derived from each endpoint's zod config
const tools = mcpTools(api);

// handle a JSON-RPC 2.0 message (initialize / ping / tools/list / tools/call / …)
const res = await mcp.handle({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
```

- **`mcpTools(spec, opts?)`** — pure spec → `McpTool[]` (name, description, JSON-Schema input).
- **`mcpServer(app, spec, opts?)`** — `handle(request)` runs `tools/call` against the app
  via the typed `@ayepi/core` client (in-process through `app.fetch`).
- **`mcpSourceServer({ tools, resources, prompts }, opts?)`** — a server over any tool,
  resource and prompt sources: tools that change at runtime (`notifications/tools/list_changed`),
  resources with templates and per-session subscriptions (`notifications/resources/updated`),
  and prompts with checked arguments. `mcpToolServer(source)` is the tools-only form.
- **`McpToolSet`** — tools defined at runtime from JSON Schema or zod, arguments checked
  before each run; **`McpToolView` / `McpPromptView` / `McpResourceView`** show the part of a
  source a filter lets through, and **`McpToolUnion` / `McpPromptUnion`** join sources — so
  one host serves each client its own slice, with `list_changed` only when that slice changes.
- **`McpClient`** — a typed MCP client over `McpHttpClientTransport` (Streamable HTTP),
  `McpStdioClientTransport` or `McpMemoryClientTransport` (in process, for tests), with every
  answer checked against its method's schema and `callToolAs(name, args, schema)` for typed values.
- **`serveStdio(server, { input, output })`** — newline-delimited-JSON loop over
  injected I/O (no hard-wired `process.stdin`).
- **`mcpHttp(server, opts?)`** — Streamable HTTP (sessions with an optional idle timeout and
  open/end hooks, an SSE stream for notifications, a body limit, origin checks, an optional
  authorizer such as `BearerAuth`)
  as a web-standard `fetch` handler; **`McpRouter`** serves many of them by path, each with
  its own auth.

See [`ayepi-mcp.md`](./ayepi-mcp.md) for the full reference: how inputs become JSON
Schema, the supported JSON-RPC/MCP methods, filtering/prefixing, and files/streaming
handling. Cross-linked with [`ayepi-core.md`](./ayepi-core.md).

## For AI coding agents

This package ships dense, machine-oriented reference docs written for **AI coding agents**
(Claude Code, Cursor, and the like) to understand and drive the package — point your agent at them:

- [`ayepi-mcp.md`](./ayepi-mcp.md)

They ship with this package and also live in the [repo](https://github.com/ClickerMonkey/ayepi/tree/main/packages/mcp).

