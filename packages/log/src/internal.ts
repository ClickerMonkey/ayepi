/**
 * # @ayepi/log internals
 *
 * Shared, dependency-free building blocks used by every entry: the level table,
 * the collision-renaming context {@link merge}, {@link deepEqual}, error
 * serialization, the {@link AsyncLocalStorage}-backed trace context + {@link runWith}
 * (the `logWith` core), record building, and formatting.
 *
 * @module
 */

import { AsyncLocalStorage } from 'node:async_hooks';

/* ---- tunable constants ---- */
/** Severity ordering — lower = more verbose. The threshold emits levels `>=` it. */
export const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 } as const;
/** Default threshold. */
export const DEFAULT_LEVEL: Level = 'info';
/** Text format by default; the file transport overrides to JSON. */
export const DEFAULT_STRUCTURED = false;
/** Console interception is opt-in (no import side effects). */
export const DEFAULT_INTERCEPT = false;
/** Give up suffixing after this many collisions (guards pathological loops). The first suffix is `key2`. */
const SUFFIX_MAX = 100;
/** Reserved top-level record fields — never treated as merge data, kept on the bare key. */
export const RESERVED = ['tms', 'level', 'msg', 'error', 'additionalErrors'] as const;
/** Default `console` method → level mapping for interception (the logging-output methods). */
export const CONSOLE_LEVEL_MAP: Readonly<Record<string, Level>> = {
  log: 'info',
  info: 'info',
  debug: 'debug',
  warn: 'warn',
  error: 'error',
  trace: 'debug',
  dir: 'info',
};
/** Default `cause` recursion depth for error serialization. */
const DEFAULT_MAX_CAUSE_DEPTH = 5;
/** Symbol under which `logWith` stashes the full merged context onto a rejected error. `Symbol.for` → stable across bundled entries. */
export const LOG_CONTEXT = Symbol.for('@ayepi/log:ctx');
/** Placeholder substituted for a value whose resolution (a `toLOG`/`toJSON` hook, a `logMaybe`, a promise) threw or rejected. */
export const UNRESOLVED = '(unresolved value)';

/* ---- shared types ---- */
/** The log levels, in console-method parity. */
export type Level = 'debug' | 'info' | 'warn' | 'error';

/** A finished, fully-merged log record. Always carries the reserved fields. */
export interface LogRecord {
  /** Timestamp — ISO string by default, numeric epoch ms when `timestamp:'epoch'`. */
  readonly tms: string | number;
  readonly level: Level;
  readonly msg: string;
  /** Serialized primary error (the first `Error` arg). */
  readonly error?: SerializedError;
  /** Serialized 2nd+ `Error` args. */
  readonly additionalErrors?: readonly SerializedError[];
  /** Merged fields (ambient context + object args + error-attached context). */
  readonly [key: string]: unknown;
}

/** A serialized `Error`: standard fields, depth-bounded `cause`, and own enumerable props. */
export interface SerializedError {
  readonly name: string;
  readonly message: string;
  readonly stack?: string;
  readonly cause?: unknown;
  readonly [key: string]: unknown;
}

/** What to capture when serializing an `Error`. */
export interface ErrorCaptureConfig {
  /** Include `error.stack` (default `true`). */
  readonly stack?: boolean;
  /** Recurse into `error.cause` (default `true`). */
  readonly cause?: boolean;
  /** Include own enumerable non-standard props like `code`/`statusCode` (default `true`). */
  readonly fields?: boolean;
  /** Max `cause` recursion depth (default 5). */
  readonly maxCauseDepth?: number;
}

/** Error capture config plus per-level overrides ("what is captured at each level"). */
export interface ErrorConfig extends ErrorCaptureConfig {
  /** Per-level overrides, shallow-merged over the base (e.g. drop stacks below `error`). */
  readonly perLevel?: Partial<Record<Level, ErrorCaptureConfig>>;
}

/** A sink for finished records. */
export interface Transport {
  /** A name, for debugging. */
  readonly name: string;
  /** Write one record; `text` is the pre-formatted line. May be async; the logger never awaits it. */
  write(record: LogRecord, text: string): void | Promise<void>;
  /** Optional: drain any buffered writes to their destination (without tearing the transport down). */
  flush?(): void | Promise<void>;
  /** Optional: flush and release resources (timers, file handles). The transport isn't used after. */
  close?(): void | Promise<void>;
}

/**
 * Shape a value the logger doesn't own (and so can't carry a {@link logMaybe}/`toLOG` hook) —
 * e.g. a `Request`, `URL`, `Buffer`, or a third-party class. Return the replacement shape, or
 * `undefined` to decline (the next serializer, then `toLOG`/`toJSON`/a structural copy, is tried).
 * Applied at **every depth**. Configured via `LoggerConfig.serializers`.
 */
export type Serializer = (value: object) => unknown;

/* ---- deep equality (for merge dedup) ---- */
/** Recursive structural equality. Handles primitives, `Date`, arrays, `Error`, plain objects, and cycles. */
export function deepEqual(a: unknown, b: unknown, seen = new WeakMap<object, object>()): boolean {
  if (Object.is(a, b)) {return true;}
  if (typeof a !== typeof b || a === null || b === null || typeof a !== 'object') {return false;}
  const ao = a as object;
  const bo = b as object;
  if (seen.get(ao) === bo) {return true;}
  seen.set(ao, bo);
  if (a instanceof Date || b instanceof Date) {return a instanceof Date && b instanceof Date && a.getTime() === b.getTime();}
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) {return false;}
    return a.every((x, i) => deepEqual(x, b[i], seen));
  }
  if (a instanceof Error || b instanceof Error) {return a instanceof Error && b instanceof Error && a.name === b.name && a.message === b.message;}
  const ar = a as Record<string, unknown>;
  const br = b as Record<string, unknown>;
  const ak = Object.keys(ar);
  if (ak.length !== Object.keys(br).length) {return false;}
  return ak.every((k) => k in br && deepEqual(ar[k], br[k], seen));
}

/* ---- collision-renaming merge ---- */
/**
 * Merge `b` into `a` immutably. `a` keeps all of its own keys; each key of `b` is
 * placed in the first slot among `key, key2, key3, …` that is free **or** already
 * deep-equals `b`'s value (dedup). Returns a **new** object — neither input is
 * mutated.
 */
export function merge(a: Record<string, unknown>, b: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = { ...a };
  for (const key of Object.keys(b)) {
    const v = b[key];
    let placed = false;
    for (let i = 1; i <= SUFFIX_MAX; i++) {
      const slot = i === 1 ? key : `${key}${i}`; // i=1 → key, i=2 → key2 (SUFFIX_START), …
      if (!(slot in result)) {
        result[slot] = v;
        placed = true;
        break;
      }
      if (deepEqual(result[slot], v)) {
        placed = true; // identical value already present — drop b's
        break;
      }
    }
    if (!placed) {result[`${key}${SUFFIX_MAX}_overflow`] = v;}
  }
  return result;
}

/* ---- error serialization ---- */
/** Serialize `err` per `cfg` (stack/cause/fields, depth-bounded). Non-`Error` values become `{ name:'NonError', message }`. */
export function serializeError(err: unknown, cfg: ErrorCaptureConfig = {}, depth = 0): SerializedError {
  if (!(err instanceof Error)) {return { name: 'NonError', message: typeof err === 'string' ? err : safeString(err) };}
  const out: { name: string; message: string; stack?: string; cause?: unknown; [k: string]: unknown } = { name: err.name, message: err.message };
  if (cfg.stack !== false && err.stack) {out.stack = err.stack;}
  const cause = (err as { cause?: unknown }).cause;
  if (cfg.cause !== false && cause !== undefined && depth < (cfg.maxCauseDepth ?? DEFAULT_MAX_CAUSE_DEPTH)) {
    out.cause = cause instanceof Error ? serializeError(cause, cfg, depth + 1) : cause;
  }
  if (cfg.fields !== false) {
    const rec = err as unknown as Record<string, unknown>; // internal cast: read own enumerable props off the Error
    for (const k of Object.keys(err)) {
      if (k === 'name' || k === 'message' || k === 'stack' || k === 'cause') {continue;}
      out[k] = rec[k];
    }
  }
  return out;
}

function safeString(v: unknown): string {
  try {
    return String(v);
  } catch {
    return '[unstringifiable]';
  }
}

/* ---- async-local trace context + logWith ---- */
const store = new AsyncLocalStorage<Record<string, unknown>>();

/** The current merged `logWith` context (empty object outside any `logWith`). */
export const getContext = (): Record<string, unknown> => store.getStore() ?? {};

/** Attach the full context to a rejected error under {@link LOG_CONTEXT} — only if not already present (innermost wins). */
function attachContext(err: unknown, ctx: Record<string, unknown>): void {
  if (err !== null && typeof err === 'object' && !(LOG_CONTEXT in err)) {
    Object.defineProperty(err, LOG_CONTEXT, { value: ctx, enumerable: false, configurable: true, writable: true });
  }
}

/** The core of `logWith`: merge `add` into the current context, run `inner` within it, tag promise rejections. */
export function runWith<R>(add: object, inner: () => R): R {
  const merged = merge(getContext(), add as Record<string, unknown>);
  return store.run(merged, () => {
    const out = inner();
    if (out !== null && typeof out === 'object' && typeof (out as { then?: unknown }).then === 'function') {
      const p = out as unknown as Promise<unknown>; // internal cast: narrow the thenable
      return p.then(
        (v) => v,
        (err: unknown) => {
          attachContext(err, merged);
          throw err;
        },
      ) as unknown as R; // internal cast: preserve the caller's R through the promise branch
    }
    return out;
  });
}

/* ---- record building ---- */
/** Inputs the logger supplies to {@link buildRecord}. */
export interface BuildOptions {
  readonly now: () => number;
  readonly timestamp: 'iso' | 'epoch';
  readonly error: ErrorConfig;
}

const effectiveErrorCfg = (level: Level, cfg: ErrorConfig): ErrorCaptureConfig => {
  const { perLevel, ...base } = cfg;
  return { ...base, ...perLevel?.[level] };
};

/** Resolution-time options (internal): error reporting + the app's custom {@link Serializer}s. */
interface ResolveOptions {
  readonly onError?: (err: unknown) => void;
  readonly serializers?: readonly Serializer[];
}

/** Try each serializer in turn; the first that returns non-`undefined` wins (a throw declines + reports). */
function runSerializers(value: object, serializers: readonly Serializer[], opts: ResolveOptions): unknown {
  for (const s of serializers) {
    let out: unknown;
    try {
      out = s(value);
    } catch (err) {
      opts.onError?.(err);
      continue; // a throwing serializer declines, like returning undefined
    }
    if (out !== undefined) {return out;}
  }
  return undefined; // none handled it
}
/** A serialization hook (`toLOG`/`toJSON`) — receives the property key like `JSON.stringify` does. */
type Hook = (key: string) => unknown;

/** Call a hook, substituting {@link UNRESOLVED} (and reporting) if it throws — logging is best-effort. */
function safeCall(fn: Hook, ctx: object, key: string, opts: ResolveOptions): unknown {
  try {
    return fn.call(ctx, key);
  } catch (err) {
    opts.onError?.(err);
    return UNRESOLVED;
  }
}

/**
 * The resolver core (see {@link resolveLogValue}). `opts.onError` observes a throwing hook or a
 * rejecting promise; without it, such failures still degrade to {@link UNRESOLVED} (rejections
 * propagate to the awaiter). A `toLOG`/`toJSON`/promise may resolve asynchronously: the returned
 * structure then carries embedded promises, which {@link settleDeep} awaits before the record is built.
 */
export function resolveLog(value: unknown, key: string, seen: WeakSet<object>, opts: ResolveOptions): unknown {
  if (value === null || typeof value !== 'object') {return value;}
  if (opts.serializers) {
    const s = runSerializers(value, opts.serializers, opts); // app-configured serializers win over the value's own hooks
    if (s !== undefined) {return resolveLog(s, key, seen, opts);}
  }
  if (value instanceof Error) {return value;} // Errors get dedicated serialization in buildRecord
  if (isThenable(value)) {
    return (value as PromiseLike<unknown>).then(
      (r) => resolveLog(r, key, seen, opts), // re-resolve the awaited value (it may have its own hooks)
      (err) => {
        opts.onError?.(err);
        return UNRESOLVED;
      },
    );
  }
  const toLog = (value as { toLOG?: unknown }).toLOG;
  if (typeof toLog === 'function') {return resolveLog(safeCall(toLog as Hook, value, key, opts), key, seen, opts);} // log-specific, wins over toJSON
  const toJson = (value as { toJSON?: unknown }).toJSON;
  if (typeof toJson === 'function') {return resolveLog(safeCall(toJson as Hook, value, key, opts), key, seen, opts);}
  if (seen.has(value)) {return value;} // cycle — leave the original ref for the formatter to handle
  seen.add(value);
  if (Array.isArray(value)) {return value.map((v, i) => resolveLog(v, String(i), seen, opts));}
  const src = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(src)) {out[k] = resolveLog(src[k], k, seen, opts);}
  return out;
}

/**
 * Resolve a value to its **loggable plain shape**, deeply and eagerly — so a logged value carries
 * its intended shape everywhere consistently: in the record object the transports receive, through
 * the `sanitize` pass, and in both the JSON and text output (not just incidentally when a formatter
 * happens to stringify it). Two serialization hooks are honored before a structural copy:
 *
 * 1. **`toLOG()`** — a logging-specific hook that **takes precedence**: when present, the value
 *    becomes its result. Use it to shape a value for logs alone, without affecting `JSON.stringify`
 *    / API responses (which still use `toJSON`). It may return a **promise** (resolved before the
 *    record is built).
 * 2. **`toJSON(key)`** — the standard hook `JSON.stringify` uses (e.g. `Date`).
 *
 * Objects/arrays without either hook are rebuilt from their own enumerable entries (mirroring
 * `JSON.stringify`); `Error`s and primitives pass through; cycles are left as the original
 * reference. A promise anywhere (an async hook, or a raw promise value) becomes its awaited result.
 */
export function resolveLogValue(value: unknown, key = '', seen = new WeakSet<object>()): unknown {
  return resolveLog(value, key, seen, {});
}

/** True if `value` is, or (deeply) contains, a thenable — i.e. resolving it needs an async pass. */
export function containsThenable(value: unknown, seen = new WeakSet<object>()): boolean {
  if (isThenable(value)) {return true;}
  if (value === null || typeof value !== 'object' || seen.has(value)) {return false;}
  seen.add(value);
  if (Array.isArray(value)) {return value.some((v) => containsThenable(v, seen));}
  return Object.values(value as Record<string, unknown>).some((v) => containsThenable(v, seen));
}

/** Await every embedded promise in an already-resolved structure, yielding plain data. */
export async function settleDeep(value: unknown, seen = new WeakSet<object>()): Promise<unknown> {
  if (isThenable(value)) {return settleDeep(await value, seen);} // the awaited value may itself contain promises
  if (value === null || typeof value !== 'object') {return value;}
  if (seen.has(value)) {return value;} // cycle — leave the ref for the formatter's circular guard
  seen.add(value);
  if (Array.isArray(value)) {return Promise.all(value.map((v) => settleDeep(v, seen)));}
  const src = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(src)) {out[k] = await settleDeep(src[k], seen);}
  return out;
}

/**
 * Build a {@link LogRecord} from `log()` args. `msg` is the space-joined non-object
 * args; objects and the ambient context are merged (ambient keeps bare keys);
 * `Error` args become `error`/`additionalErrors` and contribute any attached
 * trace context.
 */
export function buildRecord(level: Level, args: readonly unknown[], opts: BuildOptions): LogRecord {
  const tms = opts.timestamp === 'epoch' ? opts.now() : new Date(opts.now()).toISOString();

  const msgParts: string[] = [];
  const objects: Record<string, unknown>[] = [];
  const errors: Error[] = [];
  for (const arg of args) {
    // args arrive already resolved (toLOG/toJSON/promises handled in the logger's emit): an object
    // merges as fields, an Error takes the dedicated error path, anything else joins `msg`.
    if (arg instanceof Error) {errors.push(arg);}
    else if (arg !== null && typeof arg === 'object') {objects.push(arg as Record<string, unknown>);}
    else {msgParts.push(safeString(arg));}
  }

  const errCfg = effectiveErrorCfg(level, opts.error);
  let error: SerializedError | undefined;
  const additionalErrors: SerializedError[] = [];
  const errorContexts: Record<string, unknown>[] = [];
  errors.forEach((e, i) => {
    const ser = serializeError(e, errCfg);
    if (i === 0) {error = ser;}
    else {additionalErrors.push(ser);}
    const attached = (e as unknown as { [k: symbol]: unknown })[LOG_CONTEXT]; // internal cast: read the LOG_CONTEXT symbol off the Error
    if (attached !== null && typeof attached === 'object') {errorContexts.push(attached as Record<string, unknown>);}
  });

  // reserved → ambient context → object args → error-attached context (ambient wins bare keys)
  let record: Record<string, unknown> = { tms, level, msg: msgParts.join(' ') };
  if (error) {record.error = error;}
  if (additionalErrors.length) {record.additionalErrors = additionalErrors;}
  record = merge(record, getContext());
  for (const o of objects) {record = merge(record, o);}
  for (const c of errorContexts) {record = merge(record, c);}
  return record as LogRecord;
}

/* ---- formatting ---- */
const renderValue = (v: unknown): string => {
  if (typeof v === 'string') {return v;}
  if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'bigint') {return String(v);}
  if (v === null || v === undefined) {return String(v);}
  try {
    return JSON.stringify(v) ?? safeString(v);
  } catch {
    return safeString(v);
  }
};

/** `[tms] level msg key=value, key=value` plus a trailing `error=Name: message`. */
export function formatText(record: LogRecord): string {
  const { tms, level, msg, error, additionalErrors, ...rest } = record;
  let line = `[${String(tms)}] ${level} ${msg}`.trimEnd();
  const pairs = Object.entries(rest).map(([k, v]) => `${k}=${renderValue(v)}`);
  if (pairs.length) {line += ` ${pairs.join(', ')}`;}
  if (error) {line += ` error=${error.name}: ${error.message}`;}
  if (additionalErrors && additionalErrors.length) {line += ` (+${additionalErrors.length} more)`;}
  return line;
}

/** Stable JSON, dropping `undefined` and guarding residual cycles. */
export function formatJson(record: LogRecord): string {
  const seen = new WeakSet<object>();
  return JSON.stringify(record, (_k, v: unknown) => {
    if (v === undefined) {return undefined;}
    if (v !== null && typeof v === 'object') {
      if (seen.has(v)) {return '[Circular]';}
      seen.add(v);
    }
    return v;
  });
}

/* ---- lazy ("maybe") log values ---- */

/** A value produced either synchronously or asynchronously. */
export type MaybePromise<T> = T | Promise<T>;

/** Symbol marking a {@link logMaybe} value; `Symbol.for` keeps it stable across bundled entries. */
export const LOG_MAYBE = Symbol.for('@ayepi/log:maybe');
/** Node's custom-inspect symbol, so a lazy value renders nicely under a non-intercepted `console.log`. */
const INSPECT = Symbol.for('nodejs.util.inspect.custom');

/** A deferred log argument produced by {@link logMaybe}. */
export interface LazyLogValue {
  /** Produce the value for `level` — invoked only when the line will actually be logged. */
  readonly [LOG_MAYBE]: (level: Level) => MaybePromise<unknown>;
  /** Best-effort **synchronous** rendering for the non-intercepted path (JSON / `console.log`). */
  toJSON(): unknown;
}

/** True for a thenable (a `Promise` or any `{ then(): … }`). */
export const isThenable = (v: unknown): v is PromiseLike<unknown> => v !== null && typeof v === 'object' && typeof (v as { then?: unknown }).then === 'function';

/** True for a {@link logMaybe} marker. */
export const isLazy = (v: unknown): v is LazyLogValue => v !== null && typeof v === 'object' && LOG_MAYBE in v;

/**
 * Defer an expensive log argument. The function runs **only if** the line will actually be
 * logged (its level passes the threshold): under console interception the structured pipeline
 * calls it (with the record's level) and awaits the result, treating it as a normal argument.
 * On the non-intercepted path `toJSON` (and Node's inspect) render the synchronous value, or
 * `'(unresolved value)'` when the function returns a promise that can't be awaited there.
 *
 * ```ts
 * log.debug('state', logMaybe(() => expensiveSnapshot())) // snapshot built only at debug level
 * ```
 */
export function logMaybe(fn: (level: Level) => MaybePromise<unknown>): LazyLogValue {
  const render = (): unknown => {
    let v: unknown;
    try {
      v = fn('info'); // the sync path has no record level — assume the common 'info'
    } catch {
      return UNRESOLVED;
    }
    return isThenable(v) ? UNRESOLVED : v;
  };
  const value = { [LOG_MAYBE]: fn, toJSON: render, [INSPECT]: render }; // also custom-inspect for non-intercepted console
  return value;
}

/* ---- record sanitization (redaction / truncation) ---- */

/** Options for {@link createSanitizer} (and `LoggerConfig.sanitize`). */
export interface SanitizeOptions {
  /** Decide whether a built record is logged at all — return `false` to drop it. Runs first. */
  readonly filter?: (record: LogRecord) => boolean;
  /** Property names whose values are masked — a `string` (case-insensitive exact match) or a `RegExp`. Matched at any depth. */
  readonly sensitiveKeys?: readonly (string | RegExp)[];
  /** String **values** are masked when they match — a `string` (case-insensitive substring) or a `RegExp`. */
  readonly sensitiveValues?: readonly (string | RegExp)[];
  /** Turn a sensitive value into its masked form (default `() => '[redacted]'`; see {@link partialMask}). */
  readonly mask?: (value: unknown, key?: string) => unknown;
  /** Truncate any string longer than this many characters, appending `'... (+N more)'`. */
  readonly maxStringLength?: number;
  /** Truncate a **homogeneous** array (all elements the same kind) beyond this many, appending a `'(+N more)'` element. */
  readonly maxArrayLength?: number;
}

const DEFAULT_MASK = (): string => '[redacted]';

/**
 * A {@link SanitizeOptions.mask} that keeps the first `keep` characters and replaces the rest
 * with `fill` (e.g. `partialMask(3)('secret-token') === 'sec***'`). Values no longer than
 * `keep` are fully masked, so nothing short leaks. With the default `keep` of 0 it masks fully.
 */
export function partialMask(keep = 0, fill = '***'): (value: unknown) => string {
  return (value) => {
    const s = typeof value === 'string' ? value : safeString(value);
    return s.length <= keep ? fill : s.slice(0, keep) + fill;
  };
}

const matchKey = (key: string, patterns: readonly (string | RegExp)[]): boolean =>
  patterns.some((p) => (typeof p === 'string' ? p.toLowerCase() === key.toLowerCase() : p.test(key)));
const matchValue = (val: string, patterns: readonly (string | RegExp)[]): boolean =>
  patterns.some((p) => (typeof p === 'string' ? val.toLowerCase().includes(p.toLowerCase()) : p.test(val)));

const kindOf = (v: unknown): string => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v);
const isHomogeneous = (arr: readonly unknown[]): boolean => {
  const k = kindOf(arr[0]);
  return arr.every((e) => kindOf(e) === k);
};
const isPlainObject = (v: object): boolean => {
  const proto = Object.getPrototypeOf(v) as object | null;
  return proto === Object.prototype || proto === null;
};
const truncateString = (s: string, max: number): string => `${s.slice(0, max)}... (+${s.length - max} more)`;

/**
 * Build a record transformer that redacts sensitive keys/values and truncates long
 * strings/arrays per {@link SanitizeOptions}. Returns the (new) record, or `null` to drop it
 * (the `filter` returned `false`) — the same shape as `LoggerConfig.filter`, so it composes
 * there too. Only plain objects and arrays are walked; `Date`/class instances/{@link logMaybe}
 * markers pass through untouched, and the reserved `tms`/`level` fields are left pristine.
 */
export function createSanitizer(opts: SanitizeOptions): (record: LogRecord) => LogRecord | null {
  const mask = opts.mask ?? DEFAULT_MASK;
  const keys = opts.sensitiveKeys ?? [];
  const values = opts.sensitiveValues ?? [];
  const maxStr = opts.maxStringLength;
  const maxArr = opts.maxArrayLength;

  const visit = (value: unknown, key: string | undefined, seen: WeakSet<object>): unknown => {
    if (key !== undefined && keys.length > 0 && matchKey(key, keys)) {return mask(value, key);}
    if (typeof value === 'string') {
      if (values.length > 0 && matchValue(value, values)) {return mask(value, key);}
      if (maxStr !== undefined && value.length > maxStr) {return truncateString(value, maxStr);}
      return value;
    }
    if (value === null || typeof value !== 'object' || isLazy(value)) {return value;}
    if (seen.has(value)) {return value;} // cycle / shared ref — leave it for the formatter
    if (Array.isArray(value)) {
      seen.add(value);
      let kept = value;
      let extra = 0;
      if (maxArr !== undefined && value.length > maxArr && isHomogeneous(value)) {
        extra = value.length - maxArr;
        kept = value.slice(0, maxArr);
      }
      const out = kept.map((e) => visit(e, undefined, seen));
      if (extra > 0) {out.push(`(+${extra} more)`);}
      return out;
    }
    if (!isPlainObject(value)) {return value;} // Date, class instances, … pass through untouched
    seen.add(value);
    const src = value as Record<string, unknown>;
    const masked: Record<string, unknown> = {};
    for (const k of Object.keys(src)) {masked[k] = visit(src[k], k, seen);}
    return masked;
  };

  return (record) => {
    if (opts.filter && !opts.filter(record)) {return null;}
    const seen = new WeakSet<object>();
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(record)) {
      out[k] = k === 'tms' || k === 'level' ? record[k] : visit(record[k], k, seen); // keep reserved structural fields pristine
    }
    return out as LogRecord;
  };
}
