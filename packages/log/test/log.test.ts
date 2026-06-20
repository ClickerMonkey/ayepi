import { describe, it, expect } from 'vitest';
import { createLogger, type LogRecord, type Transport } from '../src/index';

const now = () => 1_000_000;
function mem() {
  const records: LogRecord[] = [];
  const t: Transport = { name: 'mem', write: (r) => void records.push(r) };
  return { records, t };
}

describe('log()', () => {
  it('drops logs below the threshold', () => {
    const { records, t } = mem();
    const log = createLogger({ level: 'warn', transports: [t], now });
    log.info('nope');
    expect(records).toHaveLength(0);
    log.warn('yes');
    expect(records).toHaveLength(1);
  });

  it('builds tms/level/msg and merges object args', () => {
    const { records, t } = mem();
    const log = createLogger({ transports: [t], now, timestamp: 'epoch' });
    log.info('hello', 'world', { a: 1 }, { b: 2 });
    expect(records[0]).toMatchObject({ tms: now(), level: 'info', msg: 'hello world', a: 1, b: 2 });
  });

  it('msg is the non-object args joined by spaces', () => {
    const { records, t } = mem();
    const log = createLogger({ transports: [t], now });
    log.info('done in', 42, 'ms', { req: 'x' });
    expect(records[0]!.msg).toBe('done in 42 ms');
    expect(records[0]).toMatchObject({ req: 'x' });
  });

  it('ambient context wins the bare key over call-site objects', () => {
    const { records, t } = mem();
    const log = createLogger({ transports: [t], now });
    log.logWith({ user: 'a' }, () => log.info('hi', { user: 'b' }));
    expect(records[0]).toMatchObject({ user: 'a', user2: 'b', msg: 'hi' });
  });

  it('supports iso vs epoch timestamps', () => {
    const a = mem();
    const b = mem();
    createLogger({ transports: [a.t], now, timestamp: 'epoch' }).info('x');
    createLogger({ transports: [b.t], now, timestamp: 'iso' }).info('x');
    expect(a.records[0]!.tms).toBe(now());
    expect(b.records[0]!.tms).toBe(new Date(now()).toISOString());
  });

  it('exposes config', () => {
    const log = createLogger({ level: 'debug', structured: true });
    expect(log.config).toEqual({ level: 'debug', structured: true, timestamp: 'iso' });
  });
});
