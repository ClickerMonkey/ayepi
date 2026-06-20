import { describe, it, expect } from 'vitest';
import { parseCron, nextAfter } from '../src/index';

describe('cron parser', () => {
  it('parses fields and rejects malformed expressions', () => {
    expect(() => parseCron('* * * * *')).not.toThrow();
    expect(() => parseCron('*/15 0 * * 1-5')).not.toThrow();
    expect(() => parseCron('* * * *')).toThrow(); // 4 fields
    expect(() => parseCron('60 * * * *')).toThrow(); // minute out of range
    expect(() => parseCron('*/0 * * * *')).toThrow(); // bad step
    expect(() => parseCron('5-3 * * * *')).toThrow(); // inverted range
  });

  it('applies day-of-month / day-of-week OR semantics', () => {
    // dom-only restricted: the 15th of any month
    const domNext = new Date(nextAfter('0 0 15 * *', Date.parse('2026-06-01T00:00:00'))!);
    expect(domNext.getDate()).toBe(15);
    // dow-only restricted: next Monday (dow 1)
    const dowNext = new Date(nextAfter('0 0 * * 1', Date.parse('2026-06-01T12:00:00'))!);
    expect(dowNext.getDay()).toBe(1);
    // both restricted → matches either the dom OR the dow
    const both = new Date(nextAfter('0 0 15 * 1', Date.parse('2026-06-01T00:00:00'))!);
    expect(both.getDate() === 15 || both.getDay() === 1).toBe(true);
  });

  it('nextAfter returns undefined when nothing matches within a year', () => {
    expect(nextAfter('0 0 30 2 *', Date.parse('2026-01-01T00:00:00'))).toBeUndefined(); // Feb 30 never exists
  });

  it('nextAfter finds the next matching minute', () => {
    const from = Date.parse('2026-06-13T10:00:30.000Z');
    // every minute → top of the next minute
    expect(nextAfter('* * * * *', from)).toBe(Date.parse('2026-06-13T10:01:00.000Z'));
  });

  it('nextAfter honors step + hour fields (local time)', () => {
    const base = new Date(2026, 5, 13, 10, 7, 0); // local 10:07
    const next = nextAfter('*/15 * * * *', base.getTime());
    expect(next).toBeDefined();
    const d = new Date(next!);
    expect(d.getMinutes()).toBe(15);
    expect(d.getHours()).toBe(10);
  });

  it('nextAfter respects a specific minute/hour', () => {
    const base = new Date(2026, 5, 13, 9, 0, 0);
    const next = new Date(nextAfter('30 14 * * *', base.getTime())!);
    expect(next.getHours()).toBe(14);
    expect(next.getMinutes()).toBe(30);
    expect(next.getDate()).toBe(13);
  });
});
