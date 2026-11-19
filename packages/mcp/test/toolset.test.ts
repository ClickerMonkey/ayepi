import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { withJsonSchema } from '@ayepi/core';
import {
  MCP_TOOL_NAME, McpToolSet, invalidArgumentsResult, jsonResult, mcpToolName, mcpToolServer, textResult,
  type McpCaller,
} from '../src/index';
import { rpc } from './fixtures';

const caller: McpCaller = { session: 's', auth: undefined };
const signal = new AbortController().signal;

describe('McpToolSet', () => {
  it('defines tools from zod schemas, checks and parses their arguments, and lists their faces', async () => {
    const set = new McpToolSet().define({
      name: 'add',
      title: 'Add',
      description: 'Add two numbers.',
      outputSchema: { type: 'object' },
      annotations: { readOnlyHint: true, idempotentHint: true },
      args: z.object({ a: z.number(), b: z.number().default(10) }),
      run: ({ a, b }, context) => jsonResult({ sum: a + b, session: context.caller.session }),
    });
    expect(set.tools()).toEqual([{
      name: 'add', title: 'Add', description: 'Add two numbers.', outputSchema: { type: 'object' }, annotations: { readOnlyHint: true, idempotentHint: true },
      inputSchema: expect.objectContaining({ type: 'object', properties: { a: { type: 'number' }, b: { type: 'number', default: 10 } }, required: ['a'] }),
    }]);
    expect(await set.call('add', { a: 1 }, signal, caller)).toEqual({
      content: [{ type: 'text', text: '{"sum":11,"session":"s"}' }], structuredContent: { sum: 11, session: 's' },
    });
    const bad = await set.call('add', { a: 'one' }, signal, caller);
    expect(bad?.isError).toBe(true);
    expect(bad?.content[0]).toMatchObject({ type: 'text', text: expect.stringContaining('invalid arguments for tool "add"') });
    expect(await set.call('nope', {}, signal, caller)).toBeUndefined();
  });

  it('a zod tool lists the JSON Schema a custom argument supplies', () => {
    const def = withJsonSchema(z.custom<{ name: string }>((v) => typeof v === 'object'), { type: 'object', properties: { name: { type: 'string' } } });
    const set = new McpToolSet().define({ name: 'make', args: z.object({ def }), run: () => textResult('') });
    expect(set.tools()[0]!.inputSchema).toMatchObject({ properties: { def: { type: 'object', properties: { name: { type: 'string' } } } } });
  });

  it('defines tools from JSON Schema, checked as zod reads it, or listed only', async () => {
    const set = new McpToolSet()
      .define({
        name: 'echo',
        inputSchema: { type: 'object', properties: { text: { type: 'string', minLength: 1 } }, required: ['text'], additionalProperties: false },
        run: (args) => jsonResult(args),
      })
      .define({ name: 'loose', inputSchema: { $ref: '#/$defs/missing' }, validate: false, run: (args) => textResult(JSON.stringify(args)) });
    expect(set.tools().map((t) => t.inputSchema)).toEqual([
      { type: 'object', properties: { text: { type: 'string', minLength: 1 } }, required: ['text'], additionalProperties: false },
      { $ref: '#/$defs/missing' },
    ]);
    expect(await set.call('echo', { text: 'hi' }, signal, caller)).toMatchObject({ structuredContent: { text: 'hi' } });
    expect(await set.call('echo', { text: '' }, signal, caller)).toMatchObject({ isError: true });
    expect(await set.call('echo', { text: 'x', extra: 1 }, signal, caller)).toMatchObject({ isError: true });
    expect(await set.call('loose', { anything: 1 }, signal, caller)).toEqual(textResult('{"anything":1}'));
    expect(() => set.define({ name: 'broken', inputSchema: { $ref: 'http://elsewhere/x.json' }, run: () => textResult('') })).toThrow(/input schema of tool "broken" can't be checked: External \$ref/);
    expect(() => set.define({ name: 'bad name!', inputSchema: {}, run: () => textResult('') })).toThrow(/not an MCP tool name/);
    expect(set.has('broken')).toBe(false);
  });

  it('tells listeners of each change, and of a batch once', async () => {
    const set = new McpToolSet();
    let heard = 0;
    const stop = set.onChange(() => { heard += 1; });
    const run = () => textResult('');
    set.define({ name: 'a', inputSchema: {}, run });
    expect(heard).toBe(1);
    expect(set.remove('a')).toBe(true);
    expect(set.remove('a')).toBe(false);
    expect(heard).toBe(2);
    set.clear();
    expect(heard).toBe(2);
    set.batch((s) => {
      s.define({ name: 'a', inputSchema: {}, run }).define({ name: 'b', inputSchema: {}, run });
      s.batch((inner) => { inner.remove('a'); });
      expect(heard).toBe(2);
    });
    expect(heard).toBe(3);
    expect(set.tools().map((t) => t.name)).toEqual(['b']);
    set.batch(() => undefined);
    expect(heard).toBe(3);
    expect(() => set.batch((s) => { s.clear(); throw new Error('half way'); })).toThrow('half way');
    expect(heard).toBe(4);
    stop();
    set.define({ name: 'c', inputSchema: {}, run });
    expect(heard).toBe(4);
  });

  it('serves its tools, sends list_changed, and answers invalid arguments as an isError result', async () => {
    const set = new McpToolSet();
    const mcp = mcpToolServer(set);
    const notes: string[] = [];
    mcp.onNotification((message) => { notes.push(message.method); });
    expect(await mcp.handle(rpc('initialize', { protocolVersion: '2025-06-18' }))).toMatchObject({ result: { capabilities: { tools: { listChanged: true } } } });
    set.define({ name: 'fail', args: z.object({}), run: () => { throw new Error('boom'); } });
    expect(notes).toEqual(['notifications/tools/list_changed']);
    expect(await mcp.handle(rpc('tools/call', { name: 'fail' }))).toMatchObject({ result: { isError: true, content: [{ text: 'boom' }] } });
    expect(await mcp.handle(rpc('tools/call', { name: 'fail', arguments: [] }))).toMatchObject({ error: { code: -32602 } });
  });
});

describe('tool names and results', () => {
  it('makes MCP tool names from any text', () => {
    expect(mcpToolName('fs/bash run')).toBe('fs_bash_run');
    expect(mcpToolName('')).toBe('_');
    expect(mcpToolName('x'.repeat(200))).toHaveLength(128);
    expect(MCP_TOOL_NAME.test(mcpToolName('héllo.wörld'))).toBe(true);
  });

  it('carries JSON values, structured when they are objects', () => {
    expect(jsonResult([1])).toEqual({ content: [{ type: 'text', text: '[1]' }] });
    expect(jsonResult(undefined)).toEqual({ content: [{ type: 'text', text: 'null' }] });
    expect(jsonResult(null)).toEqual({ content: [{ type: 'text', text: 'null' }] });
    expect(jsonResult(3)).toEqual({ content: [{ type: 'text', text: '3' }] });
    expect(jsonResult({ a: 1 })).toEqual({ content: [{ type: 'text', text: '{"a":1}' }], structuredContent: { a: 1 } });
    const error = z.object({ a: z.string() }).safeParse({}).error;
    expect(error).toBeDefined();
    if (error !== undefined) { expect(invalidArgumentsResult('t', error)).toMatchObject({ isError: true, content: [{ text: expect.stringContaining('→ at a') }] }); }
  });
});
