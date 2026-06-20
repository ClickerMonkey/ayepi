import { describe, it, expect } from 'vitest';
import { createLogger, createSanitizer, partialMask, type LogRecord, type Transport } from '../src/index';

const now = () => 1_000_000;
function mem() {
  const records: LogRecord[] = [];
  const t: Transport = { name: 'mem', write: (r) => void records.push(r) };
  return { records, t };
}

describe('createSanitizer', () => {
  it('drops a record when the filter predicate returns false (keeps it otherwise)', () => {
    const s = createSanitizer({ filter: (r) => r.level !== 'debug' });
    expect(s({ tms: 1, level: 'debug', msg: 'x' })).toBeNull();
    expect(s({ tms: 1, level: 'info', msg: 'x' })).toMatchObject({ msg: 'x' });
  });

  it('masks sensitive keys (string exact, case-insensitive) at any depth', () => {
    const s = createSanitizer({ sensitiveKeys: ['password', /token$/i] });
    const out = s({ tms: 1, level: 'info', msg: 'm', Password: 'hunter2', user: { authToken: 'abc', name: 'ada' } })!;
    expect(out.Password).toBe('[redacted]'); // case-insensitive exact
    expect((out.user as Record<string, unknown>).authToken).toBe('[redacted]'); // regex, nested
    expect((out.user as Record<string, unknown>).name).toBe('ada'); // untouched
  });

  it('masks sensitive string values (substring + regex) but leaves non-matching strings', () => {
    const s = createSanitizer({ sensitiveValues: ['secret', /\d{16}/] });
    const out = s({ tms: 1, level: 'info', msg: 'm', a: 'this is SECRET stuff', b: '4111111111111111', c: 'fine' })!;
    expect(out.a).toBe('[redacted]');
    expect(out.b).toBe('[redacted]');
    expect(out.c).toBe('fine');
  });

  it('uses a custom mask (partialMask keeps a prefix)', () => {
    const s = createSanitizer({ sensitiveKeys: ['token'], mask: partialMask(3) });
    expect(s({ tms: 1, level: 'info', msg: 'm', token: 'secret-value' })!.token).toBe('sec***');
    // partialMask fully masks short values and stringifies non-strings
    expect(partialMask(3)('ab')).toBe('***');
    expect(partialMask()(12345)).toBe('***'); // default keep=0 → full mask, coerced to string
  });

  it('truncates long strings with a "(+N more)" suffix', () => {
    const s = createSanitizer({ maxStringLength: 5 });
    const out = s({ tms: 1, level: 'info', msg: 'm', note: 'abcdefghij' })!; // 10 chars
    expect(out.note).toBe('abcde... (+5 more)');
    expect(s({ tms: 1, level: 'info', msg: 'm', short: 'abc' })!.short).toBe('abc'); // under the cap → unchanged
  });

  it('truncates a homogeneous array and appends a "(+N more)" element', () => {
    const s = createSanitizer({ maxArrayLength: 2 });
    const out = s({ tms: 1, level: 'info', msg: 'm', nums: [1, 2, 3, 4, 5] })!;
    expect(out.nums).toEqual([1, 2, '(+3 more)']); // first 2 kept, 3 removed

  });

  it('detects homogeneity for arrays-of-arrays and arrays-of-null', () => {
    const s = createSanitizer({ maxArrayLength: 1 });
    const out = s({ tms: 1, level: 'info', msg: 'm', arrs: [[1], [2], [3]], nulls: [null, null, null] })!;
    expect(out.arrs).toEqual([[1], '(+2 more)']); // kindOf 'array' → homogeneous
    expect(out.nulls).toEqual([null, '(+2 more)']); // kindOf 'null' → homogeneous
  });

  it('leaves a heterogeneous array untouched (but still sanitizes its elements)', () => {
    const s = createSanitizer({ maxArrayLength: 1, maxStringLength: 2 });
    const out = s({ tms: 1, level: 'info', msg: 'm', mixed: [1, 'abcdef'] })!; // not homogeneous → not length-capped
    expect(out.mixed).toEqual([1, 'ab... (+4 more)']); // element string still truncated
  });

  it('keeps reserved tms/level pristine even with aggressive caps', () => {
    const s = createSanitizer({ maxStringLength: 3, sensitiveKeys: ['level'] });
    const out = s({ tms: '2026-06-20T00:00:00.000Z', level: 'info', msg: 'hello world' })!;
    expect(out.tms).toBe('2026-06-20T00:00:00.000Z'); // not truncated
    expect(out.level).toBe('info'); // not masked
    expect(out.msg).toBe('hel... (+8 more)'); // msg is sanitized
  });

  it('passes Date and class instances through untouched; handles cycles', () => {
    class Point {
      constructor(
        public x = 1,
        public y = 2,
      ) {}
    }
    const d = new Date(0);
    const cyclic: Record<string, unknown> = { name: 'c' };
    cyclic.self = cyclic;
    const s = createSanitizer({ maxStringLength: 0, sensitiveKeys: ['x'] });
    const out = s({ tms: 1, level: 'info', msg: 'm', when: d, pt: new Point(), node: cyclic })!;
    expect(out.when).toBe(d); // Date untouched (not turned into {})
    expect(out.pt).toBeInstanceOf(Point); // class instance untouched (x not masked)
    const node = out.node as Record<string, unknown>;
    expect(node.self).toBe(cyclic); // the cycle is left as the original ref
  });
});

describe('LoggerConfig.sanitize', () => {
  it('applies redaction + truncation to direct logger calls', () => {
    const { records, t } = mem();
    const log = createLogger({
      transports: [t],
      now,
      sanitize: { sensitiveKeys: ['password'], maxStringLength: 4 },
    });
    log.info('login', { password: 'p', note: 'abcdefg' });
    expect(records[0]).toMatchObject({ password: '[redacted]', note: 'abcd... (+3 more)' });
  });

  it('runs after the config.filter transform, and can drop via its own filter', () => {
    const { records, t } = mem();
    const log = createLogger({
      transports: [t],
      now,
      filter: (r) => ({ ...r, added: true }), // transform first
      sanitize: { filter: (r) => r.msg !== 'skip', sensitiveKeys: ['added'] },
    });
    log.info('keep');
    log.info('skip'); // dropped by sanitize.filter
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ msg: 'keep', added: '[redacted]' }); // filter ran, then sanitize masked it
  });
});
