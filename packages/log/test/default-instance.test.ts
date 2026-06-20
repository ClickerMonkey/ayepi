import { describe, it, expect, afterEach } from 'vitest';
import * as api from '../src/index';

describe('default instance bound exports', () => {
  afterEach(() => {
    api.restoreConsole();
  });

  it('log/debug/info/warn/error/logWith/context do not throw on the default logger', () => {
    // The default logger writes to the real console; we only assert the bound
    // wrappers invoke the instance without throwing (default level = info).
    expect(() => api.log('error', 'x')).not.toThrow();
    expect(() => api.debug('d')).not.toThrow(); // below threshold, dropped
    expect(() => api.info('i')).not.toThrow();
    expect(() => api.warn('w')).not.toThrow();
    expect(() => api.error('e')).not.toThrow();
  });

  it('logWith stacks context on the default logger and context() reads it', () => {
    const seen = api.logWith({ reqId: 'r1' }, () => api.context());
    expect(seen).toEqual({ reqId: 'r1' });
    expect(api.context()).toEqual({}); // restored
  });

  it('interceptConsole/restoreConsole through the default logger', () => {
    const restore = api.interceptConsole();
    expect(typeof restore).toBe('function');
    api.restoreConsole(); // idempotent restore
    api.restoreConsole();
  });

  it('exposes the default logger instance', () => {
    expect(api.logger).toBeDefined();
    expect(typeof api.logger.info).toBe('function');
  });
});
