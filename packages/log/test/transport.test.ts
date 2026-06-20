import { describe, it, expect } from 'vitest';
import { createLogger, type ConsoleLike, type LogRecord, type Transport } from '../src/index';

const now = () => 1;
function mem() {
  const records: LogRecord[] = [];
  const t: Transport = { name: 'mem', write: (r) => void records.push(r) };
  return { records, t };
}

describe('transports', () => {
  it('writes to all transports', () => {
    const a = mem();
    const b = mem();
    createLogger({ transports: [a.t, b.t], now }).info('x');
    expect(a.records).toHaveLength(1);
    expect(b.records).toHaveLength(1);
  });

  it('setTransports swaps at runtime', () => {
    const a = mem();
    const b = mem();
    const log = createLogger({ transports: [a.t], now });
    log.info('1');
    log.setTransports([b.t]);
    log.info('2');
    expect(a.records.map((r) => r.msg)).toEqual(['1']);
    expect(b.records.map((r) => r.msg)).toEqual(['2']);
  });

  it('a throwing transport never breaks logging', () => {
    const b = mem();
    const bad: Transport = {
      name: 'bad',
      write: () => {
        throw new Error('x');
      },
    };
    const log = createLogger({ transports: [bad, b.t], now });
    expect(() => log.info('ok')).not.toThrow();
    expect(b.records).toHaveLength(1);
  });

  it('consoleTransport writes the formatted text to the level-mapped method', () => {
    const calls: { method: string; args: unknown[] }[] = [];
    const make = (m: string) => (...args: unknown[]) => void calls.push({ method: m, args });
    const c: ConsoleLike = { log: make('log'), info: make('info'), debug: make('debug'), warn: make('warn'), error: make('error') };
    const log = createLogger({ console: c, now, timestamp: 'epoch' }); // default transport = console
    log.warn('hi');
    log.error('bad');
    expect(String(calls.find((x) => x.method === 'warn')?.args[0])).toContain('warn hi');
    expect(calls.find((x) => x.method === 'error')).toBeTruthy();
  });
});

describe('filter hook', () => {
  it('drops a log when the filter returns null', () => {
    const { records, t } = mem();
    const log = createLogger({ transports: [t], now, filter: (r) => (r.msg === 'secret' ? null : r) });
    log.info('secret');
    log.info('public');
    expect(records.map((r) => r.msg)).toEqual(['public']);
  });

  it('redacts/modifies the record before formatting', () => {
    let line = '';
    const log = createLogger({
      now,
      timestamp: 'epoch',
      transports: [{ name: 'cap', write: (_r, t) => void (line = t) }],
      filter: (r) => ({ ...r, token: '***' }),
    });
    log.info('x', { token: 'secret' });
    expect(line).toContain('token=***');
    expect(line).not.toContain('secret');
  });
});
