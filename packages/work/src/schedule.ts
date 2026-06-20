/**
 * # Scheduling
 *
 * A recurring schedule fires either on a **5-field cron expression** (parsed by the
 * tiny dependency-free parser here) or on a **next-time function**. A ~1s tick checks
 * whether the next fire time has arrived; when it has, exactly one instance claims a
 * per-tick `setNX` lease and enqueues the work, so a cron never double-fires across a
 * fleet.
 *
 * @module
 */

import type { Store } from './ports';
import type { ScheduleConfig } from './types';
import type { Clock } from './internal';

/* ---- tiny 5-field cron parser ---- */

const MS_PER_MINUTE = 60_000;
/** Cap the forward scan so a never-matching expression can't loop forever (~1 year). */
const MAX_SCAN_MINUTES = 366 * 24 * 60;
/** `[min, max]` inclusive range for each of the five fields. */
const FIELD_BOUNDS: readonly [number, number][] = [
  [0, 59], // minute
  [0, 23], // hour
  [1, 31], // day of month
  [1, 12], // month
  [0, 6], // day of week (0 = Sunday)
];

/** Expand one cron field — `*`, a number, an `a-b` range, a `<range>/<step>`, or a comma list — into the set of matching numbers. */
function parseField(field: string, min: number, max: number): Set<number> {
  const out = new Set<number>();
  for (const part of field.split(',')) {
    const [rangePart, stepPart] = part.split('/');
    const step = stepPart ? Number(stepPart) : 1;
    if (!Number.isInteger(step) || step < 1) {throw new Error(`cron: bad step in "${part}"`);}
    let lo = min;
    let hi = max;
    if (rangePart !== '*' && rangePart !== '') {
      const [a, b] = rangePart!.split('-');
      lo = Number(a);
      hi = b !== undefined ? Number(b) : lo;
      if (!Number.isInteger(lo) || !Number.isInteger(hi) || lo < min || hi > max || lo > hi) {throw new Error(`cron: bad range "${part}"`);}
    }
    for (let v = lo; v <= hi; v += step) {out.add(v);}
  }
  return out;
}

/** A parsed cron expression: a matching set per field. */
interface CronFields {
  readonly minute: Set<number>;
  readonly hour: Set<number>;
  readonly dom: Set<number>;
  readonly month: Set<number>;
  readonly dow: Set<number>;
  /** Whether dom / dow were restricted (not `*`) — drives the OR semantics. */
  readonly domRestricted: boolean;
  readonly dowRestricted: boolean;
}

/** Parse a 5-field cron expression (`min hour dom mon dow`). */
export function parseCron(expr: string): CronFields {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) {throw new Error(`cron: expected 5 fields, got ${fields.length} in "${expr}"`);}
  const [minute, hour, dom, month, dow] = fields.map((f, i) => parseField(f, FIELD_BOUNDS[i]![0], FIELD_BOUNDS[i]![1]));
  return {
    minute: minute!,
    hour: hour!,
    dom: dom!,
    month: month!,
    dow: dow!,
    domRestricted: fields[2] !== '*',
    dowRestricted: fields[4] !== '*',
  };
}

/** Does `date` (local time) satisfy the cron fields? Standard dom/dow OR semantics when both are restricted. */
function matches(c: CronFields, date: Date): boolean {
  if (!c.minute.has(date.getMinutes()) || !c.hour.has(date.getHours()) || !c.month.has(date.getMonth() + 1)) {return false;}
  const domOk = c.dom.has(date.getDate());
  const dowOk = c.dow.has(date.getDay());
  if (c.domRestricted && c.dowRestricted) {return domOk || dowOk;}
  if (c.domRestricted) {return domOk;}
  if (c.dowRestricted) {return dowOk;}
  return true;
}

/**
 * The next epoch-ms strictly after `fromMs` that matches `expr`, or `undefined` if
 * none within ~a year. Minute-granular (cron's resolution).
 */
export function nextAfter(expr: string, fromMs: number): number | undefined {
  const c = parseCron(expr);
  // start at the top of the next minute after `from`
  const start = new Date(Math.floor(fromMs / MS_PER_MINUTE) * MS_PER_MINUTE + MS_PER_MINUTE);
  start.setSeconds(0, 0);
  for (let i = 0; i < MAX_SCAN_MINUTES; i++) {
    const candidate = new Date(start.getTime() + i * MS_PER_MINUTE);
    if (matches(c, candidate)) {return candidate.getTime();}
  }
  return undefined;
}

/* ---- scheduler loop ---- */

const unref = (t: { unref?: () => void }): void => void t.unref?.();

/** Engine-supplied dependencies for {@link startSchedule}. */
export interface ScheduleDeps {
  readonly store: Store;
  readonly now: Clock;
  /** Enqueue a fired instance by type + raw input. */
  enqueueRaw(type: string, input: unknown): void;
  readonly prefix: string;
  /** Tick interval (ms). */
  readonly tick: number;
  /** TTL for the per-fire distributed lease (ms). */
  readonly leaseTtl: number;
}

/** Compute the next fire time (epoch ms) for a schedule, or `undefined` to stop. */
function computeNext(config: ScheduleConfig, from: number): number | undefined {
  if (config.cron !== undefined) {return nextAfter(config.cron, from);}
  if (config.next) {
    const r = config.next(from);
    if (r === undefined || r === null) {return undefined;}
    return r instanceof Date ? r.getTime() : r;
  }
  throw new Error(`schedule "${config.name}": provide either "cron" or "next"`);
}

/**
 * Start a schedule's tick loop. Returns a cancel function. One instance fires per
 * occurrence (claimed via a `setNX` lease keyed by the fire's second-bucket).
 */
export function startSchedule(config: ScheduleConfig, deps: ScheduleDeps): () => void {
  let cancelled = false;
  let nextAt = computeNext(config, deps.now());
  let timer: ReturnType<typeof setTimeout>;

  const tick = async (): Promise<void> => {
    if (cancelled) {return;}
    const t = deps.now();
    if (nextAt !== undefined && t >= nextAt) {
      const bucket = Math.floor(nextAt / 1000);
      const won = await deps.store.setIfNotExists(`${deps.prefix}sched:${config.name}:${bucket}`, '1', deps.leaseTtl);
      if (won) {
        const inst = config.run();
        if (inst) {deps.enqueueRaw(inst.type, inst.input);}
      }
      nextAt = computeNext(config, deps.now());
    }
    if (!cancelled) {
      timer = setTimeout(() => void tick(), deps.tick);
      unref(timer);
    }
  };

  timer = setTimeout(() => void tick(), 0);
  unref(timer);
  return () => {
    cancelled = true;
    clearTimeout(timer);
  };
}
