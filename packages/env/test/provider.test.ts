import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import { asyncEnv, dynamic, isDynamic, pollProvider, staticProvider } from '../src/index';

describe('isDynamic', () => {
  it('recognizes dynamic bindings only', () => {
    expect(isDynamic(dynamic(staticProvider('1'), z.string()))).toBe(true);
    expect(isDynamic(null)).toBe(false);
    expect(isDynamic({})).toBe(false);
    expect(isDynamic({ kind: 'other' })).toBe(false);
  });
});

describe('staticProvider', () => {
  it('loads a fixed value', async () => {
    const env = asyncEnv({ K: dynamic(staticProvider('5'), z.coerce.number()) });
    expect(await env.get('K')).toBe(5);
  });
});

describe('pollProvider', () => {
  it('polls on an interval, swallows fetch errors, and stops on close', async () => {
    vi.useFakeTimers();
    try {
      let value = 'true';
      let fail = false;
      const fetch = (): string => {
        if (fail) {throw new Error('transient');}
        return value;
      };
      const env = asyncEnv({ F: dynamic(pollProvider(fetch, 10), z.coerce.boolean()) });
      expect(await env.get('F')).toBe(true);

      value = '';
      await vi.advanceTimersByTimeAsync(10);
      expect(await env.get('F')).toBe(false);

      fail = true;
      value = 'true';
      await vi.advanceTimersByTimeAsync(10); // fetch throws → swallowed, stays false
      expect(await env.get('F')).toBe(false);

      fail = false;
      env.close();
      await vi.advanceTimersByTimeAsync(50); // interval cleared → no further polls
      expect(await env.get('F')).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});
