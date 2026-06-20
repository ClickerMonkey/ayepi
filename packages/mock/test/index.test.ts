import { describe, it, expect } from 'vitest';
import * as mock from '../src/index';
import { z } from 'zod';

describe('public surface', () => {
  it('re-exports generate / mockServer / mockHandlers', () => {
    expect(typeof mock.generate).toBe('function');
    expect(typeof mock.mockServer).toBe('function');
    expect(typeof mock.mockHandlers).toBe('function');
  });

  it('generate is callable through the index export', () => {
    expect(typeof mock.generate(z.string())).toBe('string');
  });
});
