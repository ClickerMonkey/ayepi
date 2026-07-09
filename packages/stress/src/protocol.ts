/**
 * The tiny stdout contract between a spawned target and the parent runner.
 *
 * A target entry prints exactly one line beginning with {@link READY_PREFIX} followed by a JSON
 * `{ url, statsUrl, port }` once it is listening. Any module that boots an ayepi server can play
 * the "target" role by printing this line — that's how you point the harness at your own app.
 *
 * @module
 */

/** Prefix of the single readiness line a target prints to stdout once listening. */
export const READY_PREFIX = '@ayepi/stress:ready ';

/** The JSON payload following {@link READY_PREFIX}. */
export interface ReadyLine {
  readonly url: string;
  readonly statsUrl?: string;
  readonly port?: number;
}

/** Env var carrying the JSON `BootOptions` the built-in entry reads. */
export const TARGET_ENV = 'AYEPI_STRESS_TARGET';

/** IPC message the parent sends to ask a target to shut down gracefully (cross-platform, unlike POSIX signals on Windows). */
export const SHUTDOWN_MSG = 'ayepi-stress:shutdown';

/** Format a readiness line for stdout. */
export function readyLine(info: ReadyLine): string {
  return `${READY_PREFIX}${JSON.stringify(info)}\n`;
}

/** Parse a readiness line, or return `undefined` if this isn't one. */
export function parseReady(line: string): ReadyLine | undefined {
  if (!line.startsWith(READY_PREFIX)) {return undefined;}
  try {
    return JSON.parse(line.slice(READY_PREFIX.length)) as ReadyLine;
  } catch {
    return undefined;
  }
}
