import { describe, it, expect } from 'vitest';
import {
  mcpToolServer, mcpHttp, serveStdio, textResult, isProtocolVersion, MCP_SESSION_HEADER, MCP_VERSION_HEADER,
  type JsonRpcNotification, type LineReader, type McpTool, type McpToolSource,
} from '../src/index';

/** A tool source whose tools change at runtime, like a system adding fns. */
class LiveTools implements McpToolSource {
  readonly #tools = new Map<string, { tool: McpTool; run: (args: Readonly<Record<string, unknown>>) => unknown }>();
  readonly #listeners = new Set<() => void>();
  signals: AbortSignal[] = [];

  add(name: string, run: (args: Readonly<Record<string, unknown>>) => unknown): void {
    this.#tools.set(name, { tool: { name, description: `The ${name} tool.`, inputSchema: { type: 'object' } }, run });
    for (const listener of this.#listeners) { listener(); }
  }

  tools(): McpTool[] {
    return [...this.#tools.values()].map((t) => t.tool);
  }

  async call(name: string, args: Readonly<Record<string, unknown>>, signal: AbortSignal) {
    this.signals.push(signal);
    const entry = this.#tools.get(name);
    return entry === undefined ? undefined : textResult(JSON.stringify(await entry.run(args)));
  }

  onChange(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => { this.#listeners.delete(listener); };
  }
}

const rpc = (method: string, params?: unknown, id: number | undefined = 1) => ({
  jsonrpc: '2.0', method, ...(params === undefined ? {} : { params }), ...(id === undefined ? {} : { id }),
});

describe('mcpToolServer over a live source', () => {
  it('advertises listChanged, follows the source, and notifies when it changes', async () => {
    const source = new LiveTools();
    const mcp = mcpToolServer(source, { serverInfo: { name: 'live', version: '1' }, instructions: 'Be kind.' });
    const heard: JsonRpcNotification[] = [];
    const stop = mcp.onNotification((m) => heard.push(m));

    expect(await mcp.handle(rpc('initialize', { protocolVersion: '2025-03-26' }))).toEqual({
      jsonrpc: '2.0', id: 1,
      result: { protocolVersion: '2025-03-26', capabilities: { tools: { listChanged: true } }, serverInfo: { name: 'live', version: '1' }, instructions: 'Be kind.' },
    });
    expect(await mcp.handle(rpc('tools/list'))).toMatchObject({ result: { tools: [] } });
    source.add('double', (args) => Number(args.n) * 2);
    expect(heard).toEqual([{ jsonrpc: '2.0', method: 'notifications/tools/list_changed' }]);
    expect(mcp.tools().map((t) => t.name)).toEqual(['double']);
    expect(await mcp.handle(rpc('tools/call', { name: 'double', arguments: { n: 4 } }))).toMatchObject({ result: { content: [{ text: '8' }] } });
    expect(source.signals[0]).toBeInstanceOf(AbortSignal);

    stop();
    source.add('triple', (args) => Number(args.n) * 3);
    expect(heard).toHaveLength(1);
    mcp.close();
  });

  it('answers ping, refuses bad initialize params, and passes a caller signal to the tool', async () => {
    const source = new LiveTools();
    source.add('noop', () => null);
    const mcp = mcpToolServer(source);
    expect(await mcp.handle(rpc('ping'))).toEqual({ jsonrpc: '2.0', id: 1, result: {} });
    expect(await mcp.handle(rpc('initialize', {}))).toMatchObject({ error: { code: -32602 } });
    const controller = new AbortController();
    await mcp.handle(rpc('tools/call', { name: 'noop' }), { signal: controller.signal });
    expect(source.signals.at(-1)).toBe(controller.signal);
  });

  it('turns a throwing tool into an isError result, a failing server into -32603, and acknowledges client responses', async () => {
    const failing: McpToolSource = {
      tools: () => { throw new Error('no list'); },
      call: () => Promise.reject(new Error('tool broke')),
    };
    const mcp = mcpToolServer(failing);
    expect(await mcp.handle(rpc('tools/call', { name: 'x' }))).toMatchObject({ result: { isError: true, content: [{ text: 'tool broke' }] } });
    expect(await mcp.handle(rpc('tools/list'))).toMatchObject({ error: { code: -32603, message: 'no list' } });
    expect(await mcp.handle({ jsonrpc: '2.0', id: 5, result: {} })).toBeNull();
    expect(await mcp.handle({ jsonrpc: '2.0', id: 5, error: { code: 1, message: 'x' } })).toBeNull();
    expect(await mcp.handle({ jsonrpc: '2.0', id: 5 })).toMatchObject({ error: { code: -32600 } });
    const odd = mcpToolServer({ tools: () => { throw 'plain'; }, call: () => Promise.reject('also plain') });
    expect(await odd.handle(rpc('tools/list'))).toMatchObject({ error: { message: 'plain' } });
    expect(await odd.handle(rpc('tools/call', { name: 'x' }))).toMatchObject({ result: { content: [{ text: 'also plain' }] } });
    // a source with no change events: nothing to unsubscribe
    mcp.close();
  });

  it('knows which protocol versions it speaks', () => {
    expect(isProtocolVersion('2025-06-18')).toBe(true);
    expect(isProtocolVersion('2020-01-01')).toBe(false);
  });

  it('writes notifications on stdio while the input lasts', async () => {
    const source = new LiveTools();
    const mcp = mcpToolServer(source);
    const lines: string[] = [];
    const input: LineReader = {
      async *[Symbol.asyncIterator]() {
        yield JSON.stringify(rpc('tools/list'));
        source.add('late', () => 1);
        yield JSON.stringify(rpc('tools/list', undefined, 2));
      },
    };
    await serveStdio(mcp, { input, output: { write: (line) => { lines.push(line); } } });
    expect(lines.map((l) => JSON.parse(l))).toMatchObject([
      { id: 1, result: { tools: [] } },
      { method: 'notifications/tools/list_changed' },
      { id: 2, result: { tools: [{ name: 'late' }] } },
    ]);
    source.add('after', () => 1);
    expect(lines).toHaveLength(3);
  });
});

/* ---- Streamable HTTP ---- */

const URL_ = 'http://mcp.test/mcp';

function post(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request(URL_, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) });
}

async function started(opts: Parameters<typeof mcpHttp>[1] = {}) {
  const source = new LiveTools();
  source.add('echo', (args) => args.text);
  const http = mcpHttp(mcpToolServer(source), { sessionId: () => 'sess-1', ...opts });
  const init = await http.fetch(post(rpc('initialize', { protocolVersion: '2025-06-18' })));
  return { source, http, init, session: { [MCP_SESSION_HEADER]: 'sess-1', [MCP_VERSION_HEADER]: '2025-06-18' } };
}

describe('mcpHttp', () => {
  it('starts a session on initialize and answers requests in it', async () => {
    const { http, init, session } = await started();
    expect(init.status).toBe(200);
    expect(init.headers.get(MCP_SESSION_HEADER)).toBe('sess-1');
    expect(await init.json()).toMatchObject({ result: { protocolVersion: '2025-06-18' } });

    const call = await http.fetch(post(rpc('tools/call', { name: 'echo', arguments: { text: 'hi' } }), session));
    expect(call.headers.get('content-type')).toBe('application/json');
    expect(await call.json()).toMatchObject({ result: { content: [{ text: '"hi"' }] } });

    const note = await http.fetch(post({ jsonrpc: '2.0', method: 'notifications/initialized' }, session));
    expect(note.status).toBe(202);
    expect(await note.text()).toBe('');

    const batch = await http.fetch(post([rpc('ping', undefined, 7), { jsonrpc: '2.0', method: 'notifications/initialized' }], session));
    expect(await batch.json()).toEqual([{ jsonrpc: '2.0', id: 7, result: {} }]);
    http.close();
  });

  it('refuses requests outside a session, with a bad version, from a foreign origin, too large or not JSON', async () => {
    const { http, session } = await started({ allowedOrigins: ['http://ok.test'], maxBody: 200 });
    expect((await http.fetch(post(rpc('ping')))).status).toBe(400);
    expect((await http.fetch(post(rpc('ping'), { [MCP_SESSION_HEADER]: 'other' }))).status).toBe(404);
    expect((await http.fetch(post(rpc('ping'), { ...session, [MCP_VERSION_HEADER]: '1999-01-01' }))).status).toBe(400);
    expect((await http.fetch(post(rpc('ping'), { ...session, origin: 'http://evil.test' }))).status).toBe(403);
    expect((await http.fetch(post(rpc('ping'), { ...session, origin: 'http://ok.test' }))).status).toBe(200);

    const big = await http.fetch(post(rpc('tools/call', { name: 'echo', arguments: { text: 'x'.repeat(500) } }), session));
    expect(big.status).toBe(413);
    const declared = await http.fetch(post(rpc('ping'), { ...session, 'content-length': '100000' }));
    expect(declared.status).toBe(413);
    // a body that streams past the limit without declaring its length
    const chunks = new ReadableStream<Uint8Array>({
      start(c) { c.enqueue(new Uint8Array(150)); c.enqueue(new Uint8Array(150)); c.close(); },
    });
    const streamed = await http.fetch(new Request(URL_, { method: 'POST', headers: session, body: chunks, duplex: 'half' } as RequestInit));
    expect(streamed.status).toBe(413);
    const broken = new ReadableStream<Uint8Array>({ pull(c) { c.error(new Error('reset')); } });
    const unread = await http.fetch(new Request(URL_, { method: 'POST', headers: session, body: broken, duplex: 'half' } as RequestInit));
    expect(unread.status).toBe(400);
    const plain = new ReadableStream<Uint8Array>({ pull(c) { c.error('reset'); } });
    expect((await http.fetch(new Request(URL_, { method: 'POST', headers: session, body: plain, duplex: 'half' } as RequestInit))).status).toBe(400);

    const notJson = await http.fetch(post('{nope', session));
    expect(notJson.status).toBe(400);
    expect(await notJson.json()).toMatchObject({ error: { code: -32700 } });
    expect(await (await http.fetch(new Request(URL_, { method: 'POST', headers: session }))).json()).toMatchObject({ error: { code: -32700 } });
    expect((await http.fetch(new Request(URL_, { method: 'PUT' }))).status).toBe(405);
    http.close();
  });

  it('streams list_changed to open event streams and ends sessions on DELETE', async () => {
    const { source, http, session } = await started();
    expect((await http.fetch(new Request(URL_, { method: 'GET', headers: session }))).status).toBe(405);
    const controller = new AbortController();
    const events = await http.fetch(new Request(URL_, { method: 'GET', headers: { ...session, accept: 'text/event-stream' }, signal: controller.signal }));
    expect(events.headers.get('content-type')).toBe('text/event-stream');
    const reader = events.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toBe(': stream open\n\n');
    source.add('more', () => 1);
    const { value } = await reader.read();
    expect(new TextDecoder().decode(value)).toBe('event: message\ndata: {"jsonrpc":"2.0","method":"notifications/tools/list_changed"}\n\n');

    // a second stream whose client cancels is dropped on the next notification
    const other = await http.fetch(new Request(URL_, { method: 'GET', headers: { ...session, accept: 'text/event-stream' } }));
    await other.body!.cancel();
    source.add('again', () => 1);
    expect(new TextDecoder().decode((await reader.read()).value)).toContain('list_changed');
    await new Promise((resolve) => setTimeout(resolve, 0));

    controller.abort();
    expect((await reader.read()).done).toBe(true);
    expect((await http.fetch(new Request(URL_, { method: 'GET', headers: { accept: 'text/event-stream' } }))).status).toBe(400);

    const open = await http.fetch(new Request(URL_, { method: 'GET', headers: { ...session, accept: 'text/event-stream' } }));
    const openReader = open.body!.getReader();
    await openReader.read();
    expect((await http.fetch(new Request(URL_, { method: 'DELETE', headers: session }))).status).toBe(204);
    expect((await openReader.read()).done).toBe(true);
    expect((await http.fetch(new Request(URL_, { method: 'DELETE', headers: session }))).status).toBe(404);
    expect((await http.fetch(post(rpc('ping'), session))).status).toBe(404);
    http.close();
  });

  it('makes random session ids by default and ends every session on close', async () => {
    const source = new LiveTools();
    const http = mcpHttp(mcpToolServer(source));
    const init = await http.fetch(post(rpc('initialize', { protocolVersion: '2025-06-18' })));
    const id = init.headers.get(MCP_SESSION_HEADER);
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    const open = await http.fetch(new Request(URL_, { method: 'GET', headers: { [MCP_SESSION_HEADER]: id!, accept: 'text/event-stream' } }));
    const openReader = open.body!.getReader();
    await openReader.read();
    http.close();
    expect((await openReader.read()).done).toBe(true);
    expect((await http.fetch(post(rpc('ping'), { [MCP_SESSION_HEADER]: id! }))).status).toBe(404);
  });
});
