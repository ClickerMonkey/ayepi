import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  McpClient, McpMemoryClientTransport, McpToolError, McpToolSet, jsonResult, mcpSourceServer, textResult,
  type McpCaller, type McpToolResult,
} from '../src/index';
import { MemoryFiles, rpc, settle } from './fixtures';

const clientInfo = { name: 'test', version: '1' };
/** A JSON-RPC notification. */
const note = (method: string, params: unknown) => ({ jsonrpc: '2.0', method, params });

/** A tool that waits until its signal aborts, recording the reason. */
function waiting() {
  const reasons: unknown[] = [];
  const callers: McpCaller[] = [];
  const tools = new McpToolSet()
    .define({
      name: 'wait',
      args: z.object({}),
      run: (_args, { signal, caller }) => new Promise<McpToolResult>((resolve) => {
        callers.push(caller);
        signal.addEventListener('abort', () => { reasons.push(signal.reason); resolve(textResult('stopped')); }, { once: true });
      }),
    })
    .define({ name: 'value', args: z.object({ v: z.unknown() }), run: ({ v }) => jsonResult(v) })
    .define({ name: 'text', args: z.object({ t: z.string() }), run: ({ t }) => textResult(t) })
    .define({ name: 'image', args: z.object({}), run: () => ({ content: [{ type: 'image', data: 'AA', mimeType: 'image/png' }] }) })
    .define({ name: 'fail', args: z.object({}), run: () => ({ content: [{ type: 'image', data: 'AA', mimeType: 'image/png' }], isError: true }) })
    .define({ name: 'boom', args: z.object({}), run: () => { throw new Error('boom'); } });
  return { tools, reasons, callers };
}

describe('McpMemoryClientTransport', () => {
  it('connects a client to a server in process, as its own session with its auth', async () => {
    const { tools, callers } = waiting();
    const files = new MemoryFiles();
    const server = mcpSourceServer({ tools, resources: files });
    const auth = { subject: 'claude', scopes: ['read'] };
    const transport = new McpMemoryClientTransport(server, { session: 'mine', auth });
    expect(transport.session).toBe('mine');
    const client = await McpClient.connect(transport, { clientInfo });
    expect(client.server.capabilities.tools).toEqual({ listChanged: true });

    const stop = new AbortController();
    const pending = client.callTool('wait', {}, { signal: stop.signal });
    await settle();
    expect(callers).toEqual([{ session: 'mine', auth }]);
    stop.abort();
    await expect(pending).rejects.toThrow('tools/call was cancelled');

    const other = await McpClient.connect(new McpMemoryClientTransport(server), { clientInfo });
    const heard: string[] = [];
    client.onNotification((n) => { heard.push(`mine ${n.method}`); });
    other.onNotification((n) => { heard.push(`other ${n.method}`); });
    await client.subscribe('mem://a.txt');
    files.write('mem://a.txt', 'A2');
    tools.remove('text');
    expect(heard).toEqual(['mine notifications/resources/updated', 'mine notifications/tools/list_changed', 'other notifications/tools/list_changed']);
    expect(files.watching).toBe(1);
    transport.listen(); // listening already: nothing more
    await client.close();
    expect(files.watching).toBe(0);
    await expect(client.ping()).rejects.toThrow('the client closed');
    const aborted = new AbortController();
    aborted.abort();
    await expect(other.ping({ signal: aborted.signal })).rejects.toThrow();
    await other.close();
  });
});

describe('cancellation', () => {
  it('stops the request notifications/cancelled names, in its own session only', async () => {
    const { tools, reasons } = waiting();
    const server = mcpSourceServer({ tools });
    const first = server.handle(rpc('tools/call', { name: 'wait' }, 7), { session: 'a' });
    const second = server.handle(rpc('tools/call', { name: 'wait' }, 7), { session: 'b' });
    await settle();
    expect(await server.handle(note('notifications/cancelled', { requestId: 7, reason: 'enough' }), { session: 'a' })).toBeNull();
    expect(await first).toMatchObject({ id: 7, result: { content: [{ text: 'stopped' }] } });
    expect(reasons).toEqual(['enough']);
    await server.handle(note('notifications/cancelled', { nope: true }), { session: 'b' });
    await server.handle(note('notifications/cancelled', { requestId: 99 }), { session: 'b' });
    await server.handle(note('notifications/progress', { requestId: 7 }), { session: 'b' });
    expect(reasons).toEqual(['enough']);
    await server.handle(note('notifications/cancelled', { requestId: 7 }), { session: 'b' });
    expect(await second).toMatchObject({ result: { content: [{ text: 'stopped' }] } });
    expect(reasons).toEqual(['enough', 'cancelled by the client']);
  });

  it('keeps tracking a reused id until its own request ends, and stops everything on close', async () => {
    const { tools, reasons } = waiting();
    const server = mcpSourceServer({ tools });
    const older = server.handle(rpc('tools/call', { name: 'wait' }, 1));
    const newer = server.handle(rpc('tools/call', { name: 'wait' }, 1));
    const done = server.handle(rpc('tools/call', { name: 'value', arguments: { v: 1 } }, 2));
    expect(await done).toMatchObject({ result: { content: [{ text: '1' }] } });
    await settle();
    // the newer request owns id 1 now: cancelling it leaves the older one running
    await server.handle(note('notifications/cancelled', { requestId: 1 }));
    expect(await newer).toMatchObject({ result: { content: [{ text: 'stopped' }] } });
    server.close();
    expect(await older).toMatchObject({ result: { content: [{ text: 'stopped' }] } });
    expect(reasons).toEqual(['cancelled by the client', 'the server closed']);
  });

  it('aborts a request on close', async () => {
    const { tools, reasons } = waiting();
    const server = mcpSourceServer({ tools });
    const pending = server.handle(rpc('tools/call', { name: 'wait' }));
    await settle();
    server.close();
    await pending;
    expect(reasons).toEqual(['the server closed']);
  });
});

describe('McpClient helpers', () => {
  it('reads tool values against a schema', async () => {
    const { tools } = waiting();
    const client = await McpClient.connect(new McpMemoryClientTransport(mcpSourceServer({ tools })), { clientInfo });
    expect(await client.callToolAs('value', { v: { n: 1 } }, z.object({ n: z.number() }))).toEqual({ n: 1 });
    expect(await client.callToolAs('value', { v: [1, 2] }, z.array(z.number()))).toEqual([1, 2]);
    expect(await client.callToolAs('text', { t: '"x"' }, z.string())).toBe('x');
    await expect(client.callToolAs('text', { t: 'not json' }, z.string())).rejects.toThrow('the result of tool "text" is not JSON: not json');
    await expect(client.callToolAs('image', {}, z.string())).rejects.toThrow('the result of tool "image" has no text');
    await expect(client.callToolAs('value', { v: 'x' }, z.number())).rejects.toThrow(/the result of tool "value" doesn't fit/);
    const failed = client.callToolAs('boom', {}, z.unknown());
    await expect(failed).rejects.toBeInstanceOf(McpToolError);
    await expect(failed).rejects.toMatchObject({ message: 'boom', tool: 'boom', result: { isError: true } });
    await expect(client.callToolAs('fail', {}, z.unknown())).rejects.toThrow('tool "fail" failed');
    await client.close();
  });

  it('waits for the next notification of a method', async () => {
    const { tools } = waiting();
    const client = await McpClient.connect(new McpMemoryClientTransport(mcpSourceServer({ tools, resources: new MemoryFiles() })), { clientInfo });
    const next = client.nextNotification('notifications/tools/list_changed');
    const stop = new AbortController();
    const given = client.nextNotification('notifications/resources/list_changed', { signal: stop.signal });
    tools.remove('text');
    expect(await next).toEqual({ method: 'notifications/tools/list_changed' });
    stop.abort();
    await expect(given).rejects.toThrow('stopped waiting for notifications/resources/list_changed');
    const late = new AbortController();
    const waitingOn = client.nextNotification('notifications/tools/list_changed', { signal: late.signal });
    tools.remove('value');
    expect(await waitingOn).toEqual({ method: 'notifications/tools/list_changed' });
    late.abort(); // after it resolved: nothing
    await expect(client.nextNotification('x', { signal: AbortSignal.abort() })).rejects.toThrow('stopped waiting for x');
    await client.close();
  });
});
