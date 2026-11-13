import { afterEach, describe, expect, it } from 'vitest';
import {
  McpClient, McpError, McpHttpClientTransport, McpStdioClientTransport, mcpHttp, mcpSourceServer, serveStdio, MCP_SESSION_HEADER, MCP_VERSION_HEADER,
  type McpClientTransport, type McpHttpHandler, type McpNotice,
} from '../src/index';
import { AddTool, Greetings, MemoryFiles, Pipe, settle } from './fixtures';

const INFO = { clientInfo: { name: 'test', version: '1' } } as const;
const URL_ = 'http://mcp.test/';

/** The fetch requests a fake server saw. */
type Seen = Array<{ method: string; headers: Headers; body: string }>;

/** A Streamable HTTP endpoint over every source, and a fetch that reaches it in memory. */
function served() {
  const files = new MemoryFiles();
  const prompts = new Greetings();
  const http = mcpHttp(mcpSourceServer({ tools: new AddTool(), resources: files, prompts }, { serverInfo: { name: 'mem', version: '3' }, instructions: 'Be brief.' }), { sessionId: () => 'sid' });
  const seen: Seen = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    seen.push({ method: request.method, headers: request.headers, body: request.method === 'POST' ? await request.clone().text() : '' });
    return http.fetch(request);
  };
  return { files, prompts, http, seen, fetchImpl };
}

let open: McpHttpHandler | undefined;
afterEach(() => {
  open?.close();
  open = undefined;
});

/** A fetch answering every request with one fixed response. */
function answering(make: (request: Request) => Response | Promise<Response>): typeof fetch {
  return async (input, init) => make(new Request(input, init));
}

const json = (body: unknown, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json', ...headers } });
const initAnswer = (id: number | string, protocolVersion = '2025-06-18') => ({ jsonrpc: '2.0', id, result: { protocolVersion, capabilities: {}, serverInfo: { name: 'fake', version: '1' } } });

/** A fake server that answers `initialize`, then hands every other request to `rest`. */
function fakeServer(rest: (request: Request, body: { id?: number; method: string }) => Response | Promise<Response>): typeof fetch {
  return answering(async (request) => {
    if (request.method !== 'POST') { return new Response(null, { status: 405 }); }
    const body: { id?: number; method: string } = await request.json();
    if (body.method === 'initialize') { return json(initAnswer(body.id ?? 0)); }
    if (body.id === undefined) { return new Response(null, { status: 202 }); }
    return rest(request, body);
  });
}

describe('McpClient over Streamable HTTP', () => {
  it('does the handshake and calls tools, resources and prompts', async () => {
    const { http, seen, fetchImpl } = served();
    open = http;
    const transport = new McpHttpClientTransport(URL_, { fetch: fetchImpl, headers: () => ({ authorization: 'Bearer t' }) });
    const client = await McpClient.connect(transport, INFO);
    expect(client.server).toMatchObject({ protocolVersion: '2025-06-18', serverInfo: { name: 'mem', version: '3' }, instructions: 'Be brief.' });
    expect(transport.session).toBe('sid');
    expect(seen[1]).toMatchObject({ method: 'POST', body: '{"jsonrpc":"2.0","method":"notifications/initialized"}' });
    expect(seen[1]?.headers.get(MCP_SESSION_HEADER)).toBe('sid');
    expect(seen[1]?.headers.get(MCP_VERSION_HEADER)).toBe('2025-06-18');
    expect(seen[1]?.headers.get('authorization')).toBe('Bearer t');

    await client.ping();
    expect(await client.listTools()).toEqual([{ name: 'add', description: 'Add.', inputSchema: { type: 'object' } }]);
    expect(await client.callTool('add', { a: 2, b: 3 })).toEqual({ content: [{ type: 'text', text: '5' }] });
    expect((await client.listResources()).map((r) => r.uri)).toEqual(['mem://a.txt', 'mem://b.txt', 'mem://c.bin']);
    expect(await client.listResourceTemplates()).toEqual([{ uriTemplate: 'mem://{name}', name: 'A memory file' }]);
    expect(await client.readResource('mem://a.txt')).toEqual([{ uri: 'mem://a.txt', mimeType: 'text/plain', text: 'A' }]);
    expect(await client.listPrompts()).toHaveLength(2);
    expect(await client.getPrompt('greet', { name: 'Bo' })).toMatchObject({ messages: [{ content: { text: 'Say hello to Bo.' } }] });
    const missing = await client.getPrompt('greet').catch((error: unknown) => error);
    expect(missing).toBeInstanceOf(McpError);
    expect(missing).toMatchObject({ code: -32602, message: 'prompt "greet" needs name' });
    await expect(client.readResource('mem://none')).rejects.toMatchObject({ code: -32002 });
    await expect(client.callTool('nope')).rejects.toMatchObject({ code: -32602 });

    await client.close();
    expect(seen.at(-1)?.method).toBe('DELETE');
    expect(transport.session).toBeUndefined();
    await client.close();
  });

  it('hears notifications on the event stream, including updates it subscribed to', async () => {
    const { http, files, prompts, fetchImpl } = served();
    open = http;
    const client = await McpClient.connect(new McpHttpClientTransport(URL_, { fetch: fetchImpl }), INFO);
    const heard: McpNotice[] = [];
    const stop = client.onNotification((notice) => { heard.push(notice); });
    await settle();
    await client.subscribe('mem://b.txt');
    files.write('mem://b.txt', 'B2');
    prompts.changes.fire();
    await settle();
    expect(heard).toEqual([
      { method: 'notifications/resources/updated', params: { uri: 'mem://b.txt' } },
      { method: 'notifications/prompts/list_changed' },
    ]);
    await client.unsubscribe('mem://b.txt');
    files.write('mem://b.txt', 'B3');
    stop();
    prompts.changes.fire();
    await settle();
    expect(heard).toHaveLength(2);
    await client.close();
  });

  it('reads an answer sent as an event stream, passing other messages on as notifications', async () => {
    const fetchImpl = fakeServer((_request, body) => new Response(
      `: hi\r\nevent: message\r\ndata: {"jsonrpc":"2.0","method":"notifications/message","params":{"level":"info"}}\r\n\r\nid: 1\ndata:${JSON.stringify({ jsonrpc: '2.0', id: body.id, result: {} })}\n\n`,
      { headers: { 'content-type': 'text/event-stream' } },
    ));
    const client = await McpClient.connect(new McpHttpClientTransport(URL_, { fetch: fetchImpl, events: false }), INFO);
    const heard: string[] = [];
    client.onNotification((notice) => { heard.push(notice.method); });
    await client.ping();
    expect(heard).toEqual(['notifications/message']);
    await client.close();
  });

  it('fails when an event stream ends without the answer, or a reply is not JSON', async () => {
    const streams = fakeServer(() => new Response('data: not json\n\ndata: {"jsonrpc":"2.0","id":99,"result":{}}', { headers: { 'content-type': 'text/event-stream' } }));
    const client = await McpClient.connect(new McpHttpClientTransport(URL_, { fetch: streams, events: false }), INFO);
    await expect(client.ping()).rejects.toThrow('the event stream ended without an answer to ping');
    const html = fakeServer(() => new Response('<h1>oops</h1>', { status: 502 }));
    const other = await McpClient.connect(new McpHttpClientTransport(URL_, { fetch: html, events: false }), INFO);
    await expect(other.ping()).rejects.toThrow(`HTTP 502 from ${URL_}: <h1>oops</h1>`);
  });

  it('checks answers against the method result and the JSON-RPC shape', async () => {
    const odd = fakeServer((_request, body) => (body.method === 'tools/list' ? json({ jsonrpc: '2.0', id: body.id, result: { tools: [{ name: 1 }] } }) : json({ nope: true })));
    const client = await McpClient.connect(new McpHttpClientTransport(URL_, { fetch: odd, events: false }), INFO);
    await expect(client.listTools()).rejects.toThrow(/the server's answer to tools\/list doesn't fit MCP/);
    await expect(client.ping()).rejects.toThrow("the server's answer to ping is not a JSON-RPC response");
  });

  it('follows cursors, stopping at one it has seen', async () => {
    const pages = fakeServer((_request, body) => json({ jsonrpc: '2.0', id: body.id, result: { prompts: [{ name: `p${body.id}` }], nextCursor: 'same' } }));
    const client = await McpClient.connect(new McpHttpClientTransport(URL_, { fetch: pages, events: false }), INFO);
    expect((await client.listPrompts()).map((p) => p.name)).toEqual(['p1', 'p2']);
  });

  it('refuses a server that speaks another protocol version, and a notification the server refuses', async () => {
    let closed = 0;
    const future = answering(async (request) => {
      if (request.method === 'DELETE') { closed += 1; return new Response(null, { status: 204 }); }
      return json(initAnswer(0, '2099-01-01'), { [MCP_SESSION_HEADER]: 'f' });
    });
    await expect(McpClient.connect(new McpHttpClientTransport(URL_, { fetch: future }), INFO)).rejects.toThrow('the server speaks MCP 2099-01-01, which this client doesn\'t');
    expect(closed).toBe(1);
    const refusing = answering(async (request) => {
      const body: { method: string } = await request.json();
      return body.method === 'initialize' ? json(initAnswer(0)) : new Response('no', { status: 400 });
    });
    await expect(McpClient.connect(new McpHttpClientTransport(URL_, { fetch: refusing, headers: { 'x-a': '1' } }), INFO)).rejects.toThrow('HTTP 400 for notifications/initialized');
  });

  it('sends notifications/cancelled when a call is aborted', async () => {
    const bodies: string[] = [];
    const slow = answering(async (request) => {
      const body = await request.text();
      bodies.push(body);
      const parsed: { id?: number; method: string } = JSON.parse(body);
      if (parsed.method === 'initialize') { return json(initAnswer(0)); }
      if (parsed.method === 'tools/call') {
        return new Promise<Response>((_resolve, reject) => { request.signal.addEventListener('abort', () => { reject(new Error('aborted')); }); });
      }
      return new Response(null, { status: 202 });
    });
    const client = await McpClient.connect(new McpHttpClientTransport(URL_, { fetch: slow, events: false }), INFO);
    const controller = new AbortController();
    const call = client.callTool('slow', {}, { signal: controller.signal });
    await settle();
    controller.abort(new Error('user left'));
    await expect(call).rejects.toThrow();
    await settle();
    expect(JSON.parse(bodies.at(-1) ?? '{}')).toEqual({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 1, reason: 'user left' } });
  });

  it('tolerates a server without an event stream, and one whose stream fails', async () => {
    const noStream = fakeServer((_request, body) => json({ jsonrpc: '2.0', id: body.id, result: {} }));
    const client = await McpClient.connect(new McpHttpClientTransport(URL_, { fetch: noStream }), INFO);
    await settle();
    await client.ping();
    let gets = 0;
    const failing: typeof fetch = async (input, init) => {
      const request = new Request(input, init);
      if (request.method === 'GET') { gets += 1; throw new Error('no route'); }
      return noStream(request);
    };
    const other = await McpClient.connect(new McpHttpClientTransport(URL_, { fetch: failing }), INFO);
    await settle();
    expect(gets).toBe(1);
    await other.ping();
    const emptyGet: typeof fetch = async (input, init) => {
      const request = new Request(input, init);
      return request.method === 'GET' ? new Response(null, { status: 200 }) : noStream(request);
    };
    const third = await McpClient.connect(new McpHttpClientTransport(URL_, { fetch: emptyGet }), INFO);
    await settle();
    await third.ping();
    const refusedGet: typeof fetch = async (input, init) => {
      const request = new Request(input, init);
      if (request.method === 'GET') { return new Response('not here', { status: 405 }); }
      if (request.method === 'DELETE') { throw new Error('gone'); }
      const response = await noStream(request);
      return new Response(response.body, { headers: { ...Object.fromEntries(response.headers), [MCP_SESSION_HEADER]: 's' } });
    };
    const fourth = await McpClient.connect(new McpHttpClientTransport(URL_, { fetch: refusedGet }), INFO);
    await settle();
    await fourth.close();
  });

  it('treats an empty event stream answer as an unreadable reply', async () => {
    const empty = fakeServer(() => new Response(null, { headers: { 'content-type': 'text/event-stream' } }));
    const client = await McpClient.connect(new McpHttpClientTransport(URL_, { fetch: empty, events: false }), INFO);
    await expect(client.ping()).rejects.toThrow(`HTTP 200 from ${URL_}: `);
    const bare = fakeServer(() => new Response(null, { status: 204 }));
    const other = await McpClient.connect(new McpHttpClientTransport(URL_, { fetch: bare, events: false }), INFO);
    await expect(other.ping()).rejects.toThrow(`HTTP 204 from ${URL_}: `);
  });

  it('reads the body of a DELETE answer', async () => {
    let deleted = false;
    const chatty = answering(async (request) => {
      if (request.method === 'DELETE') { deleted = true; return new Response('bye'); }
      const body: { method: string } = await request.json();
      return body.method === 'initialize' ? json(initAnswer(0), { [MCP_SESSION_HEADER]: 'c' }) : new Response(null, { status: 202 });
    });
    const client = await McpClient.connect(new McpHttpClientTransport(URL_, { fetch: chatty, events: false }), INFO);
    await client.close();
    expect(deleted).toBe(true);
  });

  it('uses the global fetch by default', () => {
    expect(new McpHttpClientTransport(URL_).session).toBeUndefined();
  });
});

describe('McpClient over stdio', () => {
  /** A server on one pipe pair and a client transport on the other. */
  function piped() {
    const files = new MemoryFiles();
    const toServer = new Pipe();
    const toClient = new Pipe();
    const served = serveStdio(mcpSourceServer({ tools: new AddTool(), resources: files }), { input: toServer, output: toClient });
    const transport = new McpStdioClientTransport({ input: toClient, output: toServer });
    return { files, toServer, toClient, served, transport };
  }

  it('calls the server and hears its notifications', async () => {
    const { files, toServer, toClient, served, transport } = piped();
    const client = await McpClient.connect(transport, { ...INFO, protocolVersion: '2025-03-26' });
    expect(client.server.protocolVersion).toBe('2025-03-26');
    const heard: McpNotice[] = [];
    client.onNotification((notice) => { heard.push(notice); });
    await client.subscribe('mem://a.txt');
    files.write('mem://a.txt', 'A2');
    expect(await client.callTool('add', { a: 1, b: 1 })).toMatchObject({ content: [{ text: '2' }] });
    expect(heard).toEqual([{ method: 'notifications/resources/updated', params: { uri: 'mem://a.txt' } }]);
    // lines that aren't for a waiting request: blank, not JSON, an answer nobody waits for
    toClient.write('');
    toClient.write('{nope');
    toClient.write('{"jsonrpc":"2.0","id":42,"result":{}}');
    await settle();
    expect(heard).toHaveLength(1);
    await client.close();
    await expect(client.ping()).rejects.toThrow('the client closed');
    toServer.end();
    await served;
  });

  it('fails waiting requests when the server output ends, and later ones at once', async () => {
    const { toClient, transport } = piped();
    const client = await McpClient.connect(transport, INFO);
    const toolsServerless = new McpStdioClientTransport({ input: new Pipe(), output: { write: () => undefined } });
    const pending = toolsServerless.request({ jsonrpc: '2.0', id: 1, method: 'ping' }, new AbortController().signal);
    await toolsServerless.close();
    await expect(pending).rejects.toThrow('the client closed');
    toClient.end();
    await settle();
    await expect(client.ping()).rejects.toThrow('the server closed its output');
  });

  it('fails a request whose write fails, gives up on an aborted one, and ends when reading throws', async () => {
    const broken = new McpStdioClientTransport({ input: new Pipe(), output: { write: () => Promise.reject(new Error('pipe closed')) } });
    await expect(broken.request({ jsonrpc: '2.0', id: 1, method: 'ping' }, new AbortController().signal)).rejects.toThrow('pipe closed');
    const silent = new McpStdioClientTransport({ input: new Pipe(), output: { write: () => undefined } });
    const controller = new AbortController();
    const waiting = silent.request({ jsonrpc: '2.0', id: 1, method: 'ping' }, controller.signal);
    controller.abort();
    await expect(waiting).rejects.toThrow('ping was cancelled');
    const throwing = new McpStdioClientTransport({
      input: { [Symbol.asyncIterator]: () => ({ next: () => Promise.reject(new Error('EPIPE')) }) },
      output: { write: () => undefined },
    });
    await settle();
    await expect(throwing.request({ jsonrpc: '2.0', id: 1, method: 'ping' }, controller.signal)).rejects.toThrow('reading the server failed: EPIPE');
  });

  it('accepts any transport that implements the interface', async () => {
    const sent: unknown[] = [];
    const transport: McpClientTransport = {
      request: async (message) => (message.method === 'initialize' ? initAnswer(message.id) : { jsonrpc: '2.0', id: message.id, error: { code: -1, message: 'no', data: { why: 'x' } } }),
      notify: async (message) => { sent.push(message); },
      respond: async () => undefined,
      onMessage: () => () => undefined,
      opened: () => undefined,
      listen: () => undefined,
      close: async () => undefined,
    };
    const client = await McpClient.connect(transport, INFO);
    await expect(client.request('ping', undefined)).rejects.toMatchObject({ code: -1, data: { why: 'x' }, name: 'McpError' });
    expect(sent).toEqual([{ jsonrpc: '2.0', method: 'notifications/initialized' }]);
  });
});
