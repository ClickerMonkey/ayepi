import { describe, it, expect } from 'vitest';
import { createLogger, type Level, type LogRecord, type Transport } from '../src/index';
import { resolveLog } from '../src/internal';

const now = () => 0;
function mem() {
  const records: LogRecord[] = [];
  const errs: unknown[] = [];
  const t: Transport = { name: 'mem', write: (r) => void records.push(r) };
  return { records, errs, t };
}

describe('runtime level — setLevel / isLevelEnabled', () => {
  it('changes the threshold at runtime and reflects it on config + isLevelEnabled', () => {
    const { records, t } = mem();
    const log = createLogger({ level: 'warn', transports: [t], now });
    expect(log.isLevelEnabled('info')).toBe(false);
    log.info('dropped');
    expect(records).toHaveLength(0);

    log.setLevel('debug');
    expect(log.config.level).toBe('debug'); // config reflects setLevel
    expect(log.isLevelEnabled('info')).toBe(true);
    log.info('kept');
    expect(records).toHaveLength(1);

    log.setLevel('error'); // tighten again
    log.warn('dropped too');
    expect(records).toHaveLength(1);
  });
});

describe('flush / close', () => {
  it('drains and closes every transport, tolerating ones without the hooks', async () => {
    const calls: string[] = [];
    const full: Transport = {
      name: 'full',
      write: () => {},
      flush: () => void calls.push('flush'),
      close: () => void calls.push('close'),
    };
    const bare: Transport = { name: 'bare', write: () => {} }; // no flush/close → skipped, no throw
    const log = createLogger({ transports: [full, bare], now });
    await log.flush();
    await log.close();
    expect(calls).toEqual(['flush', 'close']);
  });

  it('reports a failing flush/close without aborting the others', async () => {
    const errs: unknown[] = [];
    const ok: string[] = [];
    const boom: Transport = {
      name: 'boom',
      write: () => {},
      close: () => {
        throw new Error('close boom');
      },
    };
    const fine: Transport = { name: 'fine', write: () => {}, close: () => void ok.push('closed') };
    const log = createLogger({ transports: [boom, fine], now, onError: (e) => errs.push(e) });
    await expect(log.close()).resolves.toBeUndefined();
    expect(ok).toEqual(['closed']); // the other transport still closed
    expect(errs).toHaveLength(1);
  });
});

describe('custom serializers', () => {
  const urlSerializer = (v: object): unknown => (v instanceof URL ? { href: v.href, path: v.pathname } : undefined);

  it('shapes a type the logger does not own, winning over its toJSON, at any depth', () => {
    const { records, t } = mem();
    const log = createLogger({ structured: true, transports: [t], now, serializers: [urlSerializer] });
    log.info('req', { url: new URL('https://x.test/a/b?q=1') }); // URL has a toJSON (→ href) — serializer wins
    expect(records[0]!.url).toEqual({ href: 'https://x.test/a/b?q=1', path: '/a/b' });
  });

  it('tries serializers in order; undefined declines to the next, then to toLOG/structural', () => {
    const { records, t } = mem();
    const seen: string[] = [];
    const decline = (v: object): unknown => (seen.push('a'), undefined); // always declines
    const handleMoney = (v: object): unknown => ('cents' in v ? `$${(v as { cents: number }).cents / 100}` : undefined);
    const log = createLogger({ transports: [t], now, serializers: [decline, handleMoney] });
    log.info('m', { price: { cents: 250 }, other: { toLOG: () => 'L' } });
    expect(records[0]).toMatchObject({ price: '$2.5', other: 'L' }); // handled by 2nd serializer / fell through to toLOG
    expect(seen.length).toBeGreaterThan(0); // the declining serializer ran
  });

  it('a throwing serializer declines and is reported (logger path)', () => {
    const { records, t } = mem();
    const errs: unknown[] = [];
    const log = createLogger({
      transports: [t],
      now,
      onError: (e) => errs.push(e),
      serializers: [
        () => {
          throw new Error('ser boom');
        },
      ],
    });
    log.info('m', { a: 1 });
    expect(records[0]).toMatchObject({ msg: 'm', a: 1 }); // declined → structural copy still logged
    expect(errs).toHaveLength(1);
  });

  it('a throwing serializer with no onError is swallowed (resolveLog directly)', () => {
    const out = resolveLog({ a: 1 }, '', new WeakSet(), {
      serializers: [
        () => {
          throw new Error('x'); // no onError → silently declines
        },
      ],
    });
    expect(out).toEqual({ a: 1 });
  });
});
