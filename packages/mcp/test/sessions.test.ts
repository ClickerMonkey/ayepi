import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  BearerAuth, McpRouter, McpToolSet, jsonResult, mcpHttp, mcpSourceServer, MCP_SESSION_HEADER,
  type McpHttpOptions, type McpHttpSession, type McpSessionEndReason,
} from '../src/index';
import { rpc } from './fixtures';

const URL_ = 'http://mcp.test/';
const post = (body: unknown, headers: Record<string, string> = {}) =>
  new Request(URL_, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
const initialize = rpc('initialize', { protocolVersion: '2025-06-18', clientInfo: { name: 'claude-code', version: '2.0' } });

/** A server with a `wait` tool that answers once `release` is called, and a spy on its `endSession`. */
function waiting() {
  let release: () => void = () => undefined;
  const tools = new McpToolSet().define({
    name: 'wait', args: z.object({}),
    run: () => new Promise((resolve) => { release = () => { resolve(jsonResult({ ok: true })); }; }),
  });
  const server = mcpSourceServer({ tools });
  const endSession = vi.spyOn(server, 'endSession');
  return { server, endSession, release: () => { release(); } };
}

/** The hooks of an endpoint, recording what they hear. */
function hooks() {
  const opened: McpHttpSession[] = [];
  const ended: Array<[string, McpSessionEndReason]> = [];
  const opts: Pick<McpHttpOptions, 'onSessionOpened' | 'onSessionEnded'> = {
    onSessionOpened: (session) => { opened.push(session); },
    onSessionEnded: (session, reason) => { ended.push([session.id, reason]); },
  };
  return { opened, ended, opts };
}

describe('Streamable HTTP session lifecycle', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('tells the hooks who opened a session, and that DELETE ended it', async () => {
    const { opened, ended, opts } = hooks();
    const http = mcpHttp(mcpSourceServer({}), { ...opts, sessionId: () => 's1', authorize: new BearerAuth([{ secret: 'k', subject: 'claude' }]) });
    const auth = { authorization: 'Bearer k' };
    expect((await http.fetch(post(initialize, auth))).headers.get(MCP_SESSION_HEADER)).toBe('s1');
    expect(opened).toEqual([{ id: 's1', auth: { subject: 'claude', scopes: [] }, client: { name: 'claude-code', version: '2.0' } }]);
    expect((await http.fetch(new Request(URL_, { method: 'DELETE', headers: { ...auth, [MCP_SESSION_HEADER]: 's1' } }))).status).toBe(204);
    expect(ended).toEqual([['s1', 'deleted']]);
    http.close();
    expect(ended).toHaveLength(1);
  });

  it('opens a session with no client when initialize names none, or has bad params', async () => {
    const { opened, opts } = hooks();
    let next = 0;
    const http = mcpHttp(mcpSourceServer({}), { ...opts, sessionId: () => `s${++next}` });
    await http.fetch(post(rpc('initialize', { protocolVersion: '2025-06-18' })));
    await http.fetch(post([rpc('ping', undefined, 7), rpc('initialize', { clientInfo: 'nope' })]));
    expect(opened).toEqual([{ id: 's1', auth: undefined, client: undefined }, { id: 's2', auth: undefined, client: undefined }]);
    http.close();
  });

  it('ends a session left idle past idleTimeout, and its subscriptions with it', async () => {
    const { server, endSession } = waiting();
    const { ended, opts } = hooks();
    const http = mcpHttp(server, { ...opts, idleTimeout: 1000, sessionId: () => 's1' });
    await http.fetch(post(initialize));
    const session = { [MCP_SESSION_HEADER]: 's1' };
    vi.advanceTimersByTime(900);
    expect((await http.fetch(post(rpc('ping'), session))).status).toBe(200);
    vi.advanceTimersByTime(900);
    expect(ended).toEqual([]);
    vi.advanceTimersByTime(100);
    expect(ended).toEqual([['s1', 'idle']]);
    expect(endSession).toHaveBeenCalledWith('s1');
    expect((await http.fetch(post(rpc('ping'), session))).status).toBe(404);
    http.close();
    expect(ended).toHaveLength(1);
  });

  it('keeps a session while a request is in progress, and counts from when it is answered', async () => {
    const { server, release } = waiting();
    const { ended, opts } = hooks();
    const http = mcpHttp(server, { ...opts, idleTimeout: 1000, sessionId: () => 's1' });
    await http.fetch(post(initialize));
    const answer = http.fetch(post(rpc('tools/call', { name: 'wait' }, 2), { [MCP_SESSION_HEADER]: 's1' }));
    await vi.advanceTimersByTimeAsync(5000);
    expect(ended).toEqual([]);
    release();
    expect((await answer).status).toBe(200);
    await vi.advanceTimersByTimeAsync(999);
    expect(ended).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(ended).toEqual([['s1', 'idle']]);
  });

  it('keeps a session while an event stream is open, and counts from when it closes', async () => {
    const { ended, opts } = hooks();
    const http = mcpHttp(mcpSourceServer({}), { ...opts, idleTimeout: 1000, sessionId: () => 's1' });
    await http.fetch(post(initialize));
    const controller = new AbortController();
    const stream = await http.fetch(new Request(URL_, { headers: { [MCP_SESSION_HEADER]: 's1', accept: 'text/event-stream' }, signal: controller.signal }));
    const reader = stream.body!.getReader();
    await reader.read();
    await vi.advanceTimersByTimeAsync(5000);
    expect(ended).toEqual([]);
    controller.abort();
    await vi.advanceTimersByTimeAsync(1000);
    expect(ended).toEqual([['s1', 'idle']]);
  });

  it('does not rest a session that ended while a request or a stream was using it', async () => {
    const { server, release } = waiting();
    const { ended, opts } = hooks();
    const http = mcpHttp(server, { ...opts, idleTimeout: 1000, sessionId: () => 's1' });
    await http.fetch(post(initialize));
    const session = { [MCP_SESSION_HEADER]: 's1' };
    const controller = new AbortController();
    await http.fetch(new Request(URL_, { headers: { ...session, accept: 'text/event-stream' }, signal: controller.signal }));
    const answer = http.fetch(post(rpc('tools/call', { name: 'wait' }, 2), session));
    await vi.advanceTimersByTimeAsync(0);
    await http.fetch(new Request(URL_, { method: 'DELETE', headers: session }));
    controller.abort();
    release();
    await answer;
    await vi.advanceTimersByTimeAsync(5000);
    expect(ended).toEqual([['s1', 'deleted']]);
  });

  it('ends open sessions as closed when the endpoint closes or its route is unmounted', async () => {
    const { ended, opts } = hooks();
    const http = mcpHttp(mcpSourceServer({}), { ...opts, idleTimeout: 1000, sessionId: () => 's1' });
    await http.fetch(post(initialize));
    http.close();
    expect(ended).toEqual([['s1', 'closed']]);
    await vi.advanceTimersByTimeAsync(5000);
    expect(ended).toHaveLength(1);

    const routed = hooks();
    const router = new McpRouter({ defaults: { idleTimeout: 1000, sessionId: () => 'r1' } });
    router.mount('a', mcpSourceServer({}), routed.opts);
    await router.fetch(new Request('http://x/a', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(initialize) }));
    expect(routed.opened.map((s) => s.id)).toEqual(['r1']);
    router.unmount('a');
    expect(routed.ended).toEqual([['r1', 'closed']]);
  });
});
