/**
 * Who may call an MCP endpoint: an {@link McpAuthorizer} checks each HTTP request before the transport reads it, and
 * names the caller ({@link McpAuthInfo}) the sources then see. {@link BearerAuth} is the one for shared secrets: each
 * secret names a subject and its scopes, and secrets can be replaced while serving (rotation, revocation).
 *
 * @module
 */

import type { McpAuthInfo } from './protocol';

/** What an authorizer decided: the caller, or the refusal the transport answers with. */
export type McpAuthDecision =
  | { readonly ok: true; readonly auth: McpAuthInfo }
  | {
    readonly ok: false;
    /** `401` when the caller isn't known, `403` when it is but may not call. */
    readonly status: 401 | 403;
    readonly message: string;
    /** The `WWW-Authenticate` header of a `401`. */
    readonly challenge?: string;
  };

/** Checks who is calling, once per HTTP request. */
export interface McpAuthorizer {
  /** Decide on one request from its headers. It must not read the body. */
  authorize(request: Request): Promise<McpAuthDecision>;
}

/** One secret a {@link BearerAuth} accepts, and who holds it. */
export interface BearerSecret {
  /** The token the caller sends as `Authorization: Bearer <secret>`. */
  readonly secret: string;
  /** Who holds it. */
  readonly subject: string;
  /** What its holder may do (default none). */
  readonly scopes?: readonly string[];
}

/** The token of an `Authorization: Bearer <token>` header, or `undefined` when there is none. */
export function bearerToken(request: Request): string | undefined {
  const header = request.headers.get('authorization');
  const match = header === null ? null : /^bearer\s+(\S+)\s*$/i.exec(header);
  return match?.[1];
}

/** A secret's SHA-256 as hex: secrets are kept and looked up by digest, so a lookup never compares secrets themselves. */
async function digest(secret: string): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(secret)));
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * Bearer-secret auth: a request passes when its `Authorization: Bearer <token>` is one of the secrets, and its caller
 * is that secret's subject and scopes. A request without a token, or with an unknown one, is `401` with a
 * `WWW-Authenticate: Bearer` challenge. {@link BearerAuth.set} replaces the secrets; requests already let in finish.
 *
 * @example
 * ```ts
 * const auth = new BearerAuth([{ secret: process.env.MCP_SECRET!, subject: 'claude' }]);
 * const endpoint = mcpHttp(server, { authorize: auth });
 * ```
 */
export class BearerAuth implements McpAuthorizer {
  readonly #realm: string;
  #secrets: Promise<ReadonlyMap<string, McpAuthInfo>>;

  /** `realm` names the protected endpoint in the challenge (default `mcp`). */
  constructor(secrets: readonly BearerSecret[], opts: { readonly realm?: string } = {}) {
    this.#realm = opts.realm ?? 'mcp';
    this.#secrets = BearerAuth.#index(secrets);
  }

  /** Replace the secrets accepted. Resolves once later requests are checked against them. */
  async set(secrets: readonly BearerSecret[]): Promise<void> {
    const next = BearerAuth.#index(secrets);
    this.#secrets = next;
    await next;
  }

  async authorize(request: Request): Promise<McpAuthDecision> {
    const token = bearerToken(request);
    if (token === undefined) { return { ok: false, status: 401, message: 'a bearer token is required', challenge: `Bearer realm="${this.#realm}"` }; }
    const auth = (await this.#secrets).get(await digest(token));
    if (auth === undefined) { return { ok: false, status: 401, message: 'the bearer token is not valid', challenge: `Bearer realm="${this.#realm}", error="invalid_token"` }; }
    return { ok: true, auth };
  }

  static async #index(secrets: readonly BearerSecret[]): Promise<ReadonlyMap<string, McpAuthInfo>> {
    const entries = await Promise.all(secrets.map(async (s): Promise<[string, McpAuthInfo]> => [await digest(s.secret), { subject: s.subject, scopes: [...s.scopes ?? []] }]));
    return new Map(entries);
  }
}
