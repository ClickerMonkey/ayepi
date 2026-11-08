/**
 * Bytes: unpadded base64url (the encoding web push uses for every key and the JWT), joining, and the P-256 keys
 * WebCrypto imports from them.
 *
 * @module
 */

/** Bytes WebCrypto takes (backed by a plain `ArrayBuffer`). */
export type Bytes = Uint8Array<ArrayBuffer>;

/** Bytes as unpadded base64url. */
export function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) { binary += String.fromCharCode(byte); }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Base64url (padded or not; plain base64 is read too) as bytes. Throws for text that isn't base64. */
export function fromBase64Url(text: string): Bytes {
  const plain = text.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(plain + '='.repeat((4 - (plain.length % 4)) % 4));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) { bytes[i] = binary.charCodeAt(i); }
  return bytes;
}

/** Several byte arrays as one. */
export function concat(...parts: readonly Uint8Array[]): Bytes {
  const out = new Uint8Array(parts.reduce((size, part) => size + part.byteLength, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.byteLength;
  }
  return out;
}

/** UTF-8 bytes of text. */
export function utf8(text: string): Bytes {
  return new TextEncoder().encode(text);
}

/** The length of an uncompressed P-256 public key: `0x04 || x || y`. */
export const P256_PUBLIC_LENGTH = 65;

/** Check an uncompressed P-256 public key's shape, naming it in the error. */
export function publicKeyBytes(publicKey: string, what: string): Bytes {
  const bytes = fromBase64Url(publicKey);
  if (bytes.byteLength !== P256_PUBLIC_LENGTH || bytes[0] !== 0x04) { throw new Error(`${what} is not an uncompressed P-256 public key`); }
  return bytes;
}

/** A P-256 private key as a JWK, from its scalar `d` and its public key (which gives `x` and `y`). */
export function privateJwk(privateKey: string, publicKey: Bytes): JsonWebKey {
  return {
    kty: 'EC',
    crv: 'P-256',
    d: privateKey,
    x: toBase64Url(publicKey.subarray(1, 33)),
    y: toBase64Url(publicKey.subarray(33, 65)),
    ext: true,
  };
}
