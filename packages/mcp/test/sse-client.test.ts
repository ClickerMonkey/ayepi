import { describe, expect, it } from 'vitest';
import { McpClient, McpHttpError, McpSseClientTransport, mcpSourceServer, readEventStream, type McpNotice, type SseEvent } from '../src/index';
import { AddTool, settle } from './fixtures';

const INFO = { clientInfo: { name: 'test', version: '1' }, protocolVersion: '2024-11-05' } as const;
const URL_ = 'http://mcp.test/sse';

/** An HTTP + SSE server in memory over a real source server: the GET stream and the message endpoint it names. */
function sseServer(endpoint = '/messages?session=s1') {
  const server = mcpSourceServer({ tools: new AddTool() });
  const encoder = new TextEncoder();
  let push: ((text: string) => void) | undefined;
  let end: (() => void) | undefined;
  const posts: Array<{ url: string; headers: Headers; body: unknown }> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    if (request.method === 'GET') {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          push = (text) => { controller.enqueue(encoder.encode(text)); };
          end = () => { controller.close(); };
          push(`event: endpoint\ndata: ${endpoint}\n\n`);
        },
      });
      return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
    }
    const body: unknown = await request.json();
    posts.push({ url: request.url, headers: request.headers, body });
    const answer = await server.handle(body);
    if (answer !== null) { push?.(`event: message\ndata: ${JSON.stringify(answer)}\n\n`); }
    return new Response('Accepted', { status: 202 });
  };
  return { server, fetchImpl, posts, push: (text: string) => push?.(text), end: () => end?.() };
}

describe('McpSseClientTransport', () => {
  it('opens the stream, posts to the endpoint it names, and reads answers and notifications off the stream', async () => {
    const { fetchImpl, posts, push } = sseServer();
    const client = await McpClient.connect(new McpSseClientTransport(URL_, { fetch: fetchImpl, headers: () => ({ authorization: 'Bearer t' }) }), INFO);
    expect(client.server.protocolVersion).toBe('2024-11-05');
    expect(await client.callTool('add', { a: 2, b: 3 })).toMatchObject({ content: [{ type: 'text', text: '5' }] });
    expect(posts[0]?.url).toBe('http://mcp.test/messages?session=s1');
    expect(posts[0]?.headers.get('authorization')).toBe('Bearer t');
    const heard: McpNotice[] = [];
    client.onNotification((notice) => { heard.push(notice); });
    push('event: message\ndata: not json\n\n');
    push('event: ping\ndata: x\n\n');
    push('event: message\ndata: {"jsonrpc":"2.0","method":"notifications/tools/list_changed"}\n\n');
    await settle();
    expect(heard).toEqual([{ method: 'notifications/tools/list_changed' }]);
    await client.close();
  });

  it('answers the server through the endpoint', async () => {
    const { fetchImpl, posts } = sseServer();
    const transport = new McpSseClientTransport(URL_, { fetch: fetchImpl, headers: { 'x-a': '1' } });
    await transport.respond({ jsonrpc: '2.0', id: 3, result: {} });
    expect(posts.at(-1)).toMatchObject({ body: { jsonrpc: '2.0', id: 3, result: {} } });
    expect(posts.at(-1)?.headers.get('x-a')).toBe('1');
    transport.opened();
    transport.listen();
    await transport.close();
  });

  it('fails waiting requests when the stream ends, and gives up on cancelled ones', async () => {
    const { fetchImpl, end } = sseServer();
    const silent: typeof fetch = async (input, init) => (new Request(input, init).method === 'GET' ? fetchImpl(input, init) : new Response(null, { status: 202 }));
    const transport = new McpSseClientTransport(URL_, { fetch: silent });
    const controller = new AbortController();
    const cancelled = transport.request({ jsonrpc: '2.0', id: 1, method: 'ping' }, controller.signal);
    await settle();
    controller.abort();
    await expect(cancelled).rejects.toThrow('ping was cancelled');
    const waiting = transport.request({ jsonrpc: '2.0', id: 2, method: 'ping' }, new AbortController().signal);
    await settle();
    end();
    await expect(waiting).rejects.toThrow('the server closed its event stream');
    await expect(transport.request({ jsonrpc: '2.0', id: 3, method: 'ping' }, new AbortController().signal)).rejects.toThrow('the server closed its event stream');
  });

  it('refuses an endpoint on another origin, a stream that names none, and a failed stream or post', async () => {
    const elsewhere = new McpSseClientTransport(URL_, { fetch: sseServer('https://evil.test/messages').fetchImpl });
    await expect(elsewhere.notify({ jsonrpc: '2.0', method: 'x' })).rejects.toThrow('another origin (https://evil.test)');

    const empty: typeof fetch = async () => new Response(new ReadableStream({ start(controller) { controller.close(); } }), { status: 200 });
    await expect(new McpSseClientTransport(URL_, { fetch: empty }).notify({ jsonrpc: '2.0', method: 'x' })).rejects.toThrow('the server closed its event stream');

    const broken: typeof fetch = async () => new Response(new ReadableStream({ start(controller) { controller.error(new Error('reset')); } }), { status: 200 });
    await expect(new McpSseClientTransport(URL_, { fetch: broken }).notify({ jsonrpc: '2.0', method: 'x' })).rejects.toThrow('reading the event stream failed: reset');

    const missing: typeof fetch = async () => new Response('gone', { status: 404 });
    await expect(new McpSseClientTransport(URL_, { fetch: missing }).notify({ jsonrpc: '2.0', method: 'x' })).rejects.toThrow('HTTP 404: http://mcp.test/sse opened no event stream');
    const bodiless: typeof fetch = async () => new Response(null, { status: 200 });
    await expect(new McpSseClientTransport(URL_, { fetch: bodiless }).notify({ jsonrpc: '2.0', method: 'x' })).rejects.toThrow('opened no event stream');

    const refused: typeof fetch = async () => new Response(null, { status: 401, headers: { 'www-authenticate': 'Bearer scope="read"' } });
    await expect(new McpSseClientTransport(URL_, { fetch: refused }).notify({ jsonrpc: '2.0', method: 'x' })).rejects.toBeInstanceOf(McpHttpError);

    const { fetchImpl } = sseServer();
    const failing: typeof fetch = async (input, init) => (new Request(input, init).method === 'GET' ? fetchImpl(input, init) : new Response(null, { status: 500 }));
    const transport = new McpSseClientTransport(URL_, { fetch: failing });
    await expect(transport.request({ jsonrpc: '2.0', id: 1, method: 'ping' }, new AbortController().signal)).rejects.toThrow('HTTP 500 from http://mcp.test/messages?session=s1');
    await transport.close();
  });
});

describe('readEventStream', () => {
  it('names each event, defaulting to message, and stops when asked', async () => {
    const text = 'event: endpoint\r\ndata: /m\r\n\r\n: comment\nid: 1\ndata: a\ndata: b\n\nevent: last\n\ndata: tail\n';
    const read = async (stop: boolean): Promise<SseEvent[]> => {
      const events: SseEvent[] = [];
      const body = new Response(text).body;
      if (body === null) { throw new Error('no body'); }
      await readEventStream(body, (event) => { events.push(event); return stop; });
      return events;
    };
    expect(await read(false)).toEqual([{ event: 'endpoint', data: '/m' }, { event: 'message', data: 'a\nb' }, { event: 'message', data: 'tail' }]);
    expect(await read(true)).toEqual([{ event: 'endpoint', data: '/m' }]);
  });
});
