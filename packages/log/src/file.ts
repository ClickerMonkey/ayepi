/**
 * # @ayepi/log/file
 *
 * A Node file {@link Transport} with rotation, built for **heavy load**: `write()`
 * is non-blocking (it appends to an in-memory buffer and returns immediately), and
 * buffered lines are flushed to disk in **batches** — one append per flush, at most
 * one flush in flight — so callers never wait on I/O and the file system is not
 * overwhelmed by a syscall per line.
 *
 * Everything touching the file system is **asynchronous** (`node:fs/promises`),
 * including rotation/stat/prune, so a flush never blocks the event loop.
 *
 * **Size** rotation (default) keeps `app.log` bounded to `maxSize`, shifting
 * `app.log → app.log.1 → …` and pruning beyond `maxFiles`. **Date** rotation writes
 * `app-YYYY-MM-DD.log`. Defaults to structured JSON lines. Call `close()` (e.g. from
 * an `@ayepi/updown` shutdown hook) to flush the buffer on exit.
 *
 * `fs` and the clock are injectable for deterministic tests.
 *
 * @module
 */

import { appendFile, stat, mkdir, rename, unlink, readdir, access } from 'node:fs/promises';
import { dirname, basename, extname, join } from 'node:path';
import type { Transport } from './internal';
import { formatJson } from './internal';

/* ---- tunable constants ---- */
/** Rotate when the active file would exceed this size (10 MiB). */
const DEFAULT_MAX_SIZE = 10 * 1024 * 1024;
/** Keep at most this many rotated/dated files. */
const DEFAULT_MAX_FILES = 5;
/** Flush the buffer at most this often (ms). */
const DEFAULT_FLUSH_INTERVAL = 250;
/** Force an immediate flush once the buffer reaches this many bytes. */
const DEFAULT_MAX_BUFFER_BYTES = 256 * 1024;
const NEWLINE = '\n';
/** `YYYY-MM-DD` length from an ISO string. */
const DATE_KEY_LEN = 10;

/** The minimal **async** fs surface the transport uses (`node:fs/promises` satisfies it; tests inject their own). */
export interface FsLike {
  exists(path: string): Promise<boolean>;
  stat(path: string): Promise<{ size: number }>;
  mkdir(path: string, opts: { recursive: true }): Promise<void>;
  /** Asynchronous, batched append — the hot path. */
  appendFile(path: string, data: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  unlink(path: string): Promise<void>;
  readdir?(path: string): Promise<string[]>;
}

const exists = async (p: string): Promise<boolean> => {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
};
const nodeFs: FsLike = {
  exists,
  stat: (p) => stat(p).then((s) => ({ size: s.size })),
  mkdir: (p) => mkdir(p, { recursive: true }).then(() => undefined),
  appendFile: (p, d) => appendFile(p, d),
  rename: (a, b) => rename(a, b),
  unlink: (p) => unlink(p),
  readdir: (p) => readdir(p),
};

/** Options for {@link fileTransport}. */
export interface FileTransportOptions {
  /** Target file path (e.g. `'./logs/app.log'`). The directory is created if missing. */
  readonly path: string;
  /** Rotate when the active file would exceed this many bytes (default 10 MiB). */
  readonly maxSize?: number;
  /** Keep at most this many rotated/dated files (default 5). */
  readonly maxFiles?: number;
  /** Write structured JSON lines regardless of the logger's text/json setting (default `true`). */
  readonly structured?: boolean;
  /** Rotation strategy (default `'size'`). */
  readonly strategy?: 'size' | 'date';
  /** Flush the buffer at most this often, in ms (default 250). */
  readonly flushInterval?: number;
  /** Force an immediate flush once the buffer reaches this many bytes (default 256 KiB). */
  readonly maxBufferBytes?: number;
  /** Injected fs (default `node:fs/promises`). */
  readonly fs?: FsLike;
  /**
   * Observe a background **flush** failure (disk full, permission denied, rotation error).
   * File logging is best-effort — a failed flush is dropped and never rejects; this hook lets
   * you notice. Off by default. It must not throw; if it does, the throw is ignored.
   */
  readonly onError?: (err: unknown) => void;
  /** Injected clock for date rotation/naming (default `() => Date.now()`). */
  readonly now?: () => number;
}

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Create a non-blocking, batched Node file {@link Transport}. */
export function fileTransport(opts: FileTransportOptions): Transport {
  const fs = opts.fs ?? nodeFs;
  const maxSize = opts.maxSize ?? DEFAULT_MAX_SIZE;
  const maxFiles = opts.maxFiles ?? DEFAULT_MAX_FILES;
  const structured = opts.structured ?? true;
  const strategy = opts.strategy ?? 'size';
  const flushInterval = opts.flushInterval ?? DEFAULT_FLUSH_INTERVAL;
  const maxBufferBytes = opts.maxBufferBytes ?? DEFAULT_MAX_BUFFER_BYTES;
  const now = opts.now ?? (() => Date.now());

  const dir = dirname(opts.path);
  const ext = extname(opts.path);
  const base = basename(opts.path, ext);
  let dirEnsured = false;
  let lastDateKey: string | null = null;
  let knownSize = -1; // active-file size, lazily initialized to avoid a stat per write

  let buffer: string[] = [];
  let bufferBytes = 0;
  let flushing = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const ensureDir = async (): Promise<void> => {
    if (dirEnsured) {return;}
    if (dir && !(await fs.exists(dir))) {await fs.mkdir(dir, { recursive: true });}
    dirEnsured = true;
  };
  const dateKey = (): string => new Date(now()).toISOString().slice(0, DATE_KEY_LEN);
  const datedPath = (key: string): string => join(dir, `${base}-${key}${ext}`);

  /** Size rotation: drop the oldest, shift `.n → .n+1`, then `app.log → app.log.1`. */
  const rotateBySize = async (path: string): Promise<void> => {
    const oldest = `${path}.${maxFiles}`;
    if (await fs.exists(oldest)) {
      try {
        await fs.unlink(oldest);
      } catch {
        /* ignore */
      }
    }
    for (let i = maxFiles - 1; i >= 1; i--) {
      if (await fs.exists(`${path}.${i}`)) {await fs.rename(`${path}.${i}`, `${path}.${i + 1}`);}
    }
    if (await fs.exists(path)) {await fs.rename(path, `${path}.1`);}
  };

  const pruneDated = async (): Promise<void> => {
    if (!fs.readdir) {return;}
    const re = new RegExp(`^${escapeRegExp(base)}-(\\d{4}-\\d{2}-\\d{2})${escapeRegExp(ext)}$`);
    try {
      /* v8 ignore next */ // dirname() always yields at least '.', so the `|| '.'` fallback is unreachable defensive code
      const files = (await fs.readdir(dir || '.')).filter((f) => re.test(f)).sort(); // ISO dates sort chronologically
      while (files.length > maxFiles) {
        const old = files.shift()!;
        try {
          await fs.unlink(join(dir, old));
        } catch {
          /* ignore */
        }
      }
    } catch {
      /* ignore */
    }
  };

  const currentSize = async (path: string): Promise<number> => {
    if (!(await fs.exists(path))) {return 0;}
    try {
      return (await fs.stat(path)).size;
    } catch {
      return 0;
    }
  };

  async function flush(): Promise<void> {
    if (flushing || buffer.length === 0) {return;}
    flushing = true;
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    try {
      await ensureDir();
      const batch = buffer.join('');
      const batchBytes = bufferBytes;
      buffer = [];
      bufferBytes = 0;
      if (strategy === 'date') {
        const key = dateKey();
        if (key !== lastDateKey) {
          lastDateKey = key;
          await pruneDated();
        }
        await fs.appendFile(datedPath(key), batch);
      } else {
        if (knownSize < 0) {knownSize = await currentSize(opts.path);}
        if (knownSize > 0 && knownSize + batchBytes > maxSize) {
          await rotateBySize(opts.path);
          knownSize = 0;
        }
        await fs.appendFile(opts.path, batch);
        knownSize += batchBytes;
      }
    } catch (err) {
      /* file logging is best-effort — never reject, but let the caller observe the failure */
      try {
        opts.onError?.(err);
      } catch {
        /* error reporting must never throw out of a detached flush */
      }
    } finally {
      flushing = false;
      if (buffer.length > 0) {scheduleFlush();}
    }
  }

  function scheduleFlush(): void {
    if (timer || flushing) {return;}
    timer = setTimeout(() => {
      timer = null;
      void flush();
    }, flushInterval)
    ;(timer as { unref?: () => void }).unref?.();
  }

  return {
    name: 'file',
    write(record, text) {
      const line = (structured ? formatJson(record) : text) + NEWLINE;
      buffer.push(line);
      bufferBytes += Buffer.byteLength(line);
      if (bufferBytes >= maxBufferBytes) {void flush();}
      else {scheduleFlush();}
    },
    flush, // drain the buffer to disk on demand (e.g. logger.flush())
    async close() {
      await flush();
    },
  };
}
