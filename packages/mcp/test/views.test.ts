import { describe, expect, it } from 'vitest';
import {
  McpPromptUnion, McpPromptView, McpResourceView, McpToolSet, McpToolUnion, McpToolView, mcpSourceServer, textResult,
  type McpCaller, type McpPromptSource, type McpResourceSource, type McpToolSource,
} from '../src/index';
import { AddTool, Greetings, MemoryFiles, rpc } from './fixtures';

const caller: McpCaller = { session: 's', auth: { subject: 'claude', scopes: [] } };
const signal = new AbortController().signal;
const run = () => textResult('ran');

/** A set with tools `a`, `b` and `c`. */
function abc(): McpToolSet {
  return new McpToolSet().define({ name: 'a', inputSchema: {}, run }).define({ name: 'b', inputSchema: {}, run }).define({ name: 'c', inputSchema: {}, run });
}

describe('McpToolView', () => {
  it('shows and calls only the tools its filter lets through', async () => {
    const view = new McpToolView(abc(), (tool) => tool.name !== 'b');
    expect(view.tools().map((t) => t.name)).toEqual(['a', 'c']);
    expect(await view.call('a', {}, signal, caller)).toEqual(textResult('ran'));
    expect(await view.call('b', {}, signal, caller)).toBeUndefined();
    expect(new McpToolView(new AddTool()).tools().map((t) => t.name)).toEqual(['add']);
  });

  it('tells listeners only when the list it shows changes', () => {
    const set = abc();
    const view = new McpToolView(set, (tool) => tool.name === 'a');
    view.setFilter((tool) => tool.name !== 'c'); // nobody listens yet
    let heard = 0;
    const stop = view.onChange(() => { heard += 1; });
    const second = view.onChange(() => undefined);
    set.define({ name: 'c', inputSchema: { type: 'object' }, run }); // hidden: no notice
    expect(heard).toBe(0);
    set.define({ name: 'b', inputSchema: { type: 'object' }, run }); // shown: a notice
    expect(heard).toBe(1);
    view.setFilter((tool) => tool.name !== 'c'); // the same list
    expect(heard).toBe(1);
    view.setFilter(() => true);
    expect(heard).toBe(2);
    second();
    set.remove('a');
    expect(heard).toBe(3);
    stop();
    set.remove('b');
    expect(heard).toBe(3);
    const quiet = new McpToolView(new AddTool());
    quiet.onChange(() => { heard += 1; })();
    expect(heard).toBe(3);
  });

  it('serves as a server whose list can change', async () => {
    const view = new McpToolView(abc(), () => false);
    const mcp = mcpSourceServer({ tools: view });
    const notes: string[] = [];
    mcp.onNotification((message) => { notes.push(message.method); });
    expect(await mcp.handle(rpc('tools/call', { name: 'a' }))).toMatchObject({ error: { code: -32602, message: 'unknown tool "a"' } });
    view.setFilter(() => true);
    expect(notes).toEqual(['notifications/tools/list_changed']);
    expect(await mcp.handle(rpc('tools/list'))).toMatchObject({ result: { tools: [{ name: 'a' }, { name: 'b' }, { name: 'c' }] } });
    mcp.close();
  });
});

describe('McpPromptView', () => {
  it('shows and fills only the prompts its filter lets through, and tells of changes', async () => {
    const prompts = new Greetings();
    const view = new McpPromptView(prompts, (prompt) => prompt.name === 'greet');
    expect(view.prompts().map((p) => p.name)).toEqual(['greet']);
    expect(await view.get('greet', { name: 'Ada' }, signal, caller)).toMatchObject({ description: 'A greeting.' });
    expect(await view.get('ghost', {}, signal, caller)).toBeUndefined();
    let heard = 0;
    const stop = view.onChange(() => { heard += 1; });
    view.setFilter(() => true);
    expect(heard).toBe(1);
    stop();
    expect(prompts.changes.size).toBe(0);
    expect(new McpPromptView(prompts).prompts()).toHaveLength(2);
  });
});

describe('McpResourceView', () => {
  it('lists, reads and watches only the URIs its filter lets through', async () => {
    const files = new MemoryFiles();
    const view = new McpResourceView(files, { uri: (uri) => uri.endsWith('.txt'), template: (t) => t.name !== 'A memory file' });
    expect(await view.list(undefined, signal, caller)).toEqual({ resources: [{ uri: 'mem://a.txt', name: 'a.txt' }, { uri: 'mem://b.txt', name: 'b.txt' }], nextCursor: '2' });
    expect(await view.list('2', signal, caller)).toEqual({ resources: [] });
    expect(await view.templates(signal)).toEqual([]);
    expect(await view.read('mem://a.txt', signal, caller)).toEqual([{ uri: 'mem://a.txt', mimeType: 'text/plain', text: 'A' }]);
    expect(await view.read('mem://c.bin', signal, caller)).toBeUndefined();
    let updates = 0;
    const stopA = view.watch?.('mem://a.txt', () => { updates += 1; });
    const stopC = view.watch?.('mem://c.bin', () => { updates += 1; });
    expect(files.watching).toBe(1);
    files.write('mem://a.txt', 'A2');
    files.write('mem://c.bin', 'AAED');
    expect(updates).toBe(1);
    stopA?.();
    stopC?.();
    expect(files.watching).toBe(0);
  });

  it('passes on list changes and tells of a new filter; without watch or templates it has neither', async () => {
    const files = new MemoryFiles();
    const view = new McpResourceView(files);
    expect(await view.templates(signal)).toEqual([{ uriTemplate: 'mem://{name}', name: 'A memory file' }]);
    expect(await view.read('mem://c.bin', signal, caller)).toEqual([{ uri: 'mem://c.bin', mimeType: 'application/octet-stream', blob: 'AAEC' }]);
    let heard = 0;
    const stop = view.onChange(() => { heard += 1; });
    const other = view.onChange(() => undefined);
    files.changes.fire();
    view.setFilter({ uri: () => false });
    expect(heard).toBe(2);
    expect(await view.list(undefined, signal, caller)).toEqual({ resources: [], nextCursor: '2' });
    other();
    stop();
    expect(files.changes.size).toBe(0);

    const plain: McpResourceSource = { list: async () => ({ resources: [] }), read: async () => undefined };
    const bare = new McpResourceView(plain);
    expect(bare.watch).toBeUndefined();
    expect(await bare.templates(signal)).toEqual([]);
    bare.onChange(() => { heard += 1; })();
    const mcp = mcpSourceServer({ resources: bare });
    expect(await mcp.handle(rpc('initialize', { protocolVersion: '2025-06-18' }))).toMatchObject({ result: { capabilities: { resources: { subscribe: false, listChanged: true } } } });
  });
});

describe('McpToolUnion and McpPromptUnion', () => {
  it('offers several tool sources as one, the first owning a shared name', async () => {
    const first = new McpToolSet().define({ name: 'a', description: 'first', inputSchema: {}, run: () => textResult('1') });
    const second = new McpToolSet().define({ name: 'a', description: 'second', inputSchema: {}, run: () => textResult('2') })
      .define({ name: 'b', inputSchema: {}, run: () => textResult('2b') });
    const union = new McpToolUnion([first]);
    union.add(first);
    expect(union.sources).toEqual([first]);
    union.add(second); // nobody listens yet
    expect(union.tools().map((t) => `${t.name}:${t.description ?? ''}`)).toEqual(['a:first', 'b:']);
    expect(await union.call('a', {}, signal, caller)).toEqual(textResult('1'));
    expect(await union.call('b', {}, signal, caller)).toEqual(textResult('2b'));
    expect(await union.call('z', {}, signal, caller)).toBeUndefined();

    let heard = 0;
    const stop = union.onChange(() => { heard += 1; });
    second.define({ name: 'c', inputSchema: {}, run });
    expect(heard).toBe(1);
    const third: McpToolSource = new AddTool();
    union.add(third);
    expect(heard).toBe(2);
    expect(union.remove(second)).toBe(true);
    expect(union.remove(second)).toBe(false);
    expect(heard).toBe(3);
    second.define({ name: 'd', inputSchema: {}, run }); // no longer heard
    expect(heard).toBe(3);
    first.define({ name: 'e', inputSchema: {}, run });
    expect(heard).toBe(4);
    stop();
    first.define({ name: 'f', inputSchema: {}, run });
    expect(heard).toBe(4);
    expect(union.remove(third)).toBe(true);
    expect(new McpToolUnion().tools()).toEqual([]);
  });

  it('offers several prompt sources as one', async () => {
    const greetings = new Greetings();
    const extra: McpPromptSource = { prompts: () => [{ name: 'greet' }, { name: 'bye' }], get: async () => ({ messages: [] }) };
    const union = new McpPromptUnion([greetings, extra]);
    expect(union.sources).toHaveLength(2);
    expect(union.prompts().map((p) => p.name)).toEqual(['greet', 'ghost', 'bye']);
    expect(await union.get('greet', { name: 'Ada' }, signal, caller)).toMatchObject({ description: 'A greeting.' });
    expect(await union.get('bye', {}, signal, caller)).toEqual({ messages: [] });
    expect(await union.get('nope', {}, signal, caller)).toBeUndefined();
    let heard = 0;
    const stop = union.onChange(() => { heard += 1; });
    greetings.changes.fire();
    union.add(new McpPromptUnion());
    expect(union.remove(extra)).toBe(true);
    expect(union.remove(extra)).toBe(false);
    expect(heard).toBe(3);
    stop();
    expect(greetings.changes.size).toBe(0);
    expect(new McpPromptUnion().prompts()).toEqual([]);
  });

  it('views over a union: one endpoint per filter over shared sources', async () => {
    const union = new McpToolUnion([abc(), new AddTool()]);
    const claude = mcpSourceServer({ tools: new McpToolView(union, (t) => t.name === 'add') });
    const admin = mcpSourceServer({ tools: union });
    expect(await claude.handle(rpc('tools/list'))).toMatchObject({ result: { tools: [{ name: 'add' }] } });
    expect(await admin.handle(rpc('tools/list'))).toMatchObject({ result: { tools: [{ name: 'a' }, { name: 'b' }, { name: 'c' }, { name: 'add' }] } });
    expect(await claude.handle(rpc('tools/call', { name: 'add', arguments: { a: 1, b: 2 } }))).toMatchObject({ result: { content: [{ text: '3' }] } });
    expect(await claude.handle(rpc('tools/call', { name: 'a' }))).toMatchObject({ error: { code: -32602 } });
  });
});
