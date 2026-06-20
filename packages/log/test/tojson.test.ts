import { describe, it, expect } from 'vitest';
import { createLogger, resolveLogValue, type LogRecord, type Transport } from '../src/index';

const now = () => 0;
const ISO0 = '1970-01-01T00:00:00.000Z';
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

function cap(structured = false) {
  const records: LogRecord[] = [];
  const errs: unknown[] = [];
  const t: Transport = { name: 'mem', write: (r) => void records.push(r) };
  const log = createLogger({ structured, transports: [t], now, onError: (e) => errs.push(e) });
  return { log, records, errs };
}

/** An object with a throwing `toLOG` getter (the property *access*, not the call, throws). */
function throwingGetter(): object {
  const o = {};
  Object.defineProperty(o, 'toLOG', {
    get() {
      throw new Error('getter boom');
    },
  });
  return o;
}

describe('resolveLogValue (standalone)', () => {
  it('honors toJSON deeply (Date, nested, arrays)', () => {
    expect(resolveLogValue({ at: new Date(0), nested: { toJSON: () => 'N' }, arr: [{ toJSON: () => 1 }, 2], plain: 'x' })).toEqual({
      at: ISO0,
      nested: 'N',
      arr: [1, 2],
      plain: 'x',
    });
  });

  it('honors toLOG and lets it win over toJSON; re-resolves the hook result', () => {
    expect(resolveLogValue({ toJSON: () => 'json', toLOG: () => ({ logged: true }) })).toEqual({ logged: true });
    expect(resolveLogValue({ toLOG: () => 'scalar' })).toBe('scalar');
    expect(resolveLogValue({ toLOG: () => ({ when: new Date(0), inner: { toLOG: () => 'deep' } }) })).toEqual({ when: ISO0, inner: 'deep' });
  });

  it('passes Errors and primitives through; leaves cycles as the original ref', () => {
    const err = new Error('keep');
    expect(resolveLogValue(err)).toBe(err); // Errors get dedicated serialization, not a structural copy
    expect(resolveLogValue(42)).toBe(42);
    const cyclic: Record<string, unknown> = { a: 1 };
    cyclic.self = cyclic;
    const out = resolveLogValue(cyclic) as Record<string, unknown>;
    expect(out).not.toBe(cyclic);
    expect(out.self).toBe(cyclic);
  });

  it('degrades a rejecting promise / throwing hook to "(unresolved value)" with no onError', async () => {
    expect(await resolveLogValue(Promise.reject(new Error('x')))).toBe('(unresolved value)'); // onError absent → silent
    expect(
      resolveLogValue({
        toLOG: () => {
          throw new Error('hook boom');
        },
      }),
    ).toBe('(unresolved value)');
  });
});

describe('toLOG / toJSON through the pipeline (synchronous)', () => {
  it('a top-level object with toJSON merges its resolved shape (no longer clobbers tms/level)', () => {
    const { records } = cap(true);
    cap(true).log.info('x'); // (unused — exercises a second logger)
    records.length = 0;
    const r = cap(true);
    r.log.info('m', { toJSON: () => ({ shape: 'desired' }), secret: 'x' });
    expect(r.records[0]).toMatchObject({ tms: ISO0, level: 'info', msg: 'm', shape: 'desired' });
  });

  it('a top-level value whose hook returns a scalar joins msg', () => {
    class Money {
      toLOG(): string {
        return '$1.50';
      }
    }
    const r = cap();
    r.log.info('price', new Money());
    expect(r.records[0]!.msg).toBe('price $1.50');
  });

  it('resolves nested hooks in the record object itself (not just the formatted text)', () => {
    class Money {
      toLOG(): string {
        return '$2.00';
      }
    }
    const r = cap(true);
    r.log.info('m', { price: new Money(), at: new Date(0) });
    expect(r.records[0]!.price).toBe('$2.00'); // transports see plain, resolved data
    expect(r.records[0]!.at).toBe(ISO0);
  });

  it('toLOG shapes logs without affecting JSON.stringify (API) output', () => {
    class User {
      constructor(public id = 'u1') {}
      toJSON() {
        return { id: this.id };
      }
      toLOG() {
        return { id: this.id, _forLogsOnly: true };
      }
    }
    expect(JSON.stringify(new User())).toBe('{"id":"u1"}'); // API path uses toJSON
    const r = cap(true);
    r.log.info('user', { u: new User() });
    expect(r.records[0]!.u).toEqual({ id: 'u1', _forLogsOnly: true }); // log path uses toLOG
  });
});

describe('toLOG / promises (asynchronous)', () => {
  it('awaits a nested async toLOG and resolves it in the record', async () => {
    const r = cap(true);
    r.log.info('m', { user: { toLOG: async () => ({ id: 'u1', role: 'admin' }) } });
    await flush();
    expect(r.records[0]).toMatchObject({ msg: 'm', user: { id: 'u1', role: 'admin' } });
  });

  it('a top-level async toLOG returning a scalar joins msg; a raw promise value is awaited', async () => {
    const r = cap(true);
    r.log.info('top', { toLOG: async () => '$9.99' });
    r.log.info('raw', { p: Promise.resolve(42), arr: [Promise.resolve(7)] });
    await flush();
    expect(r.records.find((x) => (x.msg as string).startsWith('top'))!.msg).toBe('top $9.99');
    expect(r.records.find((x) => x.msg === 'raw')).toMatchObject({ p: 42, arr: [7] });
  });

  it('handles a top-level array whose elements resolve asynchronously (merges by index)', async () => {
    const r = cap(true);
    r.log.info('arr', [{ toLOG: async () => 'A' }, { toLOG: async () => 'B' }]);
    await flush();
    expect(r.records[0]).toMatchObject({ msg: 'arr', '0': 'A', '1': 'B' });
  });

  it('degrades an async toLOG that rejects to "(unresolved value)" and reports it', async () => {
    const r = cap();
    r.log.info(
      'rej',
      {
        toLOG: async () => {
          throw new Error('async boom');
        },
      },
    );
    await flush();
    expect(r.records[0]!.msg).toBe('rej (unresolved value)');
    expect(r.errs).toHaveLength(1);
  });

  it('settles async values inside a self-referential object without looping', async () => {
    const node: Record<string, unknown> = { id: 1, blob: { toLOG: async () => 'BLOB' } };
    node.self = node; // cycle + async → exercises settleDeep's cycle guard
    const r = cap(true);
    r.log.info('m', node);
    await flush();
    expect(r.records[0]).toMatchObject({ id: 1, blob: 'BLOB' });
  });
});

describe('hook failures are best-effort', () => {
  it('drops the line and reports when a toLOG *getter* throws (sync)', () => {
    const r = cap();
    expect(() => r.log.info('m', throwingGetter())).not.toThrow();
    expect(r.records).toEqual([]); // resolution threw before build → line dropped
    expect(r.errs).toHaveLength(1);
  });

  it('substitutes "(unresolved value)" for a throwing toLOG call and keeps the line', () => {
    const r = cap(true);
    r.log.info('m', {
      v: {
        toLOG: () => {
          throw new Error('call boom');
        },
      },
    });
    expect(r.records[0]).toMatchObject({ msg: 'm', v: '(unresolved value)' }); // substituted, line kept
    expect(r.errs).toHaveLength(1);
  });

  it('drops the line and reports when an async hook resolves to a throwing getter', async () => {
    const r = cap();
    r.log.info('m', { v: { toLOG: async () => throwingGetter() } });
    await flush();
    expect(r.records).toEqual([]); // the re-resolution of the awaited value threw → settleDeep rejected
    expect(r.errs).toHaveLength(1);
  });
});
