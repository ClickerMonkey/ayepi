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
  LOG_MAYBE,
  UNRESOLVED,
  deepEqual,
  merge,
  serializeError,
  getContext,
  runWith,
  buildRecord,
  formatText,
  formatJson,
  isLazy,
  logMaybe,
  createSanitizer,
  partialMask,
  resolveLogValue,
  resolveLog,
  containsThenable,
  settleDeep,
} from './internal';
import type { Level, LogRecord, SerializedError, ErrorConfig, ErrorCaptureConfig, Transport, SanitizeOptions, LazyLogValue, MaybePromise, Serializer } from './internal';

export { LOG_CONTEXT, deepEqual, merge, serializeError, getContext, logMaybe, createSanitizer, partialMask, resolveLogValue };
export type { Level, LogRecord, SerializedError, ErrorConfig, ErrorCaptureConfig, Transport, SanitizeOptions, LazyLogValue, MaybePromise, Serializer };

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
   * to drop the log entirely. Runs **before** {@link sanitize}.
   */
  readonly filter?: (record: LogRecord) => LogRecord | null | undefined;
  /**
   * Declarative redaction/truncation applied to every record (after {@link filter}): drop via a
   * `filter` predicate, mask `sensitiveKeys`/`sensitiveValues`, and cap `maxStringLength` /
   * `maxArrayLength`. Applies to direct logger calls **and** intercepted `console.*`. (Equivalent
   * to passing `createSanitizer(opts)` as `filter`, but it composes after your own `filter`.)
   */
  readonly sanitize?: SanitizeOptions;
  /**
   * Observe an error from the logging pipeline itself — a throwing `filter`, an
   * unserializable record, or a transport whose `write` throws. Logging is **best-effort**:
   * such an error never propagates to the caller (the line is dropped); this hook just lets
   * you notice (e.g. count a metric, write to `stderr`). Off by default. It must not throw;
   * if it does, the throw is ignored.
   */
  readonly onError?: (err: unknown) => void;
  /**
   * Custom {@link Serializer}s for values the logger doesn't own (a `Request`, `URL`, `Buffer`,
   * a third-party class…) — the predicate-style counterpart to a `toLOG`/`toJSON` hook. Each is
   * tried in order at every depth; the first non-`undefined` result wins (taking precedence over
   * the value's own `toLOG`/`toJSON`). They apply to direct calls and intercepted `console.*`.
   */
  readonly serializers?: readonly Serializer[];
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
  /** Change the minimum emitted level at runtime (e.g. bump to `'debug'` on demand). */
  setLevel(level: Level): void;
  /** Whether a record at `level` would be emitted at the current threshold — guard expensive prep. */
  isLevelEnabled(level: Level): boolean;
  /** Drain every transport's buffered writes (e.g. the file transport) without closing them. */
  flush(): Promise<void>;
  /** Flush **and** close every transport (release timers/handles) — wire to a shutdown hook. */
  close(): Promise<void>;
  /** The effective level/format/timestamp (`level` reflects {@link setLevel}). */
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
  let level = config.level ?? DEFAULT_LEVEL; // mutable: see setLevel
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

  const sanitize = config.sanitize ? createSanitizer(config.sanitize) : undefined;
  const resolveOpts = { onError: report, serializers: config.serializers }; // shared per-arg resolution options

  /** Build → filter → sanitize → format → write a record from already-resolved args. */
  const deliver = (lvl: Level, args: readonly unknown[]): void => {
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
      if (sanitize) {
        const cleaned = sanitize(record);
        if (!cleaned) {return;} // dropped by sanitize.filter
        record = cleaned;
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

  /** Produce a {@link logMaybe}'s value for this level (only now that we know we'll log), or pass through. */
  const seedArg = (raw: unknown, lvl: Level): unknown => {
    if (!isLazy(raw)) {return raw;}
    try {
      return raw[LOG_MAYBE](lvl);
    } catch (err) {
      report(err);
      return UNRESOLVED;
    }
  };

  const emit = (lvl: Level, args: readonly unknown[]): void => {
    if (LEVELS[lvl] < LEVELS[level] || writing) {return;} // below threshold → never touch (or run) the args
    // resolve toLOG/toJSON/logMaybe/promises into loggable shapes up front (best-effort).
    let resolved: unknown[];
    try {
      resolved = args.map((raw) => resolveLog(seedArg(raw, lvl), '', new WeakSet(), resolveOpts));
    } catch (err) {
      report(err); // a throwing hook *getter* (the call itself is already guarded) — drop the line
      return;
    }
    // a synchronous line delivers immediately; only an async toLOG / logMaybe / promise defers it.
    if (resolved.some((v) => containsThenable(v))) {
      void settleDeep(resolved)
        .then((settled) => deliver(lvl, settled as unknown[]))
        .catch(report);
    } else {
      deliver(lvl, resolved);
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

  /** Run `op` over every transport in parallel, awaiting all and reporting (never throwing) failures. */
  const drain = (op: (t: Transport) => void | Promise<void>): Promise<void> =>
    Promise.all(
      transports.map(async (t) => {
        try {
          await op(t);
        } catch (err) {
          report(err); // one transport's flush/close failure must not abort the rest
        }
      }),
    ).then(() => undefined);

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
    setLevel: (l) => {
      level = l;
    },
    isLevelEnabled: (l) => LEVELS[l] >= LEVELS[level],
    flush: () => drain((t) => t.flush?.()),
    close: () => drain((t) => t.close?.()),
    config: {
      get level() {
        return level; // reflects setLevel
      },
      structured,
      timestamp,
    },
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
