import { describe, expect, it } from 'vitest';
import {
  mcpHttp, mcpSourceServer, mcpToolServer, serveStdio, MCP_SESSION_HEADER,
  type JsonRpcNotification, type McpResourceSource,
} from '../src/index';
import { AddTool, Greetings, MemoryFiles, rpc } from './fixtures';

describe('mcpSourceServer', () => {
  it('advertises only the capabilities of the sources it has', async () => {
    const all = mcpSourceServer({ tools: new AddTool(), resources: new MemoryFiles(), prompts: new Greetings() });
    expect(await all.handle(rpc('initialize', { protocolVersion: '2025-06-18' }))).toMatchObject({
      result: { capabilities: { tools: { listChanged: false }, resources: { subscribe: true, listChanged: true }, prompts: { listChanged: true } } },
    });
    const plain: McpResourceSource = { list: async () => ({ resources: [] }), read: async () => undefined };
    const some = mcpSourceServer({ resources: plain, prompts: { prompts: () => [], get: async () => undefined } });
    expect(await some.handle(rpc('initialize', { protocolVersion: '2025-06-18' }))).toMatchObject({
      result: { capabilities: { resources: { subscribe: false, listChanged: false }, prompts: { listChanged: false } } },
    });
    expect(some.tools()).toEqual([]);
    for (const method of ['tools/list', 'tools/call']) {
      expect(await some.handle(rpc(method, { name: 'x' }))).toMatchObject({ error: { code: -32601, message: `method not found: ${method}` } });
    }
    expect(await some.handle(rpc('resources/templates/list'))).toMatchObject({ result: { resourceTemplates: [] } });
    expect(await some.handle(rpc('resources/subscribe', { uri: 'x://y' }))).toMatchObject({ error: { code: -32601 } });
    expect(await some.handle(rpc('resources/unsubscribe', { uri: 'x://y' }))).toMatchObject({ error: { code: -32601 } });
    const none = mcpSourceServer({});
    expect(await none.handle(rpc('initialize', { protocolVersion: '2025-06-18' }))).toMatchObject({ result: { capabilities: {} } });
    for (const method of ['resources/list', 'resources/templates/list', 'resources/read', 'prompts/list', 'prompts/get']) {
      expect(await none.handle(rpc(method, { uri: 'x://y', name: 'p' }))).toMatchObject({ error: { code: -32601 } });
    }
    expect(await none.handle(rpc('nope'))).toMatchObject({ error: { code: -32601, message: 'method not found: nope' } });
  });

  it('lists, pages and reads resources, and answers -32002 for one that is not there', async () => {
    const mcp = mcpSourceServer({ resources: new MemoryFiles() });
    expect(await mcp.handle(rpc('resources/list'))).toEqual({
      jsonrpc: '2.0', id: 1, result: { resources: [{ uri: 'mem://a.txt', name: 'a.txt' }, { uri: 'mem://b.txt', name: 'b.txt' }], nextCursor: '2' },
    });
    expect(await mcp.handle(rpc('resources/list', { cursor: '2' }))).toMatchObject({ result: { resources: [{ uri: 'mem://c.bin' }] } });
    expect(await mcp.handle(rpc('resources/templates/list'))).toMatchObject({ result: { resourceTemplates: [{ uriTemplate: 'mem://{name}' }] } });
    expect(await mcp.handle(rpc('resources/read', { uri: 'mem://a.txt' }))).toMatchObject({ result: { contents: [{ uri: 'mem://a.txt', text: 'A' }] } });
    expect(await mcp.handle(rpc('resources/read', { uri: 'mem://c.bin' }))).toMatchObject({ result: { contents: [{ blob: 'AAEC' }] } });
    expect(await mcp.handle(rpc('resources/read', { uri: 'mem://zzz' }))).toMatchObject({ error: { code: -32002, message: 'resource not found: mem://zzz' } });
    expect(await mcp.handle(rpc('resources/read', {}))).toMatchObject({ error: { code: -32602 } });
  });

  it('sends updates to the session that subscribed, until it unsubscribes or ends', async () => {
    const files = new MemoryFiles();
    const mcp = mcpSourceServer({ resources: files });
    const heard: Array<[JsonRpcNotification, string | undefined]> = [];
    mcp.onNotification((message, session) => { heard.push([message, session]); });

    await mcp.handle(rpc('resources/subscribe', { uri: 'mem://a.txt' }), { session: 's1' });
    await mcp.handle(rpc('resources/subscribe', { uri: 'mem://a.txt' }), { session: 's1' });
    await mcp.handle(rpc('resources/subscribe', { uri: 'mem://b.txt' }), { session: 's1' });
    await mcp.handle(rpc('resources/subscribe', { uri: 'mem://a.txt' }));
    expect(files.watching).toBe(3);
    files.write('mem://a.txt', 'A2');
    expect(heard).toEqual([
      [{ jsonrpc: '2.0', method: 'notifications/resources/updated', params: { uri: 'mem://a.txt' } }, 's1'],
      [{ jsonrpc: '2.0', method: 'notifications/resources/updated', params: { uri: 'mem://a.txt' } }, ''],
    ]);

    expect(await mcp.handle(rpc('resources/unsubscribe', { uri: 'mem://a.txt' }), { session: 's1' })).toMatchObject({ result: {} });
    expect(await mcp.handle(rpc('resources/unsubscribe', { uri: 'mem://a.txt' }), { session: 'never' })).toMatchObject({ result: {} });
    expect(files.watching).toBe(2);
    mcp.endSession('s1');
    expect(files.watching).toBe(1);
    mcp.endSession('unknown');
    files.changes.fire();
    expect(heard.at(-1)).toEqual([{ jsonrpc: '2.0', method: 'notifications/resources/list_changed' }, undefined]);
    mcp.close();
    expect(files.watching).toBe(0);
    expect(files.changes.size).toBe(0);
  });

  it('lists and fills prompts, checking required arguments first', async () => {
    const prompts = new Greetings();
    const mcp = mcpSourceServer({ prompts });
    const heard: string[] = [];
    mcp.onNotification((message) => { heard.push(message.method); });
    expect(await mcp.handle(rpc('prompts/list'))).toMatchObject({ result: { prompts: [{ name: 'greet', arguments: [{ name: 'name', required: true }, { name: 'mood' }] }, { name: 'ghost' }] } });
    expect(await mcp.handle(rpc('prompts/get', { name: 'greet', arguments: { name: 'Ann', mood: 'warm' } }))).toMatchObject({
      result: { description: 'A greeting.', messages: [{ role: 'user', content: { type: 'text', text: 'Say hello to Ann warmly.' } }] },
    });
    expect(await mcp.handle(rpc('prompts/get', { name: 'greet' }))).toMatchObject({ error: { code: -32602, message: 'prompt "greet" needs name' } });
    expect(await mcp.handle(rpc('prompts/get', { name: 'nope' }))).toMatchObject({ error: { code: -32602, message: 'unknown prompt "nope"' } });
    expect(await mcp.handle(rpc('prompts/get', { name: 'ghost' }))).toMatchObject({ error: { code: -32602, message: 'unknown prompt "ghost"' } });
    expect(await mcp.handle(rpc('prompts/get', { name: 'greet', arguments: { name: 1 } }))).toMatchObject({ error: { code: -32602 } });
    prompts.changes.fire();
    expect(heard).toEqual(['notifications/prompts/list_changed']);
  });

  it('turns a failing source into -32603', async () => {
    const mcp = mcpSourceServer({ resources: { list: () => Promise.reject(new Error('disk gone')), read: async () => undefined } });
    expect(await mcp.handle(rpc('resources/list'))).toMatchObject({ error: { code: -32603, message: 'disk gone' } });
  });

  it('drops the sole session when stdio input ends', async () => {
    const files = new MemoryFiles();
    const mcp = mcpSourceServer({ resources: files });
    const input = { async *[Symbol.asyncIterator]() { yield JSON.stringify(rpc('resources/subscribe', { uri: 'mem://a.txt' })); } };
    await serveStdio(mcp, { input, output: { write: () => undefined } });
    expect(files.watching).toBe(0);
  });
});

describe('mcpHttp with resources', () => {
  it('sends a session its own updates only, and ends its subscriptions on DELETE', async () => {
    const files = new MemoryFiles();
    const ids = ['one', 'two'];
    const http = mcpHttp(mcpSourceServer({ resources: files, tools: new AddTool() }), { sessionId: () => ids.shift() ?? 'x' });
    const post = (body: unknown, session?: string) => http.fetch(new Request('http://mcp.test/', {
      method: 'POST', headers: { 'content-type': 'application/json', ...(session === undefined ? {} : { [MCP_SESSION_HEADER]: session }) }, body: JSON.stringify(body),
    }));
    await post(rpc('initialize', { protocolVersion: '2025-06-18' }));
    await post(rpc('initialize', { protocolVersion: '2025-06-18' }));
    const stream = async (session: string) => {
      const response = await http.fetch(new Request('http://mcp.test/', { headers: { [MCP_SESSION_HEADER]: session, accept: 'text/event-stream' } }));
      const reader = response.body!.getReader();
      await reader.read();
      return reader;
    };
    const one = await stream('one');
    const two = await stream('two');
    await post(rpc('resources/subscribe', { uri: 'mem://a.txt' }), 'one');
    files.write('mem://a.txt', 'new');
    expect(new TextDecoder().decode((await one.read()).value)).toContain('"uri":"mem://a.txt"');
    files.changes.fire();
    expect(new TextDecoder().decode((await two.read()).value)).toContain('resources/list_changed');
    expect(new TextDecoder().decode((await one.read()).value)).toContain('resources/list_changed');
    expect(files.watching).toBe(1);
    await http.fetch(new Request('http://mcp.test/', { method: 'DELETE', headers: { [MCP_SESSION_HEADER]: 'one' } }));
    expect(files.watching).toBe(0);
    http.close();
    expect(mcpToolServer(new AddTool()).tools()).toHaveLength(1);
  });
});
