/**
 * Shared spec — the single source of truth, imported as a value by the server and
 * **type-only** by the client. A few tiny demo endpoints, plus two **meta-endpoints**
 * that surface the very same spec as Model Context Protocol (MCP) tools.
 */
import { z } from 'zod';
import { spec, endpoint } from '@ayepi/core';

export const api = spec({
  endpoints: {
    /** POST /greet — a typed body in, a typed object out. */
    greet: endpoint({
      body: z.object({ name: z.string().min(1) }),
      response: z.object({ message: z.string() }),
      doc: { summary: 'Greet someone by name', tags: ['demo'] },
    }),

    /** POST /add — sum two JSON numbers. */
    add: endpoint({
      body: z.object({ a: z.number(), b: z.number() }),
      response: z.object({ sum: z.number() }),
      doc: { summary: 'Add two numbers', tags: ['demo'] },
    }),

    /** POST /roll — roll an n-sided die. */
    roll: endpoint({
      body: z.object({ sides: z.number().int().min(2) }),
      response: z.object({ value: z.number() }),
      doc: { summary: 'Roll an n-sided die', tags: ['demo'] },
    }),

    /** GET /tools — the MCP tool definitions for this very spec. */
    tools: endpoint({
      method: 'GET',
      response: z.array(z.object({ name: z.string(), description: z.string(), inputSchema: z.unknown() })),
      doc: { summary: 'List this spec as MCP tools', tags: ['mcp'] },
    }),

    /** POST /callTool — invoke a tool by name and return its text result. */
    callTool: endpoint({
      body: z.object({ name: z.string(), args: z.record(z.string(), z.unknown()) }),
      response: z.object({ result: z.string(), isError: z.boolean() }),
      doc: { summary: 'Invoke an MCP tool and return its text result', tags: ['mcp'] },
    }),
  },
});
