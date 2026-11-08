import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  BearerAuth, McpClient, McpHttpClientTransport, McpRouter, McpToolSet, bearerToken, jsonResult, mcpHttp, mcpSourceServer, MCP_SESSION_HEADER,
  type McpAuthorizer,
} from '../src/index';
import { rpc } from './fixtures';

const post = (url: string, body: unknown, headers: Record<string, string> = {}) =>
  new Request(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
const initialize = rpc('initialize', { protocolVersion: '2025-06-18' });

/** A server with one tool, `whoami`, answering with the caller. */
function whoami() {
  const tools = new McpToolSet().define({
    name: 'whoami', args: z.object({}), run: (_args, { caller }) => jsonResult({ subject: caller.auth?.subject ?? null, scopes: caller.auth?.scopes ?? [] }),
  });
  return mcpSourceServer({ tools });
}

describe('bearer auth', () => {
  it('reads bearer tokens', () => {
    expect(bearerToken(new Request('http://x/'))).toBeUndefined();
    expect(bearerToken(new Request('http://x/', { headers: { authorization: 'Basic abc' } }))).toBeUndefined();
    expect(bearerToken(new Request('http://x/', { headers: { authorization: 'bearer  tok ' } }))).toBe('tok');
  });

  it('lets in the holders of its secrets, as their subjects, and can be given new ones', async () => {
    const auth = new BearerAuth([{ secret: 's1', subject: 'claude', scopes: ['tools'] }, { secret: 's2', subject: 'other' }], { realm: 'hub' });
    const asking = (token?: string) => new Request('http://x/', token === undefined ? {} : { headers: { authorization: `Bearer ${token}` } });
    expect(await auth.authorize(asking('s1'))).toEqual({ ok: true, auth: { subject: 'claude', scopes: ['tools'] } });
    expect(await auth.authorize(asking('s2'))).toEqual({ ok: true, auth: { subject: 'other', scopes: [] } });
    expect(await auth.authorize(asking())).toEqual({ ok: false, status: 401, message: 'a bearer token is required', challenge: 'Bearer realm="hub"' });
    expect(await auth.authorize(asking('nope'))).toMatchObject({ ok: false, status: 401, challenge: 'Bearer realm="hub", error="invalid_token"' });
    await auth.set([{ secret: 's3', subject: 'claude' }]);
    expect(await auth.authorize(asking('s1'))).toMatchObject({ ok: false });
    expect(await auth.authorize(asking('s3'))).toMatchObject({ ok: true });
    expect(await new BearerAuth([]).authorize(asking())).toMatchObject({ challenge: 'Bearer realm="mcp"' });
  });

  it('guards a Streamable HTTP endpoint and hands the caller to the sources', async () => {
    const endpoint = mcpHttp(whoami(), { authorize: new BearerAuth([{ secret: 'a', subject: 'alice' }, { secret: 'b', subject: 'bob' }]) });
    const refused = await endpoint.fetch(post('http://x/', initialize));
    expect(refused.status).toBe(401);
    expect(refused.headers.get('www-authenticate')).toBe('Bearer realm="mcp"');
    expect(await refused.json()).toMatchObject({ error: { message: 'a bearer token is required' } });

    const opened = await endpoint.fetch(post('http://x/', initialize, { authorization: 'Bearer a' }));
    const session = opened.headers.get(MCP_SESSION_HEADER) ?? '';
    const call = rpc('tools/call', { name: 'whoami' }, 2);
    const answer = await endpoint.fetch(post('http://x/', call, { authorization: 'Bearer a', [MCP_SESSION_HEADER]: session }));
    expect(await answer.json()).toMatchObject({ result: { structuredContent: { subject: 'alice' } } });
    // bob may call, but not in alice's session
    const stolen = await endpoint.fetch(post('http://x/', call, { authorization: 'Bearer b', [MCP_SESSION_HEADER]: session }));
    expect(stolen.status).toBe(404);
    endpoint.close();
  });

  it('answers a refusal without a challenge with its own status', async () => {
    const forbid: McpAuthorizer = { authorize: async () => ({ ok: false, status: 403, message: 'not for you' }) };
    const response = await mcpHttp(whoami(), { authorize: forbid }).fetch(post('http://x/', initialize));
    expect(response.status).toBe(403);
    expect(response.headers.get('www-authenticate')).toBeNull();
  });
});

describe('McpRouter', () => {
  it('serves each endpoint at its path, under its base, with its own auth', async () => {
    const router = new McpRouter({ base: '/mcp/', defaults: { maxBody: 10_000 } });
    router.mount('/claude/', whoami(), { authorize: new BearerAuth([{ secret: 'c', subject: 'claude' }]) });
    router.mount('open', whoami());
    router.mount('', whoami());
    expect(router.paths()).toEqual(['/claude', '/open', '']);
    expect(router.server('claude/')).toBeDefined();
    expect(router.server('nope')).toBeUndefined();

    expect((await router.fetch(post('http://x/mcp/claude', initialize))).status).toBe(401);
    expect((await router.fetch(post('http://x/mcp/claude/', initialize, { authorization: 'Bearer c' }))).status).toBe(200);
    expect((await router.fetch(post('http://x/mcp/open', initialize))).status).toBe(200);
    expect((await router.fetch(post('http://x/mcp', initialize))).status).toBe(200);
    const missing = await router.fetch(post('http://x/mcp/gone', initialize));
    expect(missing.status).toBe(404);
    expect(await missing.json()).toMatchObject({ error: { message: 'no MCP endpoint at /mcp/gone' } });
    expect((await router.fetch(post('http://x/other/open', initialize))).status).toBe(404);
    expect((await router.fetch(post('http://x/mcpopen', initialize))).status).toBe(404);
    expect((await router.fetch(post('http://x/', initialize))).status).toBe(404);
    const big = await router.fetch(post('http://x/mcp/open', { pad: 'x'.repeat(20_000) }));
    expect(big.status).toBe(413);

    expect(router.unmount('open')).toBe(true);
    expect(router.unmount('open')).toBe(false);
    expect((await router.fetch(post('http://x/mcp/open', initialize))).status).toBe(404);
    router.close();
    expect(router.paths()).toEqual([]);
  });

  it('serves the root when it has no base, and ends the sessions of an endpoint mounted over', async () => {
    const router = new McpRouter();
    router.mount('a', whoami());
    expect((await router.fetch(post('http://x/', initialize))).status).toBe(404);
    const client = await McpClient.connect(new McpHttpClientTransport('http://x/a', { fetch: async (input, init) => router.fetch(new Request(input, init)), events: false }), {
      clientInfo: { name: 'test', version: '1' },
    });
    expect(await client.callToolAs('whoami', {}, z.object({ subject: z.null() }))).toEqual({ subject: null });
    router.mount('a', whoami());
    await expect(client.ping()).rejects.toThrow('unknown or ended session');
    await client.close();
  });
});
