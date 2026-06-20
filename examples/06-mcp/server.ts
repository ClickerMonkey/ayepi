/**
 * Node server. Implements three tiny demo endpoints, then exposes the **whole spec**
 * (including the demo endpoints) as MCP tools via two meta-endpoints:
 *
 * - `tools`    → `mcpTools(api)` — a *pure* transform (no app needed).
 * - `callTool` → routes through an `mcpServer(app, api)`, which executes the tool
 *   in-process against this very app (no network).
 *
 * `mcpServer` needs the `app`, but the `callTool` handler is part of that app — a
 * chicken/egg. We close the loop with a module-scoped `mcpHandle` assigned right after
 * `server(...)` exists; the handler only runs at request time, by which point it's set.
 */
import { implement, server } from '@ayepi/core';
import { mcpServer, mcpTools, type McpServer } from '@ayepi/mcp';
import { api } from './shared';
import { runExample } from '../_harness';

/** The MCP-over-app handle, assigned once `app` exists (see below). */
let mcpHandle: McpServer | undefined;

/** Shape of a successful/error `tools/call` result we care about. */
interface ToolCallResponse {
  result?: { content?: { type: string; text: string }[]; isError?: boolean };
}

const handlers = implement(api).handlers({
  greet: ({ data }) => ({ message: `Hello, ${data.name}! 👋` }),
  add: ({ data }) => ({ sum: data.a + data.b }),
  roll: ({ data }) => ({ value: 1 + Math.floor(Math.random() * data.sides) }),

  // Pure: a spec → tool definitions. `inputSchema` is a JSON Schema object; the response
  // schema declares it as `z.unknown()`, so the structural `object` type satisfies it.
  tools: () => mcpTools(api),

  // Execute a tool against this app via the MCP server, returning its text result.
  callTool: async ({ data }) => {
    if (!mcpHandle) {
      return { result: 'MCP server not ready', isError: true };
    }
    const res = (await mcpHandle.handle({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: data.name, arguments: data.args },
    })) as ToolCallResponse;
    const text = res.result?.content?.[0]?.text ?? '';
    return { result: text, isError: res.result?.isError ?? false };
  },
});

const app = server(api, [handlers], {
  cors: { origin: '*' },
  docs: { info: { title: 'ayepi · 06 mcp', version: '1.0.0' } },
});

// Now that `app` exists, build the MCP server and close the late-bound loop.
mcpHandle = mcpServer(app, api, { serverInfo: { name: 'ayepi-demo', version: '1.0.0' } });

runExample({ app, clientEntry: new URL('./client.ts', import.meta.url), title: '06 · mcp', port: 3006 });
