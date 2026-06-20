/**
 * # @ayepi/log
 *
 * Structured logging with **AsyncLocalStorage trace context**. Stack context with
 * {@link logWith} and it flows through the whole async call tree (and onto thrown
 * errors); {@link log} builds a record from mixed primitive/object/Error args;
 * output goes to pluggable {@link Transport}s (console here, file via
 * `@ayepi/log/file`); console.* can be intercepted (opt-in).
 *
 * ```ts
 * import { createLogger } from '@ayepi/log'
 * const log = createLogger({ level: 'debug' })
 *
 * log.logWith({ reqId: 'abc' }, async () => {
 *   log.info('handling', { userId: 'u1' }) // → reqId + userId on the record
 *   await work()                            // a rejection here is tagged with { reqId, userId }
 * })
 * ```
 *
 * Bare `import` has **no side effects** — console interception is opt-in.
 *
 * @module
 */

import {
  LEVELS,
  DEFAULT_LEVEL,
  DEFAULT_STRUCTURED,
  DEFAULT_INTERCEPT,
  CONSOLE_LEVEL_MAP,
  LOG_CONTEXT,
  deepEqual,
  merge,
  serializeError,
  getContext,
  runWith,
  buildRecord,
  formatText,
  formatJson,
} from './internal';
import type { Level, LogRecord, SerializedError, ErrorConfig, ErrorCaptureConfig, Transport } from './internal';

export { LOG_CONTEXT, deepEqual, merge, serializeError, getContext };
export type { Level, LogRecord, SerializedError, ErrorConfig, ErrorCaptureConfig, Transport };

/** The minimal `console` surface the logger reads/intercepts (the global one, or your own). */
export interface ConsoleLike {
  log(...args: unknown[]): void;
  info(...args: unknown[]): void;
  debug(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
}

const noopConsole: ConsoleLike = { log() {}, info() {}, debug() {}, warn() {}, error() {} };
const globalConsole = (): ConsoleLike => (globalThis as { console?: ConsoleLike }).console ?? noopConsole;

/** Options for {@link consoleTransport}. */
export interface ConsoleTransportOptions {
  /** The console to **write through** — should be the original (pre-interception) console to avoid recursion. */
  readonly console?: ConsoleLike;
  /** Map a record level to a console method (default: error→error, warn→warn, debug→debug, else→log). */
  readonly method?: (level: Level) => keyof ConsoleLike;
}
const defaultMethod = (level: Level): keyof ConsoleLike => (level === 'error' ? 'error' : level === 'warn' ? 'warn' : level === 'debug' ? 'debug' : 'log');

/** A {@link Transport} that writes the formatted line to a console. */
export function consoleTransport(opts: ConsoleTransportOptions = {}): Transport {
  const target = opts.console ?? globalConsole();
  const pick = opts.method ?? defaultMethod;
  return {
    name: 'console',
    write(record, text) {
      target[pick(record.level)](text);
    },
  };
}

/** Configuration for {@link createLogger}. */
export interface LoggerConfig {
  /** Minimum level emitted (default `'info'`). Logs below this are dropped before a record is built. */
  readonly level?: Level;
  /** Structured JSON output vs `[tms] level msg key=value` text (default `false` = text). */
  readonly structured?: boolean;
  /** Timestamp format — ISO string (default) or numeric epoch ms. */
  readonly timestamp?: 'iso' | 'epoch';
  /** Transports to write to (default: a single {@link consoleTransport} bound to the captured original console). */
  readonly transports?: readonly Transport[];
  /** Intercept global `console.*` immediately (default `false` — opt-in). */
  readonly interceptConsole?: boolean;
  /** `console` method → level mapping for interception (default {@link CONSOLE_LEVEL_MAP}). */
  readonly consoleMap?: Readonly<Record<string, Level>>;
  /** The console to read originals from / intercept (default the global `console`). */
  readonly console?: ConsoleLike;
  /** Error serialization config, including per-level overrides. */
  readonly error?: ErrorConfig;
  /**
   * Final hook over the built record before it is formatted. Return a (possibly
   * modified) record to log it — e.g. redact or add fields — or `null`/`undefined`
   * to drop the log entirely.
   */
  readonly filter?: (record: LogRecord) => LogRecord | null | undefined;
  /**
   * Observe an error from the logging pipeline itself — a throwing `filter`, an
   * unserializable record, or a transport whose `write` throws. Logging is **best-effort**:
   * such an error never propagates to the caller (the line is dropped); this hook just lets
   * you notice (e.g. count a metric, write to `stderr`). Off by default. It must not throw;
   * if it does, the throw is ignored.
   */
  readonly onError?: (err: unknown) => void;
  /** Clock injection for tests (default `() => Date.now()`). */
  readonly now?: () => number;
}

/** A logger instance. */
export interface Logger {
  /** Emit a record at `level` from mixed primitive/object/Error args. No-op below the threshold. */
  log(level: Level, ...args: unknown[]): void;
  debug(...args: unknown[]): void;
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
  /** Merge `add` into the current trace context, run `inner` within it, and tag promise rejections with the context. */
  logWith<R>(add: object, inner: () => R): R;
  /** Snapshot of the current merged trace context (empty outside any `logWith`). */
  context(): Readonly<Record<string, unknown>>;
  /** Replace the transports at runtime. */
  setTransports(transports: readonly Transport[]): void;
  /** The effective level/format/timestamp. */
  readonly config: { readonly level: Level; readonly structured: boolean; readonly timestamp: 'iso' | 'epoch' };
  /** Begin intercepting `console.*` (idempotent); returns a restore function. */
  interceptConsole(): () => void;
  /** Restore any console interception this logger installed (idempotent). */
  restoreConsole(): void;
}

/** Capture the current console methods (bound) so the transport + restore use the originals. */
function captureConsole(c: ConsoleLike): ConsoleLike {
  return { log: c.log.bind(c), info: c.info.bind(c), debug: c.debug.bind(c), warn: c.warn.bind(c), error: c.error.bind(c) };
}

/**
 * Create a {@link Logger}.
 */
export function createLogger(config: LoggerConfig = {}): Logger {
  const level = config.level ?? DEFAULT_LEVEL;
  const structured = config.structured ?? DEFAULT_STRUCTURED;
  const timestamp = config.timestamp ?? 'iso';
  const now = config.now ?? (() => Date.now());
  const errorCfg: ErrorConfig = config.error ?? {};
  const consoleMap = config.consoleMap ?? CONSOLE_LEVEL_MAP;
  const targetConsole = config.console ?? globalConsole();
  const originals = captureConsole(targetConsole); // before any interception

  let transports: readonly Transport[] = config.transports ?? [consoleTransport({ console: originals })];
  let intercepting = false;
  let writing = false; // reentrancy guard (belt-and-suspenders if a transport logs)

  const report = (err: unknown): void => {
    try {
      config.onError?.(err);
    } catch {
      /* error reporting must never break the caller */
    }
  };

  const emit = (lvl: Level, args: readonly unknown[]): void => {
    if (LEVELS[lvl] < LEVELS[level] || writing) {return;}
    // building, filtering, and formatting the line are best-effort: a throw here (a bad
    // `filter`, an unserializable field) drops the line and is reported, never propagated.
    let record: LogRecord;
    let text: string;
    try {
      record = buildRecord(lvl, args, { now, timestamp, error: errorCfg });
      if (config.filter) {
        const filtered = config.filter(record);
        if (!filtered) {return;} // dropped by the filter
        record = filtered;
      }
      text = structured ? formatJson(record) : formatText(record);
    } catch (err) {
      report(err);
      return;
    }
    writing = true;
    try {
      for (const t of transports) {
        try {
          void t.write(record, text);
        } catch (err) {
          report(err); // a failing transport never breaks logging — now observable via onError
        }
      }
    } finally {
      writing = false;
    }
  };

  let installed: { method: string; original: unknown }[] = [];
  const restore = (): void => {
    if (!intercepting) {return;}
    intercepting = false;
    const c = targetConsole as unknown as Record<string, unknown>; // internal cast: write captured methods back onto the console
    for (const { method, original } of installed) {c[method] = original;}
    installed = [];
  };
  const install = (): (() => void) => {
    if (intercepting) {return restore;}
    intercepting = true;
    const c = targetConsole as unknown as Record<string, unknown>; // internal cast: replace console methods
    installed = [];
    for (const method of Object.keys(consoleMap)) {
      const lvl = consoleMap[method]!;
      installed.push({ method, original: c[method] }); // capture the true original for restore
      c[method] = (...args: unknown[]) => emit(lvl, args);
    }
    return restore;
  };

  const logger: Logger = {
    log: (lvl, ...args) => emit(lvl, args),
    debug: (...args) => emit('debug', args),
    info: (...args) => emit('info', args),
    warn: (...args) => emit('warn', args),
    error: (...args) => emit('error', args),
    logWith: (add, inner) => runWith(add, inner),
    context: () => Object.freeze({ ...getContext() }),
    setTransports: (t) => {
      transports = t;
    },
    config: { level, structured, timestamp },
    interceptConsole: install,
    restoreConsole: restore,
  };

  if (config.interceptConsole ?? DEFAULT_INTERCEPT) {install();}
  return logger;
}

/* ---- default instance + top-level convenience API ---- */
const instance = createLogger();

/** Emit a record at `level` on the default logger. */
export const log = (level: Level, ...args: unknown[]): void => instance.log(level, ...args);
export const debug = (...args: unknown[]): void => instance.debug(...args);
export const info = (...args: unknown[]): void => instance.info(...args);
export const warn = (...args: unknown[]): void => instance.warn(...args);
export const error = (...args: unknown[]): void => instance.error(...args);
/** Stack trace context on the default logger (and tag promise rejections). */
export const logWith = <R>(add: object, inner: () => R): R => instance.logWith(add, inner);
/** The default logger's current trace context. */
export const context = (): Readonly<Record<string, unknown>> => instance.context();
/** Intercept `console.*` through the default logger; returns a restore function. */
export const interceptConsole = (): (() => void) => instance.interceptConsole();
/** Restore console interception installed by the default logger. */
export const restoreConsole = (): void => instance.restoreConsole();
/** The default logger instance. */
export const logger = instance;
