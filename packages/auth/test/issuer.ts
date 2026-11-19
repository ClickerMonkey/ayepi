/** A fake OpenID provider for tests: locally generated keys, signed tokens, and a `fetch` over its endpoints. */
import { base64urlEncode } from '../src/base64url';
import type { Jwk, JwsAlgorithm } from '../src/jwks';

/** A fetch over a table of URL → JSON answers (404 otherwise), recording each request. */
export function table(answers: Record<string, unknown>, seen: Request[] = []): typeof fetch {
  return async (input, init) => {
    const request = new Request(input, init);
    seen.push(request);
    const answer = answers[request.url];
    if (typeof answer === 'function') { return (answer as (request: Request) => Response | Promise<Response>)(request.clone()); }
    return answer === undefined ? new Response('missing', { status: 404 }) : Response.json(answer);
  };
}

const GENERATE: Record<JwsAlgorithm, RsaHashedKeyGenParams | EcKeyGenParams | AlgorithmIdentifier> = {
  RS256: { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
  ES256: { name: 'ECDSA', namedCurve: 'P-256' },
  EdDSA: { name: 'Ed25519' },
};
const SIGN: Record<JwsAlgorithm, AlgorithmIdentifier | EcdsaParams> = {
  RS256: { name: 'RSASSA-PKCS1-v1_5' },
  ES256: { name: 'ECDSA', hash: 'SHA-256' },
  EdDSA: { name: 'Ed25519' },
};

/** A signing key: its private half and its public JWK. */
export interface TestKey {
  readonly alg: JwsAlgorithm;
  readonly kid: string;
  readonly privateKey: CryptoKey;
  readonly jwk: Jwk;
}

/** Make a key pair for `alg`, with its public JWK (`kid`, `use: sig`, `alg`). */
export async function makeKey(alg: JwsAlgorithm, kid: string): Promise<TestKey> {
  const pair = await crypto.subtle.generateKey(GENERATE[alg], true, ['sign', 'verify']) as CryptoKeyPair;
  const { kty, n, e, crv, x, y } = await crypto.subtle.exportKey('jwk', pair.publicKey);
  const jwk: Jwk = { kty: kty!, kid, use: 'sig', alg };
  for (const [name, value] of Object.entries({ n, e, crv, x, y })) { if (value !== undefined) { (jwk as Record<string, string>)[name] = value; } }
  return { alg, kid, privateKey: pair.privateKey, jwk };
}

const json = (value: unknown): string => base64urlEncode(new TextEncoder().encode(JSON.stringify(value)));

/** Sign `payload` as a compact JWS with `key` (header fields can be overridden, `kid: undefined` drops it). */
export async function sign(key: TestKey, payload: unknown, header: Record<string, unknown> = {}): Promise<string> {
  const input = `${json({ alg: key.alg, typ: 'JWT', kid: key.kid, ...header })}.${json(payload)}`;
  const signature = await crypto.subtle.sign(SIGN[key.alg], key.privateKey, new TextEncoder().encode(input));
  return `${input}.${base64urlEncode(new Uint8Array(signature))}`;
}

export const ISSUER = 'https://idp.test';
export const CLIENT = 'client-1';
/** The fixed test clock, in epoch ms. */
export const NOW = 1_800_000_000_000;
export const NOW_SEC = NOW / 1000;

/** Standard ID token claims for {@link CLIENT} from {@link ISSUER}, at {@link NOW}. */
export function claims(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { iss: ISSUER, sub: 'user-1', aud: CLIENT, iat: NOW_SEC, exp: NOW_SEC + 300, nonce: 'n-1', ...extra };
}

/** The provider's discovery document. */
export function discovery(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    issuer: ISSUER,
    authorization_endpoint: `${ISSUER}/authorize`,
    token_endpoint: `${ISSUER}/token`,
    jwks_uri: `${ISSUER}/jwks`,
    userinfo_endpoint: `${ISSUER}/userinfo`,
    ...extra,
  };
}
