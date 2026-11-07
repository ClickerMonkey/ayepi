import { describe, it, expect } from 'vitest';
import { hashPassword, verifyPassword, DEFAULT_PASSWORD_COST } from '../src/server';

/** A low cost keeps the tests fast; the format and checks are the same at any cost. */
const cost = 4;

describe('hashPassword / verifyPassword', () => {
  it('verifies the password a hash was made from and refuses any other', async () => {
    const hash = await hashPassword('correct horse', { cost });
    expect(await verifyPassword('correct horse', hash)).toBe(true);
    expect(await verifyPassword('wrong horse', hash)).toBe(false);
    expect(await verifyPassword('', hash)).toBe(false);
  });

  it('records its parameters, so a hash made at one cost verifies after the default changes', async () => {
    const hash = await hashPassword('pw', { cost });
    expect(hash.split('$').slice(0, 4)).toEqual(['scrypt', String(cost), '8', '1']);
    expect(await verifyPassword('pw', hash)).toBe(true);
  });

  it('salts every hash', async () => {
    const [a, b] = await Promise.all([hashPassword('pw', { cost }), hashPassword('pw', { cost })]);
    expect(a).not.toBe(b);
    expect(await verifyPassword('pw', a)).toBe(true);
    expect(await verifyPassword('pw', b)).toBe(true);
  });

  it('answers false, without throwing, for anything that is not one of its hashes', async () => {
    const hash = await hashPassword('pw', { cost });
    const parts = hash.split('$');
    for (const bad of ['', 'pw', 'bcrypt$10$abc', parts.slice(0, 5).join('$'), [...parts, 'x'].join('$'),
      ['scrypt', '0', ...parts.slice(2)].join('$'), ['scrypt', '30', ...parts.slice(2)].join('$'),
      ['scrypt', '1.5', ...parts.slice(2)].join('$'),
      [...parts.slice(0, 2), '33', ...parts.slice(3)].join('$'), [...parts.slice(0, 3), '17', ...parts.slice(4)].join('$'),
      [...parts.slice(0, 5), 'c2hvcnQ'].join('$')]) {
      expect(await verifyPassword('pw', bad), bad).toBe(false);
    }
  });

  it('answers false for a hash whose parameters scrypt refuses', async () => {
    // scrypt needs N < 2^(16r): cost 20 with block size 1 parses, but scrypt refuses it.
    const parts = (await hashPassword('pw', { cost })).split('$');
    expect(await verifyPassword('pw', ['scrypt', '20', '1', '1', ...parts.slice(4)].join('$'))).toBe(false);
  });

  it('hashes at the default cost when none is given', async () => {
    const hash = await hashPassword('pw');
    expect(hash.split('$')[1]).toBe(String(DEFAULT_PASSWORD_COST));
    expect(await verifyPassword('pw', hash)).toBe(true);
  });

  it('refuses a cost outside 1 to 24', async () => {
    await expect(hashPassword('pw', { cost: 0 })).rejects.toThrow(RangeError);
    await expect(hashPassword('pw', { cost: 25 })).rejects.toThrow(RangeError);
    await expect(hashPassword('pw', { cost: 2.5 })).rejects.toThrow(RangeError);
    expect(DEFAULT_PASSWORD_COST).toBe(15);
  });
});
