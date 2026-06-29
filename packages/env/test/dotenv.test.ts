import { describe, it, expect } from 'vitest';
import { parseDotenv } from '../src/dotenv';

describe('parseDotenv', () => {
  it('parses assignments with export, comments, and blank lines', () => {
    const out = parseDotenv(['# a comment', '', 'export PORT=8080', 'NAME = svc', 'EMPTY='].join('\n'));
    expect(out).toEqual({ PORT: '8080', NAME: 'svc', EMPTY: '' });
  });

  it('handles double-quoted values with escapes', () => {
    const out = parseDotenv('MSG="line1\\nline2\\t\\r\\"q\\"\\\\"');
    expect(out.MSG).toBe('line1\nline2\t\r"q"\\');
  });

  it('treats single-quoted values literally', () => {
    expect(parseDotenv("RAW='no $interp \\n here'").RAW).toBe('no $interp \\n here');
  });

  it('strips a trailing comment on unquoted values only', () => {
    expect(parseDotenv('URL=http://x # the url').URL).toBe('http://x');
    expect(parseDotenv('Q="a # b"').Q).toBe('a # b'); // inside quotes, kept
  });

  it('ignores malformed lines and lets the last assignment win', () => {
    const out = parseDotenv(['not a valid line', '123BAD=x', 'K=1', 'K=2'].join('\n'));
    expect(out).toEqual({ K: '2' });
  });
});
