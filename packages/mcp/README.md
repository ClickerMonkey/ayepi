# @ayepi/mcp

Expose any [`@ayepi/core`](https://www.npmjs.com/package/@ayepi/core) spec as
[Model Context Protocol](https://modelcontextprotocol.io) (MCP) tools — schema-validated
from your zod endpoint definitions and executed against your running app.

```sh
pnpm add @ayepi/mcp @ayepi/core zod
```

`@ayepi/core` and `zod` (`^4`) are **peer dependencies**. There is no external MCP SDK —
this package implements the minimal MCP-over-JSON-RPC protocol itself.

```ts
import { spec, endpoint, server, implement } from '@ayepi/core';
import { mcpServer, mcpTools, serveStdio } from '@ayepi/mcp';

const app = server(api, [implement(api).handlers(handlers)]);
const mcp = mcpServer(app, api, { serverInfo: { name: 'my-api', version: '1.0.0' } });

// one tool per endpoint; inputSchema derived from each endpoint's zod config
const tools = mcpTools(api);

// handle a JSON-RPC 2.0 request (initialize / tools/list / tools/call)
const res = await mcp.handle({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
```

- **`mcpTools(spec, opts?)`** — pure spec → `McpTool[]` (name, description, JSON-Schema input).
- **`mcpServer(app, spec, opts?)`** — `handle(request)` runs `tools/call` against the app
  via the typed `@ayepi/core` client (in-process through `app.fetch`).
- **`serveStdio(server, { input, output })`** — optional newline-delimited-JSON loop over
  injected I/O (no hard-wired `process.stdin`).

See [`ayepi-mcp.md`](./ayepi-mcp.md) for the full reference: how inputs become JSON
Schema, the supported JSON-RPC/MCP methods, filtering/prefixing, and files/streaming
handling. Cross-linked with [`ayepi-core.md`](./ayepi-core.md).

## For AI coding agents

This package ships dense, machine-oriented reference docs written for **AI coding agents**
(Claude Code, Cursor, and the like) to understand and drive the package — point your agent at them:

- [`ayepi-mcp.md`](./ayepi-mcp.md)

They ship with this package and also live in the [repo](https://github.com/ClickerMonkey/ayepi/tree/main/packages/mcp).

