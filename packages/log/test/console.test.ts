import { describe, it, expect } from 'vitest';
import { createLogger, type ConsoleLike, type LogRecord, type Transport } from '../src/index';

const now = () => 1;
function mem() {
  const records: LogRecord[] = [];
  const t: Transport = { name: 'mem', write: (r) => void records.push(r) };
  return { records, t };
}

interface FakeConsole extends ConsoleLike {
  trace(...a: unknown[]): void;
  dir(...a: unknown[]): void;
  calls: { method: string; args: unknown[] }[];
}
function fakeConsole(): FakeConsole {
  const calls: { method: string; args: unknown[] }[] = [];
  const make = (method: string) => (...args: unknown[]) => void calls.push({ method, args });
  return { log: make('log'), info: make('info'), debug: make('debug'), warn: make('warn'), error: make('error'), trace: make('trace'), dir: make('dir'), calls };
}

describe('console interception', () => {
  it('routes log/info/warn/error/debug/trace/dir through the logger', () => {
    const { records, t } = mem();
    const c = fakeConsole();
    createLogger({ console: c, transports: [t], now, level: 'debug', interceptConsole: true });
    c.log('hello', { a: 1 });
    c.error('bad');
    c.trace('tracing');
    c.dir({ d: 1 });
    expect(records.map((r) => `${r.level}:${r.msg}`)).toEqual(['info:hello', 'error:bad', 'debug:tracing', 'info:']);
    expect(records[0]).toMatchObject({ a: 1 });
    expect(records[3]).toMatchObject({ d: 1 });
  });

  it('does not touch console unless enabled', () => {
    const c = fakeConsole();
    const before = c.log;
    createLogger({ console: c });
    expect(c.log).toBe(before);
  });

  it('restore puts the originals back (idempotent)', () => {
    const c = fakeConsole();
    const orig = c.log;
    const log = createLogger({ console: c, interceptConsole: true });
    expect(c.log).not.toBe(orig);
    log.restoreConsole();
    expect(c.log).toBe(orig);
    log.restoreConsole();
    expect(c.log).toBe(orig);
  });

  it('guards against recursion when a transport logs through the intercepted console', () => {
    const c = fakeConsole();
    let writes = 0;
    const recursive: Transport = {
      name: 'rec',
      write: () => {
        writes++;
        c.log('from transport'); // intercepted → would re-enter without the guard
      },
    };
    const log = createLogger({ console: c, transports: [recursive], now, interceptConsole: true });
    c.info('go');
    expect(writes).toBe(1); // the nested intercepted call was short-circuited
    log.restoreConsole();
  });
});
