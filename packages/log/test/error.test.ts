import { describe, it, expect } from 'vitest';
import { createLogger, serializeError, type LogRecord, type Transport } from '../src/index';

const now = () => 1_000_000;
function mem() {
  const records: LogRecord[] = [];
  const t: Transport = { name: 'mem', write: (r) => void records.push(r) };
  return { records, t };
}

describe('error args', () => {
  it('serializes the first error and stacks additional ones', () => {
    const { records, t } = mem();
    const log = createLogger({ transports: [t], now });
    const e1 = new Error('first')
    ;(e1 as { code?: string }).code = 'E1';
    const e2 = new TypeError('second');
    log.error('failed', e1, e2);
    const r = records[0]!;
    expect(r.error).toMatchObject({ name: 'Error', message: 'first', code: 'E1' });
    expect(typeof r.error!.stack).toBe('string');
    expect(r.additionalErrors).toHaveLength(1);
    expect(r.additionalErrors![0]).toMatchObject({ name: 'TypeError', message: 'second' });
  });

  it('honors stack:false and per-level overrides', () => {
    const { records, t } = mem();
    const log = createLogger({ transports: [t], now, error: { stack: true, perLevel: { warn: { stack: false } } } });
    log.error('x', new Error('e'));
    log.warn('y', new Error('e'));
    expect(typeof records[0]!.error!.stack).toBe('string');
    expect(records[1]!.error!.stack).toBeUndefined();
  });

  it('recurses into cause (depth-bounded)', () => {
    const root = new Error('root');
    const wrap = new Error('wrap', { cause: root });
    const ser = serializeError(wrap);
    expect((ser.cause as { message: string }).message).toBe('root');
    expect(serializeError(wrap, { cause: false }).cause).toBeUndefined();
  });

  it('merges an error-attached trace context into the record', async () => {
    const { records, t } = mem();
    const log = createLogger({ transports: [t], now });
    const err = new Error('x');
    await log.logWith({ reqId: 'r9' }, () => Promise.reject(err)).catch(() => {});
    log.error('caught', err);
    expect(records[0]).toMatchObject({ reqId: 'r9', msg: 'caught' });
  });

  it('serializes non-Error throwables', () => {
    expect(serializeError('boom')).toEqual({ name: 'NonError', message: 'boom' });
  });
});
