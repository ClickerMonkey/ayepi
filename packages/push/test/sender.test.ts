import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PUSH_TTL, MAX_VAPID_LIFETIME, PushSubscription, VapidDetails, WebPush, decryptPush, fromBase64Url, generateVapidKeys, toBase64Url, vapidAuthorization,
} from '../src/index';

/** A fresh browser subscription at an endpoint, with its private key for reading pushes. */
async function subscribe(endpoint = 'https://push.example.com/send/abc') {
  const pair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const p256dh = toBase64Url(new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey)));
  const jwk = await crypto.subtle.exportKey('jwk', pair.privateKey);
  const subscription = PushSubscription.parse({ endpoint, expirationTime: null, keys: { p256dh, auth: toBase64Url(crypto.getRandomValues(new Uint8Array(16))) } });
  return { subscription, privateKey: jwk.d ?? '' };
}

/** Read a VAPID header: its JWT parts, checked against the public key. */
async function readVapid(header: string) {
  const match = /^vapid t=([^.]+)\.([^.]+)\.([^,]+), k=(.+)$/.exec(header);
  if (match === null) { throw new Error(`not a VAPID header: ${header}`); }
  const [, head = '', claims = '', signature = '', k = ''] = match;
  const key = await crypto.subtle.importKey('raw', fromBase64Url(k), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
  const valid = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, fromBase64Url(signature), new TextEncoder().encode(`${head}.${claims}`));
  const decode = (part: string): unknown => JSON.parse(new TextDecoder().decode(fromBase64Url(part)));
  return { valid, k, header: decode(head), claims: decode(claims) };
}

/** A push service in memory: it records each request and answers with the next status. */
function service(statuses: number[]) {
  const requests: Request[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    requests.push(request);
    const status = statuses.shift() ?? 201;
    return new Response(status === 201 ? '' : `status ${status}`, { status });
  };
  return { fetch, requests };
}

describe('VAPID', () => {
  it('makes key pairs and signs headers push services can check', async () => {
    const keys = await generateVapidKeys();
    expect(fromBase64Url(keys.publicKey).byteLength).toBe(65);
    expect(fromBase64Url(keys.privateKey).byteLength).toBe(32);
    const vapid = VapidDetails.parse({ ...keys, subject: 'mailto:ops@example.com' });
    const header = await vapidAuthorization('https://push.example.com:8443/send/x?y=1', vapid, { now: 1_000_000, lifetime: 60 });
    expect(await readVapid(header)).toEqual({
      valid: true, k: keys.publicKey, header: { typ: 'JWT', alg: 'ES256' }, claims: { aud: 'https://push.example.com:8443', exp: 1060, sub: 'mailto:ops@example.com' },
    });
    const later = await readVapid(await vapidAuthorization('https://a.example/', vapid));
    expect(later.claims).toMatchObject({ exp: expect.any(Number) });
    await expect(vapidAuthorization('https://a.example/', vapid, { lifetime: MAX_VAPID_LIFETIME + 1 })).rejects.toThrow('a VAPID token lives');
    await expect(vapidAuthorization('https://a.example/', vapid, { lifetime: 0 })).rejects.toThrow('a VAPID token lives');
    await expect(vapidAuthorization('https://a.example/', { ...vapid, publicKey: 'AAAA' })).rejects.toThrow('the VAPID public key is not');
    expect(VapidDetails.safeParse({ ...keys, subject: 'ops@example.com' }).success).toBe(false);
  });
});

describe('WebPush', () => {
  it('posts the payload encrypted for the subscription, signed, with its headers', async () => {
    const keys = await generateVapidKeys();
    const { fetch, requests } = service([201]);
    const push = new WebPush({ vapid: { ...keys, subject: 'https://example.com/contact' }, fetch, now: () => 5_000_000, defaults: { urgency: 'low' } });
    expect(push.publicKey).toBe(keys.publicKey);
    const { subscription, privateKey } = await subscribe();
    const result = await push.send(subscription, '{"title":"Hi"}', { ttl: 90.7, topic: 'news', padding: 8 });
    expect(result).toEqual({ status: 201, ok: true, gone: false, body: '' });
    const [request] = requests;
    expect(request?.method).toBe('POST');
    expect(request?.url).toBe(subscription.endpoint);
    expect(Object.fromEntries(request?.headers ?? [])).toMatchObject({
      'content-encoding': 'aes128gcm', 'content-type': 'application/octet-stream', ttl: '90', urgency: 'low', topic: 'news',
    });
    const vapid = await readVapid(request?.headers.get('authorization') ?? '');
    expect(vapid).toMatchObject({ valid: true, claims: { aud: 'https://push.example.com', exp: 5000 + 12 * 60 * 60, sub: 'https://example.com/contact' } });
    const body = new Uint8Array(await request?.arrayBuffer() ?? new ArrayBuffer(0));
    expect(new TextDecoder().decode(await decryptPush(body, { ...subscription.keys, privateKey }))).toBe('{"title":"Hi"}');
  });

  it('reuses a token per push service for half its lifetime', async () => {
    const keys = await generateVapidKeys();
    const { fetch, requests } = service([]);
    let now = 0;
    const push = new WebPush({ vapid: { ...keys, subject: 'mailto:a@b.c' }, fetch, now: () => now, tokenLifetime: 100 });
    const a = await subscribe('https://one.example/a');
    const b = await subscribe('https://two.example/b');
    await push.send(a.subscription, 'x');
    now = 49_000;
    await push.send(a.subscription, new Uint8Array([1, 2]));
    await push.send(b.subscription, 'x');
    now = 50_000;
    await push.send(a.subscription, 'x');
    const tokens = requests.map((r) => r.headers.get('authorization'));
    expect(tokens[0]).toBe(tokens[1]);
    expect(tokens[2]).not.toBe(tokens[0]);
    expect(tokens[3]).not.toBe(tokens[0]);
    expect(requests.map((r) => r.headers.get('ttl'))).toEqual([String(DEFAULT_PUSH_TTL), String(DEFAULT_PUSH_TTL), String(DEFAULT_PUSH_TTL), String(DEFAULT_PUSH_TTL)]);
    expect(requests[0]?.headers.get('urgency')).toBeNull();
    expect(requests[0]?.headers.get('topic')).toBeNull();
  });

  it('answers with what the service said: gone, refused, or a default TTL; and refuses a bad topic', async () => {
    const keys = await generateVapidKeys();
    const { fetch, requests } = service([410, 404, 413]);
    const push = new WebPush({ vapid: { ...keys, subject: 'mailto:a@b.c' }, fetch, defaults: { ttl: 60 } });
    const { subscription } = await subscribe();
    expect(await push.send(subscription, 'x')).toEqual({ status: 410, ok: false, gone: true, body: 'status 410' });
    expect(await push.send(subscription, 'x', { urgency: 'high', ttl: -5 })).toMatchObject({ status: 404, gone: true });
    expect(await push.send(subscription, 'x', { signal: new AbortController().signal })).toEqual({ status: 413, ok: false, gone: false, body: 'status 413' });
    expect(requests.map((r) => [r.headers.get('ttl'), r.headers.get('urgency')])).toEqual([['60', null], ['0', 'high'], ['60', null]]);
    await expect(push.send(subscription, 'x', { topic: 'has spaces' })).rejects.toThrow('a topic is 1 to 32 base64url characters');
    expect(() => new WebPush({ vapid: { ...keys, subject: 'nobody' } })).toThrow();
    expect(new WebPush({ vapid: { ...keys, subject: 'mailto:a@b.c' } }).publicKey).toBe(keys.publicKey);
  });
});
