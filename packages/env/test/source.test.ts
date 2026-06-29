import { describe, it, expect } from 'vitest';
import type { z } from 'zod';
import { EnvError, defaultSource, mergeSources, resolveRaw } from '../src/index';

describe('source helpers', () => {
  it('mergeSources handles undefined, a single record, and a layered array', () => {
    expect(mergeSources({ A: '1' })).toEqual(expect.objectContaining({ A: '1' }));
    expect(mergeSources([{ A: '1' }, { A: '2', B: '3' }])).toEqual({ A: '2', B: '3' });
    expect(typeof mergeSources(undefined)).toBe('object'); // defaults to process.env
  });

  it('resolveRaw returns the first present alias, else undefined', () => {
    expect(resolveRaw({ B: 'x' }, ['A', 'B'])).toBe('x');
    expect(resolveRaw({}, ['A', 'B'])).toBeUndefined();
  });

  it('defaultSource returns process.env, or {} when process / env is absent', () => {
    expect(defaultSource()).toBe(process.env);
    const saved = (globalThis as { process?: unknown }).process;
    try {
      delete (globalThis as { process?: unknown }).process;
      expect(defaultSource()).toEqual({}); // no process global
    } finally {
      (globalThis as { process?: unknown }).process = saved;
    }
    const savedEnv = process.env;
    try {
      (process as { env?: unknown }).env = undefined;
      expect(defaultSource()).toEqual({}); // process but no env
    } finally {
      process.env = savedEnv;
    }
  });
});

describe('EnvError', () => {
  it('formats issues, rendering an empty path as (root)', () => {
    const e = new EnvError([
      { code: 'custom', path: ['PORT'], message: 'bad' } as z.core.$ZodIssue,
      { code: 'custom', path: [], message: 'root problem' } as z.core.$ZodIssue,
    ]);
    expect(e.name).toBe('EnvError');
    expect(e.message).toContain('PORT: bad');
    expect(e.message).toContain('(root): root problem');
    expect(e.issues).toHaveLength(2);
  });
});
