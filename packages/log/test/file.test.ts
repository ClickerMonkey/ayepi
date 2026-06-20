import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileTransport, type FsLike } from '../src/file';
import type { LogRecord } from '../src/index';

const rec = (msg: string): LogRecord => ({ tms: 't', level: 'info', msg });

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ayepi-log-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('fileTransport (real fs)', () => {
  it('batches writes into JSON lines, flushed on close (non-blocking)', async () => {
    const path = join(dir, 'app.log');
    const t = fileTransport({ path });
    for (let i = 0; i < 5; i++) {t.write(rec(`m${i}`), 'ignored');} // returns immediately (buffered)
    expect(existsSync(path)).toBe(false); // nothing written synchronously
    await t.close!();
    const lines = readFileSync(path, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(5);
    expect((JSON.parse(lines[0]!) as LogRecord).msg).toBe('m0');
  });

  it('rotates by date via an injected clock', async () => {
    const path = join(dir, 'app.log');
    let t0 = Date.parse('2026-06-12T10:00:00Z');
    const t = fileTransport({ path, strategy: 'date', now: () => t0 });
    t.write(rec('day1'), '');
    await t.close!();
    t0 = Date.parse('2026-06-13T10:00:00Z');
    t.write(rec('day2'), '');
    await t.close!();
    expect(existsSync(join(dir, 'app-2026-06-12.log'))).toBe(true);
    expect(existsSync(join(dir, 'app-2026-06-13.log'))).toBe(true);
  });
});

describe('fileTransport (injected fs — deterministic rotation)', () => {
  function memFs() {
    const present = new Set<string>();
    const renames: string[] = [];
    const removed: string[] = [];
    const fs: FsLike = {
      exists: async (p) => present.has(p),
      stat: async () => ({ size: 1000 }),
      mkdir: async () => {},
      appendFile: async (p) => void present.add(p),
      rename: async (a, b) => {
        renames.push(`${a}->${b}`);
        present.delete(a);
        present.add(b);
      },
      unlink: async (p) => {
        removed.push(p);
        present.delete(p);
      },
    };
    return { fs, present, renames, removed };
  }

  it('shifts files in order and prunes beyond maxFiles', async () => {
    const m = memFs();
    m.present.add('app.log');
    m.present.add('app.log.1');
    m.present.add('app.log.2'); // already at maxFiles
    const t = fileTransport({ path: 'app.log', maxSize: 10, maxFiles: 2, fs: m.fs });
    t.write(rec('x'), '');
    await t.close!();
    // statSync says 1000 > maxSize 10 → rotate: prune oldest app.log.2, shift app.log.1->.2, app.log->.1
    expect(m.removed).toContain('app.log.2');
    expect(m.renames).toEqual(['app.log.1->app.log.2', 'app.log->app.log.1']);
    expect(m.present.has('app.log')).toBe(true); // freshly appended
  });
});

describe('fileTransport flush failures (onError, best-effort)', () => {
  const failingFs = (): FsLike => ({
    exists: async () => false,
    stat: async () => ({ size: 0 }),
    mkdir: async () => {},
    appendFile: async () => {
      throw new Error('disk full');
    },
    rename: async () => {},
    unlink: async () => {},
  });

  it('reports a flush failure via onError and never rejects', async () => {
    const errs: unknown[] = [];
    const t = fileTransport({ path: join(dir, 'app.log'), fs: failingFs(), onError: (e) => errs.push(e) });
    t.write(rec('m'), 'line');
    await expect(t.close!()).resolves.toBeUndefined(); // close flushes; a failed flush never throws
    expect((errs[0] as Error).message).toBe('disk full');
  });

  it('a throwing onError is ignored; with no onError the failure is silent', async () => {
    const t1 = fileTransport({
      path: join(dir, 'a.log'),
      fs: failingFs(),
      onError: () => {
        throw new Error('reporter boom');
      },
    });
    t1.write(rec('m'), 'line');
    await expect(t1.close!()).resolves.toBeUndefined();

    const t2 = fileTransport({ path: join(dir, 'b.log'), fs: failingFs() }); // no onError → silent
    t2.write(rec('m'), 'line');
    await expect(t2.close!()).resolves.toBeUndefined();
  });
});
