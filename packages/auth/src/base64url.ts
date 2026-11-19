/**
 * Base64url (RFC 4648 §5, unpadded) over `btoa`/`atob`, so the OAuth/OIDC client stays web-standard (no `Buffer`).
 *
 * @module
 */

/** Encode bytes as unpadded base64url. */
export function base64urlEncode(bytes: Uint8Array): string {
  let text = '';
  for (const byte of bytes) { text += String.fromCharCode(byte); }
  return btoa(text).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Decode unpadded (or padded) base64url to bytes. Throws on characters outside the alphabet. */
export function base64urlDecode(text: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]*=*$/.test(text)) { throw new TypeError('not base64url'); }
  const binary = atob(text.replace(/-/g, '+').replace(/_/g, '/').replace(/=+$/, ''));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) { bytes[i] = binary.charCodeAt(i); }
  return bytes;
}

/** Decode a base64url segment holding UTF-8 JSON. Throws when it isn't. */
export function base64urlJson(text: string): unknown {
  return JSON.parse(new TextDecoder().decode(base64urlDecode(text)));
}
