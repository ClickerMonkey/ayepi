import { describe, it, expect } from 'vitest';
import { inspect as nodeInspect } from 'node:util';
import { createLogger, logMaybe, type ConsoleLike, type Level, type LogRecord, type Transport } from '../src/index';

const now = () => 1_000_000;
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0)); // let the async lazy pipeline settle
function mem() {
  const records: LogRecord[] = [];
  const t: Transport = { name: 'mem', write: (r) => void records.push(r) };
  return { records, t };
}

describe('logMaybe — deferred log arguments', () => {
  it('does NOT invoke the function when the line is below the threshold', async () => {
    const { records, t } = mem();
    const log = createLogger({ level: 'warn', transports: [t], now });
    let calls = 0;
    log.info('skip', logMaybe(() => (calls++, 'value'))); // info < warn → never runs
    await flush();
    expect(calls).toBe(0);
    expect(records).toHaveLength(0);
  });

  it('invokes + awaits the function (with the record level) when the line is logged', async () => {
    const { records, t } = mem();
    const log = createLogger({ transports: [t], now });
    const levels: Level[] = [];
    log.warn('got', logMaybe((lvl) => (levels.push(lvl), `level:${lvl}`)));
    await flush();
    expect(levels).toEqual(['warn']); // called once, with the record's level
    expect(records[0]!.msg).toBe('got level:warn'); // resolved value treated as a normal (string) arg
  });

  it('resolves an async function and merges an object result like a normal arg', async () => {
    const { records, t } = mem();
    const log = createLogger({ transports: [t], now });
    log.info('snapshot', logMaybe(async () => ({ userId: 'u1', size: 3 })));
    await flush();
    expect(records[0]).toMatchObject({ msg: 'snapshot', userId: 'u1', size: 3 });
  });

  it('treats a resolved Error as the record error', async () => {
    const { records, t } = mem();
    const log = createLogger({ transports: [t], now });
    log.error('boom', logMaybe(() => new Error('lazy fail')));
    await flush();
    expect(records[0]!.error).toMatchObject({ name: 'Error', message: 'lazy fail' });
  });

  it('substitutes "(unresolved value)" and reports when the function throws or rejects', async () => {
    const errs: unknown[] = [];
    const { records, t } = mem();
    const log = createLogger({ transports: [t], now, onError: (e) => errs.push(e) });
    log.info(
      'a',
      logMaybe(() => {
        throw new Error('sync throw');
      }),
    );
    log.info('b', logMaybe(() => Promise.reject(new Error('async reject'))));
    await flush();
    expect(records.map((r) => r.msg)).toEqual(['a (unresolved value)', 'b (unresolved value)']);
    expect(errs).toHaveLength(2);
  });

  it('resolves several lazy args alongside plain ones', async () => {
    const { records, t } = mem();
    const log = createLogger({ transports: [t], now });
    log.info('m', { plain: 1 }, logMaybe(() => ({ x: 2 })), logMaybe(async () => ({ y: 3 })));
    await flush();
    expect(records[0]).toMatchObject({ msg: 'm', plain: 1, x: 2, y: 3 });
  });

  it('renders synchronously via toJSON / inspect for the non-intercepted path', () => {
    const sync = logMaybe(() => ({ a: 1 }));
    expect(JSON.stringify(sync)).toBe('{"a":1}'); // toJSON resolves the sync value
    const asyncLazy = logMaybe(async () => 42);
    expect(JSON.stringify(asyncLazy)).toBe('"(unresolved value)"'); // a promise can't be awaited here
    const thrower = logMaybe(() => {
      throw new Error('x');
    });
    expect(JSON.stringify(thrower)).toBe('"(unresolved value)"');
    // Node's custom-inspect symbol mirrors toJSON (so a non-intercepted console.log renders it)
    expect(nodeInspect(sync)).toContain('a: 1');
    expect(nodeInspect(asyncLazy)).toContain('(unresolved value)');
  });

  it('works through console interception', async () => {
    const calls: { method: string; text: string }[] = [];
    const fakeConsole: ConsoleLike = {
      log: (...a) => void calls.push({ method: 'log', text: String(a[0]) }),
      info: () => {},
      debug: () => {},
      warn: () => {},
      error: () => {},
    };
    const { records, t } = mem();
    const log = createLogger({ console: fakeConsole, transports: [t], now });
    const restore = log.interceptConsole();
    let calced = 0;
    fakeConsole.log('hi', logMaybe(() => (calced++, { ctx: 'z' }))); // 'log' → info level
    await flush();
    restore();
    expect(calced).toBe(1);
    expect(records[0]).toMatchObject({ msg: 'hi', ctx: 'z' });
  });
});
