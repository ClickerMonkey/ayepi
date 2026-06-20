# 06 · mcp

Turn **any ayepi spec into [Model Context Protocol](https://modelcontextprotocol.io)
tools** — one tool per endpoint, with a JSON-Schema input derived from the endpoint's zod
config and a description from its docs. A `tools/call` runs **in-process** against the
running app (through the typed client), so it's a real end-to-end request — middleware,
validation, handlers — with no network.

This app shows three tiny demo endpoints (`greet` / `add` / `roll`) plus two
**meta-endpoints** that expose the whole spec as MCP tools, and a Vue **tool explorer** UI
that lists the tools and invokes them.

## Run

```sh
pnpm -r build
pnpm --filter @ayepi/examples mcp
# or: cd examples && pnpm mcp
```

→ http://localhost:3006

## Files

- `shared.ts` — the demo endpoints, plus `tools` (GET) and `callTool` (POST) meta-endpoints.
- `server.ts` — implements the demo handlers; `tools` returns `mcpTools(api)` (a *pure*
  transform, no app needed), and `callTool` routes through an `mcpServer(app, api)` built
  right after the app exists (a module-scoped `mcpHandle` closes the late-bound loop).
- `client.ts` — Vue tool explorer: list tools, render a form from each `inputSchema`,
  invoke via `callTool`, show the text result.

## Endpoints

| | Name | Notes |
| --- | --- | --- |
| POST | `/greet` | `{ name }` → `{ message }` |
| POST | `/add` | `{ a, b }` → `{ sum }` |
| POST | `/roll` | `{ sides }` → `{ value }` |
| GET | `/tools` | the MCP tool definitions for this spec (`mcpTools(api)`) |
| POST | `/callTool` | `{ name, args }` → `{ result, isError }` (runs `tools/call`) |

## Try it

```sh
curl -s localhost:3006/tools                                                   # tool defs (greet/add/roll/…)
curl -s -XPOST localhost:3006/callTool -H 'content-type: application/json' \
  -d '{"name":"add","args":{"a":2,"b":3}}'                                     # → {"result":"{\"sum\":5}","isError":false}
curl -s -XPOST localhost:3006/callTool -H 'content-type: application/json' \
  -d '{"name":"greet","args":{"name":"Ada"}}'
```

In the UI: click a tool on the left, fill its form (built from the tool's `inputSchema`),
and **Invoke** — the result text appears below. Docs at `/docs/swagger` and `/docs/openapi.json`.

## The MCP angle

Any ayepi spec becomes agent tools for free. Point an MCP-aware agent at `mcpServer(app,
spec)` (or `serveStdio` for stdio transport) and every endpoint is a callable, schema-typed
tool — `tools/list` and `tools/call` dispatch straight through your real app.

> **JSON args, not strings.** MCP tool arguments arrive as JSON, so `add`/`roll` take JSON
> numbers and validate fine. Only if a value would arrive as a *string* (e.g. query params,
> which cross the HTTP wire as text) do you need `z.coerce.number()` / `z.coerce.boolean()`.
