import { describe, expect, it } from 'vitest';
import {
  McpClient, McpHttpClientTransport, McpHttpError, McpMemoryClientTransport, McpStdioClientTransport, mcpSourceServer,
  type McpClientHandlers, type McpElicitRequest,
} from '../src/index';
import { AddTool, Pipe, settle } from './fixtures';

const INFO = { clientInfo: { name: 'test', version: '1' } } as const;

/** A server scripted by hand over stdio pipes: it answers `initialize`; the test sends it requests and reads answers. */
async function scripted(handlers?: McpClientHandlers) {
  const toServer = new Pipe();
  const toClient = new Pipe();
  const seen: Array<{ id?: number | string; method?: string; params?: unknown; result?: unknown; error?: { code: number; message: string } }> = [];
  void (async () => {
    for await (const line of toServer) {
      const message = JSON.parse(line) as (typeof seen)[number];
      seen.push(message);
      if (message.method === 'initialize') {
        toClient.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 'scripted', version: '1' } } }));
      }
    }
  })();
  const client = await McpClient.connect(new McpStdioClientTransport({ input: toClient, output: toServer }), { ...INFO, ...(handlers === undefined ? {} : { handlers }) });
  /** Send the client a request and wait for its answer. */
  const ask = async (id: number | string, method: string, params?: unknown) => {
    toClient.write(JSON.stringify({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) }));
    for (let tries = 0; tries < 50; tries++) {
      const answer = seen.find((message) => message.id === id && message.method === undefined);
      if (answer !== undefined) { return answer; }
      await settle();
    }
    return undefined;
  };
  return { client, seen, toClient, ask };
}

describe('McpClient answering the server', () => {
  it('advertises what its handlers answer, and answers elicitation, roots and ping', async () => {
    const asked: McpElicitRequest[] = [];
    const { client, seen, ask } = await scripted({
      elicit: async (request) => { asked.push(request); return { action: 'accept', content: { branch: 'main', force: false } }; },
      roots: async () => [{ uri: 'file:///work', name: 'Work' }],
    });
    expect(seen[0]?.params).toMatchObject({ capabilities: { elicitation: {}, roots: { listChanged: true } } });
    const form = { message: 'Which branch?', requestedSchema: { type: 'object', properties: { branch: { type: 'string' } } } };
    expect((await ask(7, 'elicitation/create', form))?.result).toEqual({ action: 'accept', content: { branch: 'main', force: false } });
    expect(asked).toEqual([form]);
    expect((await ask('r', 'roots/list'))?.result).toEqual({ roots: [{ uri: 'file:///work', name: 'Work' }] });
    expect((await ask(9, 'ping'))?.result).toEqual({});
    expect((await ask(10, 'elicitation/create', { message: 1 }))?.error?.code).toBe(-32602);
    await client.rootsChanged();
    await settle();
    expect(seen.at(-1)).toMatchObject({ method: 'notifications/roots/list_changed' });
    await client.close();
  });

  it('refuses sampling and requests it has no handler for, and answers a failing handler with its message', async () => {
    const { client, seen, ask } = await scripted({ roots: () => Promise.reject(new Error('no folders')) });
    expect(seen[0]?.params).toMatchObject({ capabilities: { roots: { listChanged: true } } });
    expect((await ask(1, 'sampling/createMessage', {}))?.error?.code).toBe(-32601);
    expect((await ask(2, 'elicitation/create', { message: 'x', requestedSchema: {} }))?.error?.code).toBe(-32601);
    expect((await ask(3, 'roots/list'))?.error).toEqual({ code: -32603, message: 'no folders' });
    await client.close();
  });

  it('aborts a request the server cancels, and every one in flight on close, without answering', async () => {
    const signals: AbortSignal[] = [];
    const { client, seen, toClient } = await scripted({
      elicit: (_request, signal) => { signals.push(signal); return new Promise((resolve) => { signal.addEventListener('abort', () => { resolve({ action: 'cancel' }); }); }); },
    });
    const form = { message: 'Sure?', requestedSchema: {} };
    toClient.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'elicitation/create', params: form }));
    toClient.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'elicitation/create', params: form }));
    toClient.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { nope: true } }));
    toClient.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 1, reason: 'timed out' } }));
    toClient.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/other' }));
    toClient.write(JSON.stringify({ jsonrpc: '2.0', id: 3 }));
    await settle();
    expect(signals.map((signal) => signal.aborted)).toEqual([true, false]);
    await client.close();
    await settle();
    expect(signals[1]?.aborted).toBe(true);
    expect(seen.filter((message) => message.method === undefined)).toEqual([]);
  });

  it('answers in process, where the server ignores client answers', async () => {
    const transport = new McpMemoryClientTransport(mcpSourceServer({ tools: new AddTool() }));
    await expect(transport.respond({ jsonrpc: '2.0', id: 1, result: {} })).resolves.toBeUndefined();
  });
});

describe('McpHttpClientTransport answers and refusals', () => {
  it('posts answers to the server and fails on an HTTP error', async () => {
    const posted: string[] = [];
    let status = 202;
    const transport = new McpHttpClientTransport('http://mcp.test/', {
      fetch: async (input, init) => { posted.push(await new Request(input, init).text()); return new Response(status === 202 ? null : 'failed', { status }); },
    });
    await transport.respond({ jsonrpc: '2.0', id: 4, result: {} });
    expect(JSON.parse(posted[0] ?? '')).toEqual({ jsonrpc: '2.0', id: 4, result: {} });
    status = 500;
    await expect(transport.respond({ jsonrpc: '2.0', id: 5, result: {} })).rejects.toThrow('HTTP 500 for the answer to request 5');
  });

  it('throws McpHttpError with the challenge for a refused caller', async () => {
    const challenge = 'Bearer resource_metadata="https://mcp.test/.well-known/oauth-protected-resource"';
    const refusing = (headers: Record<string, string>) => new McpHttpClientTransport('http://mcp.test/', { fetch: async () => new Response('no', { status: 401, headers }) });
    const error = await McpClient.connect(refusing({ 'www-authenticate': challenge }), INFO).catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(McpHttpError);
    expect(error).toMatchObject({ status: 401, wwwAuthenticate: challenge });
    await expect(McpClient.connect(refusing({}), INFO)).rejects.toMatchObject({ status: 401, wwwAuthenticate: undefined });
  });
});
