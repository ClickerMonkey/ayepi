import { describe, it, expect } from 'vitest';
import { createLogger, type Transport } from '../src/index';

const now = () => 1_000_000;
function capture() {
  let line = '';
  const t: Transport = { name: 'cap', write: (_r, text) => { line = text; } };
  return { get line() { return line; }, t };
}

describe('formatting', () => {
  it('text: [tms] level msg key=value, key=value', () => {
    const cap = capture();
    createLogger({ now, timestamp: 'epoch', transports: [cap.t] }).info('hello', { a: 1, b: 'x' });
    expect(cap.line).toBe(`[${now()}] info hello a=1, b=x`);
  });

  it('text: appends error=Name: message', () => {
    const cap = capture();
    createLogger({ now, timestamp: 'epoch', transports: [cap.t] }).error('boom', new Error('nope'));
    expect(cap.line).toContain('error=Error: nope');
  });

  it('structured: valid JSON', () => {
    const cap = capture();
    createLogger({ now, timestamp: 'epoch', structured: true, transports: [cap.t] }).info('hi', { a: 1 });
    expect(JSON.parse(cap.line)).toMatchObject({ tms: now(), level: 'info', msg: 'hi', a: 1 });
  });
});
