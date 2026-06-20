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
  /** Optional flush/close. */
  close?(): void | Promise<void>;
}

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
