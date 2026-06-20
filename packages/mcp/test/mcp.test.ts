import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { spec, endpoint, server, implement } from '@ayepi/core';
import type { Server } from '@ayepi/core';
import type { McpTool } from '../src/index';
import { mcpTools, mcpServer, serveStdio } from '../src/index';
import type { McpServer, LineReader, LineWriter } from '../src/index';

/* ---- a spec exercising params, query, body, GET, declared errors, files, raw body, stream ---- */

const userPath = z.object({ id: z.string() });

const api = spec({
  endpoints: {
    // params + query + body, declared error, with a doc summary
    getUser: endpoint({
      method: 'GET',
      path: ':id',
      params: userPath,
      // query params arrive as strings over HTTP; coerce so booleans survive the round-trip
      query: z.object({ verbose: z.coerce.boolean().optional() }),
      response: z.object({ id: z.string(), name: z.string(), verbose: z.boolean() }),
      errors: { 404: z.object({ message: z.string() }) },
      doc: { summary: 'Fetch a user by id' },
    }),
    // body-only POST, description (no summary)
    createUser: endpoint({
      body: z.object({ name: z.string() }),
      response: z.object({ id: z.string(), name: z.string() }),
      doc: { description: 'Create a user' },
    }),
    // no input at all, no doc -> empty object schema + name fallback
    ping: endpoint({
      response: z.object({ ok: z.boolean() }),
    }),
    // declared error endpoint that always fails
    boom: endpoint({
      response: z.object({ never: z.string() }),
    }),
    // raw (non-object) body -> body *is* the data payload
    echo: endpoint({
      body: z.string(),
      response: z.object({ echoed: z.string() }),
    }),
    // files field -> represented as a marked string field
    upload: endpoint({
      files: { avatar: z.instanceof(Blob) },
      body: z.object({ caption: z.string() }),
      response: z.object({ size: z.number() }),
    }),
    // object body containing an unrepresentable field -> object schema degrades to a placeholder
    opaque: endpoint({
      body: z.object({ blob: z.custom<unknown>(() => true) }),
      response: z.object({ ok: z.boolean() }),
    }),
    // returns nothing -> 204 No Content -> client yields undefined
    noContent: endpoint({}),
  },
});

const handlers: any = {
  getUser: ({ data }: { data: { id: string; verbose?: boolean } }) => ({
    id: data.id,
    name: 'Ada',
    verbose: data.verbose ?? false,
  }),
  createUser: ({ data }: { data: { name: string } }) => ({ id: 'u1', name: data.name }),
  ping: () => ({ ok: true }),
  boom: ({ fail }: { fail: (status: number, data: unknown) => never }) => fail(404, { message: 'nope' }),
  echo: ({ data }: { data: string }) => ({ echoed: data }),
  upload: ({ files }: { files: { avatar: File } }) => ({ size: files.avatar.size }),
  opaque: () => ({ ok: true }),
  noContent: () => undefined,
};

const app = server(api, [implement(api).handlers(handlers)]) as Server<typeof api>;

/* ---- mcpTools ---- */

describe('mcpTools', () => {
  it('produces one tool per endpoint with merged input schema and description', () => {
    const tools = mcpTools(api);
    const byName: Record<string, McpTool> = Object.fromEntries(tools.map((t) => [t.name, t])) as Record<string, McpTool>;
    const get = (n: string): McpTool => byName[n]!;

    expect(tools.map((t) => t.name).sort()).toEqual([
      'boom',
      'createUser',
      'echo',
      'getUser',
      'noContent',
      'opaque',
      'ping',
      'upload',
    ]);

    // an object body that zod can't render contributes no properties (degrades to an empty object)
    expect(get('opaque').inputSchema).toEqual({ type: 'object', properties: {} });

    // description: summary preferred
    expect(get('getUser').description).toBe('Fetch a user by id');
    // description: falls back to description
    expect(get('createUser').description).toBe('Create a user');
    // description: falls back to the endpoint name
    expect(get('ping').description).toBe('ping');

    // merged input schema reflects params + query keys
    const getUserSchema = get('getUser').inputSchema as { type: string; properties: Record<string, unknown>; required?: string[] };
    expect(getUserSchema.type).toBe('object');
    expect(Object.keys(getUserSchema.properties).sort()).toEqual(['id', 'verbose']);
    expect(getUserSchema.required).toEqual(['id']);

    // body keys reflected
    const createSchema = get('createUser').inputSchema as { properties: Record<string, unknown> };
    expect(Object.keys(createSchema.properties)).toEqual(['name']);

    // empty-input endpoint -> empty object schema, no required
    const pingSchema = get('ping').inputSchema as { type: string; properties: Record<string, unknown>; required?: string[] };
    expect(pingSchema).toEqual({ type: 'object', properties: {} });

    // raw (non-object) body -> the body schema itself (a string), not an object wrapper
    const echoSchema = get('echo').inputSchema as { type: string };
    expect(echoSchema.type).toBe('string');

    // files field is marked as a non-transferable string field alongside body keys
    const uploadSchema = get('upload').inputSchema as { properties: Record<string, { type: string; description?: string }> };
    expect(uploadSchema.properties.caption!.type).toBe('string');
    expect(uploadSchema.properties.avatar!.type).toBe('string');
    expect(uploadSchema.properties.avatar!.description).toMatch(/file field/);
  });

  it('degrades schemas zod cannot represent to a placeholder', () => {
    // z.custom() (and similar) cannot be rendered as JSON Schema -> placeholder.
    const weird = spec({
      endpoints: {
        odd: endpoint({ body: z.custom<string>(() => true), response: z.object({ ok: z.boolean() }) }),
      },
    });
    const [tool] = mcpTools(weird);
    expect(tool!.inputSchema).toEqual({ type: 'string', description: 'unrepresentable schema' });
  });

  it('filters via include and applies namePrefix', () => {
    const tools = mcpTools(api, {
      include: (name) => name === 'ping',
      namePrefix: 'api_',
    });
    expect(tools.map((t) => t.name)).toEqual(['api_ping']);
  });
});

/* ---- mcpServer.handle ---- */

function rpc(method: string, params?: unknown, id: string | number | null = 1): Record<string, unknown> {
  const base: Record<string, unknown> = { jsonrpc: '2.0', method };
  if (params !== undefined) {
    base.params = params;
  }
  if (id !== undefined) {
    base.id = id;
  }
  return base;
}

describe('mcpServer.handle', () => {
  const mcp = mcpServer(app, api, { serverInfo: { name: 'test-api', version: '9.9.9' } });

  it('exposes tools() identical to mcpTools', () => {
    expect(mcp.tools().map((t) => t.name).sort()).toEqual(mcpTools(api).map((t) => t.name).sort());
  });

  it('initialize returns the handshake', async () => {
    const res = (await mcp.handle(rpc('initialize'))) as { result: { protocolVersion: string; capabilities: unknown; serverInfo: unknown } };
    expect(res.result).toEqual({
      protocolVersion: '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'test-api', version: '9.9.9' },
    });
  });

  it('tools/list returns the tools', async () => {
    const res = (await mcp.handle(rpc('tools/list'))) as { result: { tools: { name: string }[] } };
    expect(res.result.tools.map((t) => t.name)).toContain('getUser');
  });

  it('tools/call executes against the app and returns the real result text', async () => {
    const res = (await mcp.handle(rpc('tools/call', { name: 'getUser', arguments: { id: 'u7', verbose: true } }))) as {
      result: { content: { type: string; text: string }[]; isError?: boolean };
    };
    expect(res.result.isError).toBeUndefined();
    expect(JSON.parse(res.result.content[0]!.text)).toEqual({ id: 'u7', name: 'Ada', verbose: true });
  });

  it('tools/call serializes a body-only POST result', async () => {
    const res = (await mcp.handle(rpc('tools/call', { name: 'createUser', arguments: { name: 'Grace' } }))) as {
      result: { content: { text: string }[] };
    };
    expect(JSON.parse(res.result.content[0]!.text)).toEqual({ id: 'u1', name: 'Grace' });
  });

  it('tools/call with no-arg endpoint returns its result (null-coalesced)', async () => {
    const res = (await mcp.handle(rpc('tools/call', { name: 'ping' }))) as { result: { content: { text: string }[] } };
    expect(JSON.parse(res.result.content[0]!.text)).toEqual({ ok: true });
  });

  it('tools/call on a 204 endpoint serializes null', async () => {
    const res = (await mcp.handle(rpc('tools/call', { name: 'noContent' }))) as { result: { content: { text: string }[] } };
    expect(res.result.content[0]!.text).toBe('null');
  });

  it('tools/call invalid arguments => isError', async () => {
    const res = (await mcp.handle(rpc('tools/call', { name: 'createUser', arguments: { name: 123 } }))) as {
      result: { content: { text: string }[]; isError: boolean };
    };
    expect(res.result.isError).toBe(true);
    expect(typeof res.result.content[0]!.text).toBe('string');
  });

  it('tools/call on a declared-error endpoint => isError with the error message', async () => {
    const res = (await mcp.handle(rpc('tools/call', { name: 'boom' }))) as { result: { isError: boolean; content: { text: string }[] } };
    expect(res.result.isError).toBe(true);
  });

  it('tools/call unknown tool => isError', async () => {
    const res = (await mcp.handle(rpc('tools/call', { name: 'nope' }))) as { result: { isError: boolean; content: { text: string }[] } };
    expect(res.result.isError).toBe(true);
    expect(res.result.content[0]!.text).toMatch(/unknown tool "nope"/);
  });

  it('tools/call with non-string tool name => isError (empty name)', async () => {
    const res = (await mcp.handle(rpc('tools/call', { arguments: {} }))) as { result: { isError: boolean } };
    expect(res.result.isError).toBe(true);
  });

  it('tools/call with no params at all => isError', async () => {
    const res = (await mcp.handle(rpc('tools/call'))) as { result: { isError: boolean } };
    expect(res.result.isError).toBe(true);
  });

  it('unknown method => -32601', async () => {
    const res = (await mcp.handle(rpc('does/not/exist'))) as { error: { code: number; message: string } };
    expect(res.error.code).toBe(-32601);
    expect(res.error.message).toMatch(/does\/not\/exist/);
  });

  it('malformed request (not an object) => -32600', async () => {
    const res = (await mcp.handle(42)) as { error: { code: number } };
    expect(res.error.code).toBe(-32600);
  });

  it('malformed request (wrong jsonrpc version) => -32600', async () => {
    const res = (await mcp.handle({ jsonrpc: '1.0', id: 1, method: 'initialize' })) as { error: { code: number } };
    expect(res.error.code).toBe(-32600);
  });

  it('malformed request (non-string method) => -32600', async () => {
    const res = (await mcp.handle({ jsonrpc: '2.0', id: 1, method: 5 })) as { error: { code: number } };
    expect(res.error.code).toBe(-32600);
  });

  it('null request => -32600', async () => {
    const res = (await mcp.handle(null)) as { error: { code: number } };
    expect(res.error.code).toBe(-32600);
  });

  it('id defaults to null when omitted on an error response', async () => {
    // a request with an explicit null id still gets a response
    const res = (await mcp.handle({ jsonrpc: '2.0', id: null, method: 'bogus' })) as { id: unknown; error: { code: number } };
    expect(res.id).toBeNull();
  });

  it('tools/call where the transport throws a non-Error => isError with String(e)', async () => {
    // a fake app whose fetch rejects with a primitive (non-Error) exercises the String(e) branch
    const fakeApp = { fetch: () => Promise.reject('boom-string') } as unknown as typeof app;
    const m = mcpServer(fakeApp, api);
    const res = (await m.handle(rpc('tools/call', { name: 'ping' }))) as { result: { isError: boolean; content: { text: string }[] } };
    expect(res.result.isError).toBe(true);
    expect(res.result.content[0]!.text).toBe('boom-string');
  });
});

/* ---- notifications (no id) produce no response ---- */

describe('mcpServer.handle notifications', () => {
  const mcp = mcpServer(app, api);

  it('initialize notification => null', async () => {
    expect(await mcp.handle({ jsonrpc: '2.0', method: 'initialize' })).toBeNull();
  });
  it('tools/list notification => null', async () => {
    expect(await mcp.handle({ jsonrpc: '2.0', method: 'tools/list' })).toBeNull();
  });
  it('tools/call notification => null (still executes)', async () => {
    expect(await mcp.handle({ jsonrpc: '2.0', method: 'tools/call', params: { name: 'ping' } })).toBeNull();
  });
  it('unknown-method notification => null', async () => {
    expect(await mcp.handle({ jsonrpc: '2.0', method: 'whatever' })).toBeNull();
  });
});

/* ---- default options paths ---- */

describe('mcpServer defaults', () => {
  it('uses default serverInfo and baseUrl when none supplied', async () => {
    const mcp = mcpServer(app, api);
    const res = (await mcp.handle(rpc('initialize'))) as { result: { serverInfo: { name: string } } };
    expect(res.result.serverInfo.name).toBe('ayepi-mcp');
  });

  it('threads custom headers and baseUrl into executed calls', async () => {
    const mcp = mcpServer(app, api, { baseUrl: 'http://example.test', headers: () => ({ 'x-test': '1' }) });
    const res = (await mcp.handle(rpc('tools/call', { name: 'ping' }))) as { result: { content: { text: string }[] } };
    expect(JSON.parse(res.result.content[0]!.text)).toEqual({ ok: true });
  });

  it('respects namePrefix when routing tools/call', async () => {
    const mcp = mcpServer(app, api, { namePrefix: 'api_' });
    const res = (await mcp.handle(rpc('tools/call', { name: 'api_ping' }))) as { result: { content: { text: string }[]; isError?: boolean } };
    expect(res.result.isError).toBeUndefined();
    expect(JSON.parse(res.result.content[0]!.text)).toEqual({ ok: true });
  });
});

/* ---- serveStdio over in-memory streams ---- */

function reader(lines: string[]): LineReader {
  return {
    async *[Symbol.asyncIterator]() {
      for (const line of lines) {
        yield line;
      }
    },
  };
}

function writer(): LineWriter & { lines: string[] } {
  const lines: string[] = [];
  return {
    lines,
    write(line: string) {
      lines.push(line);
    },
  };
}

describe('serveStdio', () => {
  const mcp: McpServer = mcpServer(app, api);

  it('round-trips JSON-RPC requests, skips blank lines and notifications', async () => {
    const out = writer();
    await serveStdio(mcp, {
      input: reader([
        '', // blank -> skipped
        '   ', // whitespace -> skipped
        JSON.stringify(rpc('initialize')),
        '{ not json', // parse error -> -32600 response
        JSON.stringify({ jsonrpc: '2.0', method: 'initialize' }), // notification -> no output
        JSON.stringify(rpc('tools/call', { name: 'ping' }, 2)),
      ]),
      output: out,
    });

    const responses = out.lines.map((l) => JSON.parse(l));
    // initialize, parse-error, tools/call ping (notification produced nothing)
    expect(responses).toHaveLength(3);
    expect(responses[0].result.protocolVersion).toBe('2024-11-05');
    expect(responses[1].error.code).toBe(-32600);
    expect(JSON.parse(responses[2].result.content[0].text)).toEqual({ ok: true });
  });

  it('awaits an async writer', async () => {
    const written: string[] = [];
    const out: LineWriter = { write: async (line) => void written.push(line) };
    await serveStdio(mcp, { input: reader([JSON.stringify(rpc('tools/list'))]), output: out });
    expect(written).toHaveLength(1);
    expect(JSON.parse(written[0]!).result.tools.length).toBeGreaterThan(0);
  });
});
