import { describe, it, expect, afterEach } from 'vitest';
import { createLogger, consoleTransport, type ConsoleLike, type Level, type LogRecord, type Transport } from '../src/index';

const now = () => 1;
function mem() {
  const records: LogRecord[] = [];
  const t: Transport = { name: 'mem', write: (r) => void records.push(r) };
  return { records, t };
}

function fakeConsole() {
  const calls: { method: string; args: unknown[] }[] = [];
  const make = (m: string) => (...args: unknown[]) => void calls.push({ method: m, args });
  return { log: make('log'), info: make('info'), debug: make('debug'), warn: make('warn'), error: make('error'), calls };
}

describe('consoleTransport defaults', () => {
  it('falls back to the global console when none injected', () => {
    const orig = (globalThis as { console?: ConsoleLike }).console;
    const c = fakeConsole();
    (globalThis as { console?: ConsoleLike }).console = c;
    try {
      const t = consoleTransport(); // no console → globalConsole()
      t.write({ tms: 1, level: 'info', msg: 'hi' }, 'line');
      expect(c.calls).toEqual([{ method: 'log', args: ['line'] }]);
    } finally {
      (globalThis as { console?: ConsoleLike }).console = orig;
    }
  });

  it('uses noopConsole (all methods) when globalThis has no console (no throw)', () => {
    const orig = (globalThis as { console?: ConsoleLike }).console;
    delete (globalThis as { console?: ConsoleLike }).console;
    try {
      const t = consoleTransport();
      // hit every noopConsole method via the level→method default mapping
      const levels: Level[] = ['debug', 'info', 'warn', 'error'];
      for (const level of levels) {expect(() => t.write({ tms: 1, level, msg: 'x' }, 'noop')).not.toThrow();}
      // also exercise the remaining noopConsole methods (log, info) via custom mappings
      for (const m of ['log', 'info'] as const) {
        const t2 = consoleTransport({ method: () => m });
        expect(() => t2.write({ tms: 1, level: 'info', msg: 'x' }, 'noop')).not.toThrow();
      }
    } finally {
      (globalThis as { console?: ConsoleLike }).console = orig;
    }
  });

  it('defaultMethod maps every level (log/info/warn/error/debug)', () => {
    const c = fakeConsole();
    const t = consoleTransport({ console: c });
    const levels: Level[] = ['debug', 'info', 'warn', 'error'];
    for (const level of levels) {t.write({ tms: 1, level, msg: 'm' }, `txt-${level}`);}
    expect(c.calls.map((x) => x.method)).toEqual(['debug', 'log', 'warn', 'error']);
  });

  it('honors a custom method mapping', () => {
    const c = fakeConsole();
    const t = consoleTransport({ console: c, method: () => 'info' });
    t.write({ tms: 1, level: 'error', msg: 'm' }, 'txt');
    expect(c.calls).toEqual([{ method: 'info', args: ['txt'] }]);
  });
});

describe('createLogger misc branches', () => {
  it('uses the default Date.now clock when none is injected', () => {
    const { records, t } = mem();
    const before = Date.now();
    createLogger({ transports: [t] }).info('x'); // no `now`
    const after = Date.now();
    const tms = Date.parse(records[0]!.tms as string);
    expect(tms).toBeGreaterThanOrEqual(before);
    expect(tms).toBeLessThanOrEqual(after);
  });

  it('interceptConsole is idempotent and returns the same restore', () => {
    const c = fakeConsole();
    const log = createLogger({ console: c, now });
    const r1 = log.interceptConsole();
    const intercepted = c.log;
    const r2 = log.interceptConsole(); // already intercepting → returns restore, no re-install
    expect(c.log).toBe(intercepted); // not replaced again
    expect(typeof r2).toBe('function');
    r1();
    expect(c.log).not.toBe(intercepted); // restored
    r2(); // idempotent
  });
});

describe('logger pipeline failures (onError, best-effort)', () => {
  it('reports a throwing filter and drops the line, without breaking the caller', () => {
    const errs: unknown[] = [];
    const { records, t } = mem();
    const log = createLogger({
      transports: [t],
      now,
      filter: () => {
        throw new Error('filter boom');
      },
      onError: (e) => errs.push(e),
    });
    expect(() => log.info('x')).not.toThrow();
    expect(records).toEqual([]); // dropped, never logged
    expect((errs[0] as Error).message).toBe('filter boom');
  });

  it('reports an unserializable record (structured JSON) and drops it', () => {
    const errs: unknown[] = [];
    const { records, t } = mem();
    const log = createLogger({ structured: true, transports: [t], now, onError: (e) => errs.push(e) });
    expect(() => log.info('x', { big: 10n })).not.toThrow(); // BigInt → JSON.stringify throws in formatJson
    expect(records).toEqual([]);
    expect(errs.length).toBe(1);
  });

  it('reports a throwing transport but keeps logging; a throwing onError is ignored', () => {
    const errs: unknown[] = [];
    const bad: Transport = {
      name: 'bad',
      write: () => {
        throw new Error('write boom');
      },
    };
    const log = createLogger({ transports: [bad], now, onError: (e) => errs.push(e) });
    expect(() => log.info('x')).not.toThrow();
    expect((errs[0] as Error).message).toBe('write boom');

    const log2 = createLogger({
      transports: [bad],
      now,
      onError: () => {
        throw new Error('onError boom'); // a throwing reporter must not escape
      },
    });
    expect(() => log2.info('x')).not.toThrow();
  });

  it('swallows a pipeline error with no onError configured', () => {
    const bad: Transport = {
      name: 'bad',
      write: () => {
        throw new Error('write boom');
      },
    };
    const log = createLogger({ transports: [bad], now }); // no onError → silent
    expect(() => log.info('x')).not.toThrow();
  });
});
