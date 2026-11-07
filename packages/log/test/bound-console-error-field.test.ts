import { describe, it, expect } from 'vitest';
import { consoleTransport, createLogger, type ConsoleLike, type LogRecord, type Transport } from '../src/index';

const now = () => 1;
function mem() {
  const records: LogRecord[] = [];
  const t: Transport = { name: 'mem', write: (r) => void records.push(r) };
  return { records, t };
}
function fakeConsole(): ConsoleLike & { lines: string[] } {
  const lines: string[] = [];
  const push = (...a: unknown[]) => void lines.push(a.map(String).join(' '));
  return { log: push, info: push, debug: push, warn: push, error: push, lines };
}

describe('consoleTransport binds the console when made', () => {
  it('keeps writing to the original methods after interceptConsole replaces them', () => {
    const c = fakeConsole();
    const transport = consoleTransport({ console: c }); // made before interception
    const log = createLogger({ console: c, transports: [transport], now, timestamp: 'epoch' });
    log.interceptConsole();
    log.info('direct');
    c.log('from console');
    log.restoreConsole();
    expect(c.lines).toEqual(['[1] info direct', '[1] info from console']);
  });
});

describe('a string error field', () => {
  it('becomes a serialized Error and renders as Error: message', () => {
    const { records, t } = mem();
    const text: string[] = [];
    const log = createLogger({ transports: [t, { name: 'text', write: (_r, line) => void text.push(line) }], now, timestamp: 'epoch' });
    log.warn('job.failed', { error: 'timed out', id: 3 });
    expect(records[0]!.error).toEqual({ name: 'Error', message: 'timed out' });
    expect(text[0]).toBe('[1] warn job.failed id=3 error=Error: timed out');
  });

  it('keeps an already serialized error and serializes other values', () => {
    const { records, t } = mem();
    const log = createLogger({ transports: [t], now });
    log.info('a', { error: { name: 'TypeError', message: 'bad', code: 7 } });
    log.info('b', { error: 42 });
    log.info('c', { error: { nested: true } });
    expect(records[0]!.error).toEqual({ name: 'TypeError', message: 'bad', code: 7 });
    expect(records[1]!.error).toEqual({ name: 'NonError', message: '42' });
    expect(records[2]!.error).toMatchObject({ name: 'NonError' });
  });

  it('leaves a real Error arg first and moves a field error aside', () => {
    const { records, t } = mem();
    const log = createLogger({ transports: [t], now, error: { stack: false } });
    log.error('x', new Error('real'), { error: 'field' });
    expect(records[0]!.error).toEqual({ name: 'Error', message: 'real' });
    expect(records[0]!['error2']).toBe('field');
  });
});
