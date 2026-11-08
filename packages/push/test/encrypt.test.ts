import { describe, expect, it } from 'vitest';
import { decryptPush, encryptPush, fromBase64Url, MAX_PUSH_PAYLOAD, toBase64Url } from '../src/index';
import { sealRecord } from '../src/encrypt';

/** RFC 8291 Appendix A: the example message, with every key and the salt fixed. */
const RFC = {
  plaintext: 'V2hlbiBJIGdyb3cgdXAsIEkgd2FudCB0byBiZSBhIHdhdGVybWVsb24',
  senderPrivate: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw',
  senderPublic: 'BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8',
  receiverPrivate: 'q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94',
  receiverPublic: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
  salt: 'DGv6ra1nlYgDCS1FRnbzlw',
  auth: 'BTBZMqHH6r4Tts7J_aSIgg',
  body: 'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN',
};

const receiver = { p256dh: RFC.receiverPublic, auth: RFC.auth, privateKey: RFC.receiverPrivate };
const seed = { salt: fromBase64Url(RFC.salt), sender: { publicKey: RFC.senderPublic, privateKey: RFC.senderPrivate } };

/** A fresh browser-side key pair and auth secret. */
async function browser() {
  const pair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const p256dh = toBase64Url(new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey)));
  const jwk = await crypto.subtle.exportKey('jwk', pair.privateKey);
  return { p256dh, auth: toBase64Url(crypto.getRandomValues(new Uint8Array(16))), privateKey: jwk.d ?? '' };
}

describe('encryptPush / decryptPush', () => {
  it('reproduces the example of RFC 8291 byte for byte, and reads it back', async () => {
    const body = await encryptPush(fromBase64Url(RFC.plaintext), receiver, seed);
    expect(toBase64Url(body)).toBe(RFC.body);
    expect(toBase64Url(await decryptPush(fromBase64Url(RFC.body), receiver))).toBe(RFC.plaintext);
  });

  it('round-trips text with fresh keys and padding, and every message differs', async () => {
    const keys = await browser();
    const one = await encryptPush('hello ☃', keys, { padding: 30 });
    const two = await encryptPush('hello ☃', keys);
    expect(one.byteLength).toBe(two.byteLength + 30);
    expect(toBase64Url(one.subarray(0, 16))).not.toBe(toBase64Url(two.subarray(0, 16)));
    expect(new TextDecoder().decode(await decryptPush(one, keys))).toBe('hello ☃');
    expect(new TextDecoder().decode(await decryptPush(two, keys))).toBe('hello ☃');
    const largest = await encryptPush(new Uint8Array(MAX_PUSH_PAYLOAD), keys);
    expect((await decryptPush(largest, keys)).byteLength).toBe(MAX_PUSH_PAYLOAD);
  });

  it('refuses keys, salts and payloads of the wrong shape', async () => {
    const keys = await browser();
    await expect(encryptPush('x', keys, { padding: MAX_PUSH_PAYLOAD })).rejects.toThrow(`the payload is over ${MAX_PUSH_PAYLOAD} bytes`);
    await expect(encryptPush('x', { ...keys, p256dh: toBase64Url(new Uint8Array(65)) })).rejects.toThrow('the subscription key is not an uncompressed P-256 public key');
    await expect(encryptPush('x', { ...keys, p256dh: 'AAAA' })).rejects.toThrow('the subscription key is not');
    await expect(encryptPush('x', { ...keys, auth: 'AAAA' })).rejects.toThrow('the auth secret is not 16 bytes');
    await expect(encryptPush('x', keys, { salt: new Uint8Array(4) })).rejects.toThrow('the salt is not 16 bytes');
    await expect(encryptPush('x', keys, { sender: { publicKey: 'AAAA', privateKey: 'AAAA' } })).rejects.toThrow('the sender key is not');
  });

  it('refuses bodies it cannot open', async () => {
    const keys = await browser();
    const other = await browser();
    const body = await encryptPush('secret', keys);
    await expect(decryptPush(body, other)).rejects.toThrow();
    await expect(decryptPush(body, { ...other, p256dh: keys.p256dh, auth: keys.auth })).rejects.toThrow();
    await expect(decryptPush(body.subarray(0, 50), keys)).rejects.toThrow('the body is too short for aes128gcm');
    const badId = new Uint8Array(body);
    badId[20] = 64;
    await expect(decryptPush(badId, keys)).rejects.toThrow('the key id is not a P-256 public key');
    const small = new Uint8Array(body);
    new DataView(small.buffer).setUint32(16, 18);
    await expect(decryptPush(small, keys)).rejects.toThrow('the body holds more than one record');
    const tampered = new Uint8Array(body);
    tampered[tampered.length - 1] = (tampered[tampered.length - 1] ?? 0) ^ 1;
    await expect(decryptPush(tampered, keys)).rejects.toThrow('the body could not be decrypted with these keys');
    const undelimited = await sealRecord(new Uint8Array([104, 105, 0, 0]), keys, {});
    await expect(decryptPush(undelimited, keys)).rejects.toThrow('the record has no last-record delimiter');
  });
});
