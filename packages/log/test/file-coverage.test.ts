import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileTransport, type FsLike } from '../src/file';
import type { LogRecord } from '../src/index';

const rec = (msg: string): LogRecord => ({ tms: 't', level: 'info', msg });
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ayepi-logcov-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('fileTransport real-fs rotation', () => {
  it('creates the directory, rotates oversized files and prunes the oldest', async () => {
    const sub = join(dir, 'logs');
    const path = join(sub, 'app.log');
    const t = fileTransport({ path, maxSize: 5, maxFiles: 2 }); // tiny maxSize → rotate
    // first batch creates dir + file
    t.write(rec('aaaaaaaaaa'), '');
    await t.close!();
    expect(existsSync(path)).toBe(true);
    // second batch: knownSize>0 and over maxSize → rotateBySize (real rename) then append
    t.write(rec('bbbbbbbbbb'), '');
    await t.close!();
    expect(existsSync(join(sub, 'app.log.1'))).toBe(true);
    // third batch → shift .1->.2, app->.1; fourth → prune .2 (real unlink)
    t.write(rec('cccccccccc'), '');
    await t.close!();
    t.write(rec('dddddddddd'), '');
    await t.close!();
    expect(existsSync(join(sub, 'app.log.2'))).toBe(true);
    expect(existsSync(join(sub, 'app.log'))).toBe(true);
  });

  it('lazily stats a pre-existing active file via the real node fs (currentSize)', async () => {
    const path = join(dir, 'app.log');
    writeFileSync(path, 'x'.repeat(50)); // seed an existing non-empty file → real fs.stat on first flush
    const t = fileTransport({ path, maxSize: 10 }); // 50 bytes > 10 → rotate on first flush
    t.write(rec('after'), '');
    await t.close!();
    expect(existsSync(join(dir, 'app.log.1'))).toBe(true); // rotated the seeded file
    expect(readFileSync(path, 'utf8')).toContain('after');
  });

  it('date strategy prunes old dated files via the real readdir/unlink', async () => {
    const path = join(dir, 'app.log');
    let clock = Date.parse('2026-01-01T00:00:00Z');
    const t = fileTransport({ path, strategy: 'date', maxFiles: 2, now: () => clock });
    // Pruning is lazy: it runs on a date-key change, BEFORE appending the new day,
    // so it sees only the already-written files. Writing 4 distinct days leaves
    // app-01..03 on disk when day4's prune runs (3 > maxFiles 2 → prune oldest).
    for (const day of ['2026-01-01', '2026-01-02', '2026-01-03', '2026-01-04']) {
      clock = Date.parse(`${day}T00:00:00Z`);
      t.write(rec(day), '');
      await t.close!();
    }
    expect(existsSync(join(dir, 'app-2026-01-01.log'))).toBe(false); // pruned on day4
    expect(existsSync(join(dir, 'app-2026-01-02.log'))).toBe(true);
    expect(existsSync(join(dir, 'app-2026-01-03.log'))).toBe(true);
    expect(existsSync(join(dir, 'app-2026-01-04.log'))).toBe(true);
  });

  it('uses the default Date.now clock for date naming when none is injected', async () => {
    const path = join(dir, 'app.log');
    const t = fileTransport({ path, strategy: 'date' }); // no now
    t.write(rec('today'), '');
    await t.close!();
    const key = new Date().toISOString().slice(0, 10);
    expect(existsSync(join(dir, `app-${key}.log`))).toBe(true);
  });
});

describe('fileTransport flush scheduling and buffering', () => {
  it('flushes on the timer without an explicit close (scheduleFlush path)', async () => {
    const path = join(dir, 'app.log');
    const t = fileTransport({ path, flushInterval: 5 });
    t.write(rec('timed'), '');
    // wait for the scheduled timer to fire
    await new Promise((r) => setTimeout(r, 30));
    expect(existsSync(path)).toBe(true);
    expect(readFileSync(path, 'utf8')).toContain('timed');
    await t.close!();
  });

  it('flushes immediately once maxBufferBytes is reached', async () => {
    const path = join(dir, 'app.log');
    const t = fileTransport({ path, maxBufferBytes: 1, flushInterval: 100000 });
    t.write(rec('big'), ''); // line bytes >= 1 → immediate void flush()
    await tick();
    await tick();
    expect(existsSync(path)).toBe(true);
    await t.close!();
  });

  it('write structured:false uses the pre-formatted text', async () => {
    const path = join(dir, 'app.log');
    const t = fileTransport({ path, structured: false });
    t.write(rec('ignored'), 'PRE-FORMATTED');
    await t.close!();
    expect(readFileSync(path, 'utf8')).toBe('PRE-FORMATTED\n');
  });

  it('close() on an empty buffer is a no-op (flush early return)', async () => {
    const path = join(dir, 'app.log');
    const t = fileTransport({ path });
    await t.close!(); // buffer empty → returns immediately
    expect(existsSync(path)).toBe(false);
  });

  it('re-schedules a flush for lines buffered while a flush is in flight', async () => {
    const path = join(dir, 'app.log');
    let resolveAppend: (() => void) | null = null;
    let appendCalls = 0;
    const realLines: string[] = [];
    const fs: FsLike = {
      exists: async () => false,
      stat: async () => ({ size: 0 }),
      mkdir: async () => {},
      appendFile: async (_p, d) => {
        appendCalls++;
        realLines.push(d);
        if (appendCalls === 1) {
          // hold the first flush open so a second write lands mid-flush
          await new Promise<void>((res) => { resolveAppend = res; });
        }
      },
      rename: async () => {},
      unlink: async () => {},
    };
    const t = fileTransport({ path, fs, flushInterval: 5, maxBufferBytes: 1 });
    t.write(rec('first'), '');  // triggers immediate flush (held open)
    await tick();
    t.write(rec('second'), ''); // buffered while flushing=true
    resolveAppend!();           // let the first flush finish → finally re-schedules
    await new Promise((r) => setTimeout(r, 30));
    expect(appendCalls).toBe(2);
    await t.close!();
  });
});

describe('fileTransport injected-fs edge branches', () => {
  function memFs(over: Partial<FsLike> = {}) {
    const present = new Set<string>();
    const removed: string[] = [];
    const base: FsLike = {
      exists: async (p) => present.has(p),
      stat: async () => ({ size: 1000 }),
      mkdir: async () => {},
      appendFile: async (p) => void present.add(p),
      rename: async (a, b) => { present.delete(a); present.add(b); },
      unlink: async (p) => { removed.push(p); present.delete(p); },
      readdir: async () => [],
    };
    return { fs: { ...base, ...over }, present, removed };
  }

  it('currentSize returns 0 when stat throws', async () => {
    const m = memFs({ stat: async () => { throw new Error('stat fail'); } });
    m.present.add('app.log'); // exists → tries stat → throws → size 0 → no rotation
    const t = fileTransport({ path: 'app.log', maxSize: 1, fs: m.fs });
    t.write(rec('x'), '');
    await t.close!();
    expect(m.present.has('app.log')).toBe(true);
  });

  it('rotateBySize swallows an unlink failure on the oldest file', async () => {
    const m = memFs({ unlink: async () => { throw new Error('locked'); } });
    m.present.add('app.log');
    m.present.add('app.log.1'); // oldest = app.log.1 (maxFiles 1)
    const t = fileTransport({ path: 'app.log', maxSize: 1, maxFiles: 1, fs: m.fs });
    t.write(rec('x'), '');
    await expect(t.close!()).resolves.toBeUndefined(); // unlink throw is swallowed
  });

  it('pruneDated is skipped when fs has no readdir', async () => {
    const m = memFs();
    delete (m.fs as { readdir?: unknown }).readdir;
    const t = fileTransport({ path: 'app.log', strategy: 'date', fs: m.fs, now: () => 0 });
    t.write(rec('x'), '');
    await expect(t.close!()).resolves.toBeUndefined();
  });

  it('pruneDated lists, sorts and unlinks beyond maxFiles, swallowing unlink errors', async () => {
    const listed = ['app-2026-01-03.log', 'app-2026-01-01.log', 'app-2026-01-02.log', 'unrelated.txt'];
    let unlinkCalls = 0;
    const m = memFs({
      readdir: async () => listed,
      unlink: async () => { unlinkCalls++; throw new Error('cannot remove'); },
    });
    const t = fileTransport({ path: 'app.log', strategy: 'date', maxFiles: 1, fs: m.fs, now: () => Date.parse('2026-06-01T00:00:00Z') });
    t.write(rec('x'), '');
    await t.close!();
    // 3 dated files, maxFiles 1 → 2 prune attempts, both swallowed
    expect(unlinkCalls).toBe(2);
  });

  it('pruneDated swallows a readdir failure', async () => {
    const m = memFs({ readdir: async () => { throw new Error('readdir fail'); } });
    const t = fileTransport({ path: 'app.log', strategy: 'date', fs: m.fs, now: () => 0 });
    t.write(rec('x'), '');
    await expect(t.close!()).resolves.toBeUndefined();
  });

  it('flush swallows an appendFile rejection (best-effort)', async () => {
    const m = memFs({ appendFile: async () => { throw new Error('disk full'); } });
    const t = fileTransport({ path: 'app.log', fs: m.fs });
    t.write(rec('x'), '');
    await expect(t.close!()).resolves.toBeUndefined();
  });

  it('readdir branch: dir is empty string → defaults to "."', async () => {
    let readdirArg = '';
    const m = memFs({ readdir: async (p) => { readdirArg = p; return []; } });
    const t = fileTransport({ path: 'app.log', strategy: 'date', fs: m.fs, now: () => 0 }); // dirname('app.log') === '.'
    t.write(rec('x'), '');
    await t.close!();
    expect(readdirArg).toBe('.');
  });
});
