import { describe, it, expect } from 'vitest';
import { createHmac } from 'node:crypto';
import { signJwt, verifyJwt, JwtError } from '../src/server';

const secret = 'super-secret';

describe('signJwt / verifyJwt', () => {
  it('round-trips custom claims and applies iat/exp defaults', () => {
    const { token, payload } = signJwt({ userId: 'u1', role: 'admin' }, { secret });
    expect(typeof token).toBe('string');
    expect(token.split('.')).toHaveLength(3);
    expect(payload.userId).toBe('u1');
    expect(typeof payload.iat).toBe('number');
    expect(payload.exp).toBe(payload.iat! + 3600);

    const verified = verifyJwt<{ userId: string; role: string }>(token, { secret });
    expect(verified.userId).toBe('u1');
    expect(verified.role).toBe('admin');
  });

  it('honors a custom expiresIn', () => {
    const { payload } = signJwt({ a: 1 }, { secret, expiresIn: 10 });
    expect(payload.exp).toBe(payload.iat! + 10);
  });

  it('sets iss and aud when configured', () => {
    const { token, payload } = signJwt({ a: 1 }, { secret, issuer: 'api', audience: 'web' });
    expect(payload.iss).toBe('api');
    expect(payload.aud).toBe('web');
    const v = verifyJwt(token, { secret, issuer: 'api', audience: 'web' });
    expect(v.iss).toBe('api');
  });

  it('preserves a caller-supplied registered claim (sub) but always sets iat/exp', () => {
    const { payload } = signJwt({ sub: 'subject-1', x: 2 }, { secret, issuer: 'api' });
    expect(payload.sub).toBe('subject-1');
    expect(typeof payload.iat).toBe('number');
  });

  it('throws on a token without 3 segments', () => {
    expect(() => verifyJwt('a.b', { secret })).toThrow(JwtError);
    expect(() => verifyJwt('a.b', { secret })).toThrow(/3 segments/);
  });

  it('throws on non-JSON segments', () => {
    expect(() => verifyJwt('@@@.@@@.@@@', { secret })).toThrow(/invalid JSON/);
  });

  it('throws on an unsupported alg', () => {
    // header { alg: 'none' } base64url
    const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
    const body = Buffer.from(JSON.stringify({ a: 1 })).toString('base64url');
    const bad = `${header}.${body}.sig`;
    expect(() => verifyJwt(bad, { secret })).toThrow(/unsupported alg/);
  });

  it('throws on a bad signature', () => {
    const { token } = signJwt({ a: 1 }, { secret });
    const tampered = `${token}x`;
    expect(() => verifyJwt(tampered, { secret })).toThrow(/invalid signature/);
  });

  it('throws on a signature of different length (length-mismatch branch)', () => {
    const [h, p] = signJwt({ a: 1 }, { secret }).token.split('.');
    const short = `${h}.${p}.AA`;
    expect(() => verifyJwt(short, { secret })).toThrow(/invalid signature/);
  });

  it('throws on a wrong secret', () => {
    const { token } = signJwt({ a: 1 }, { secret });
    expect(() => verifyJwt(token, { secret: 'other' })).toThrow(/invalid signature/);
  });

  it('throws on an expired token', () => {
    const { token } = signJwt({ a: 1 }, { secret, expiresIn: -10 });
    expect(() => verifyJwt(token, { secret })).toThrow(/expired/);
  });

  it('honors clock tolerance for expiry', () => {
    const { token } = signJwt({ a: 1 }, { secret, expiresIn: -5 });
    // within tolerance ⇒ ok
    expect(verifyJwt(token, { secret, clockToleranceSec: 60 }).a).toBe(1);
  });

  it('throws when nbf is in the future and honors tolerance', () => {
    const future = Math.floor(Date.now() / 1000) + 100;
    const { token } = signJwt({ a: 1, nbf: future }, { secret });
    expect(() => verifyJwt(token, { secret })).toThrow(/not yet valid/);
    expect(verifyJwt(token, { secret, clockToleranceSec: 200 }).a).toBe(1);
  });

  it('throws on issuer mismatch', () => {
    const { token } = signJwt({ a: 1 }, { secret, issuer: 'api' });
    expect(() => verifyJwt(token, { secret, issuer: 'other' })).toThrow(/issuer mismatch/);
  });

  it('throws on audience mismatch (string aud)', () => {
    const { token } = signJwt({ a: 1 }, { secret, audience: 'web' });
    expect(() => verifyJwt(token, { secret, audience: 'mobile' })).toThrow(/audience mismatch/);
  });

  it('accepts an array audience that contains the expected value', () => {
    const { token } = signJwt({ a: 1 }, { secret, audience: ['web', 'mobile'] });
    expect(verifyJwt(token, { secret, audience: 'mobile' }).a).toBe(1);
  });

  it('rejects an array audience missing the expected value', () => {
    const { token } = signJwt({ a: 1 }, { secret, audience: ['web'] });
    expect(() => verifyJwt(token, { secret, audience: 'mobile' })).toThrow(/audience mismatch/);
  });

  it('skips exp/nbf checks when those claims are absent', () => {
    // hand-roll a token with no exp/nbf
    const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
    const body = Buffer.from(JSON.stringify({ a: 1 })).toString('base64url');
    const sig = createHmac('sha256', secret).update(`${header}.${body}`).digest('base64url');
    const token = `${header}.${body}.${sig}`;
    expect(verifyJwt<{ a: number }>(token, { secret }).a).toBe(1);
  });
});
