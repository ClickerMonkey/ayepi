/**
 * Many MCP endpoints behind one `fetch` handler: {@link McpRouter} serves each mounted {@link McpServer} over
 * Streamable HTTP at its own path, with its own options (its own authorizer, say). Endpoints are mounted and unmounted
 * while serving.
 *
 * @module
 */

import { mcpHttp, type McpHttpHandler, type McpHttpOptions } from './http';
import { JSON_RPC_ERRORS, rpcError, type McpServer } from './protocol';

/** Options for {@link McpRouter}. */
export interface McpRouterOptions {
  /** The path every route is under (default `''`, the root). A request outside it is `404`. */
  readonly base?: string;
  /** Options every route starts from; a route's own options override them. */
  readonly defaults?: McpHttpOptions;
}

/** A mounted endpoint. */
interface Route {
  readonly server: McpServer;
  readonly handler: McpHttpHandler;
}

/** A path with one leading `/` and no trailing `/` (`''` for the root). */
function normalize(path: string): string {
  const trimmed = path.replace(/^\/+|\/+$/g, '');
  return trimmed === '' ? '' : `/${trimmed}`;
}

/**
 * MCP endpoints by path. {@link McpRouter.mount} serves a server at a path, {@link McpRouter.unmount} stops (its
 * sessions end and its event streams close); a request to a path with no endpoint is `404`. Paths match exactly,
 * ignoring a trailing `/`. The router doesn't own the servers: closing one is its maker's job.
 *
 * @example
 * ```ts
 * const router = new McpRouter({ base: '/mcp' });
 * router.mount('claude', mcpSourceServer(sources), { authorize: new BearerAuth([{ secret, subject: 'claude' }]) });
 * http.createServer(createRequestListener(router)).listen(4400); // POST /mcp/claude
 * ```
 */
export class McpRouter {
  readonly #base: string;
  readonly #defaults: McpHttpOptions;
  readonly #routes = new Map<string, Route>();

  constructor(opts: McpRouterOptions = {}) {
    this.#base = normalize(opts.base ?? '');
    this.#defaults = opts.defaults ?? {};
  }

  /** Serve a server at a path under the base. One already there is unmounted first. */
  mount(path: string, server: McpServer, opts: McpHttpOptions = {}): void {
    const key = normalize(path);
    this.unmount(key);
    this.#routes.set(key, { server, handler: mcpHttp(server, { ...this.#defaults, ...opts }) });
  }

  /** Stop serving a path: its sessions end and its event streams close. `false` when nothing was there. */
  unmount(path: string): boolean {
    const key = normalize(path);
    const route = this.#routes.get(key);
    if (route === undefined) { return false; }
    this.#routes.delete(key);
    route.handler.close();
    return true;
  }

  /** The server at a path, if one is mounted there. */
  server(path: string): McpServer | undefined {
    return this.#routes.get(normalize(path))?.server;
  }

  /** The mounted paths, under the base, as normalized. */
  paths(): string[] {
    return [...this.#routes.keys()];
  }

  /** Answer one request: the endpoint at its path, or `404`. */
  fetch = async (request: Request): Promise<Response> => {
    const path = normalize(new URL(request.url).pathname);
    const inside = this.#base === '' || path === this.#base || path.startsWith(`${this.#base}/`);
    const route = inside ? this.#routes.get(path.slice(this.#base.length)) : undefined;
    if (route === undefined) {
      return new Response(JSON.stringify(rpcError(null, JSON_RPC_ERRORS.invalidRequest, `no MCP endpoint at ${path || '/'}`)), {
        status: 404, headers: { 'content-type': 'application/json' },
      });
    }
    return route.handler.fetch(request);
  };

  /** Unmount every endpoint. */
  close(): void {
    for (const path of this.paths()) { this.unmount(path); }
  }
}
