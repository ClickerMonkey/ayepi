/**
 * VAPID (RFC 8292): the application server's key pair, and the signed `Authorization` header that identifies it to a
 * push service.
 *
 * @module
 */

import { z } from 'zod';
import { privateJwk, publicKeyBytes, toBase64Url, utf8 } from './bytes';
import type { VapidDetails, VapidKeys } from './shapes';

const ECDSA: EcKeyImportParams = { name: 'ECDSA', namedCurve: 'P-256' };

/** An exported P-256 private key: its scalar is what a VAPID private key is. */
const PrivateJwk = z.object({ d: z.string() });

/** The longest a VAPID token may be valid: 24 hours, in seconds (RFC 8292 §2). */
export const MAX_VAPID_LIFETIME = 24 * 60 * 60;
/** How long a token is made valid for by default: 12 hours, in seconds. */
export const DEFAULT_VAPID_LIFETIME = 12 * 60 * 60;

/** Make a VAPID key pair (P-256), base64url as browsers and push services expect. */
export async function generateVapidKeys(): Promise<VapidKeys> {
  const pair = await crypto.subtle.generateKey(ECDSA, true, ['sign', 'verify']);
  const publicKey = toBase64Url(new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey)));
  const { d } = PrivateJwk.parse(await crypto.subtle.exportKey('jwk', pair.privateKey));
  return { publicKey, privateKey: d };
}

/** Options for {@link vapidAuthorization}. */
export interface VapidOptions {
  /** How long the token is valid, in seconds (default 12 hours; at most 24). */
  readonly lifetime?: number;
  /** The time now, in ms since the epoch (default `Date.now()`). */
  readonly now?: number;
}

/**
 * The `Authorization` header value for a push to `endpoint`: `vapid t=<ES256 JWT>, k=<public key>`, where the JWT
 * names the endpoint's origin as `aud`, the subject as `sub`, and expires after `lifetime`.
 */
export async function vapidAuthorization(endpoint: string, vapid: VapidDetails, opts: VapidOptions = {}): Promise<string> {
  const lifetime = opts.lifetime ?? DEFAULT_VAPID_LIFETIME;
  if (lifetime <= 0 || lifetime > MAX_VAPID_LIFETIME) { throw new Error(`a VAPID token lives more than 0 and at most ${MAX_VAPID_LIFETIME} seconds`); }
  const publicKey = publicKeyBytes(vapid.publicKey, 'the VAPID public key');
  const key = await crypto.subtle.importKey('jwk', privateJwk(vapid.privateKey, publicKey), ECDSA, false, ['sign']);
  const exp = Math.floor((opts.now ?? Date.now()) / 1000) + lifetime;
  const header = toBase64Url(utf8(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const claims = toBase64Url(utf8(JSON.stringify({ aud: new URL(endpoint).origin, exp, sub: vapid.subject })));
  const signature = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, utf8(`${header}.${claims}`)));
  return `vapid t=${header}.${claims}.${toBase64Url(signature)}, k=${vapid.publicKey}`;
}
