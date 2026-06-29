/**
 * # `.env` parsing (pure, no filesystem)
 *
 * A small, dependency-free `.env` **string** parser. The filesystem reader lives in
 * `@ayepi/env/load`; this stays pure so it works anywhere and is easy to test.
 *
 * Supported: `KEY=value`, optional `export ` prefix, `#` comments (whole-line and trailing
 * on unquoted values), blank lines, single-quoted (literal) and double-quoted values
 * (with `\n`/`\t`/`\r`/`\\`/`\"` escapes). Malformed lines are ignored.
 *
 * @module
 */

const LINE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/;

/** Unescape the common backslash sequences inside a double-quoted value. */
function unescape(s: string): string {
  return s.replace(/\\([ntr"\\])/g, (_m, c: string) => (c === 'n' ? '\n' : c === 't' ? '\t' : c === 'r' ? '\r' : c));
}

/** Parse `.env` text into a flat record. Order matters: a later assignment wins. */
export function parseDotenv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trimStart();
    if (line === '' || line.startsWith('#')) {continue;}
    const m = LINE.exec(line);
    if (!m) {continue;}
    const key = m[1]!;
    let value = m[2]!;
    if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
      value = unescape(value.slice(1, -1));
    } else if (value.startsWith("'") && value.endsWith("'") && value.length >= 2) {
      value = value.slice(1, -1); // single quotes are literal
    } else {
      const hash = value.indexOf(' #'); // strip a trailing comment on an unquoted value
      if (hash !== -1) {value = value.slice(0, hash).trimEnd();}
    }
    out[key] = value;
  }
  return out;
}
