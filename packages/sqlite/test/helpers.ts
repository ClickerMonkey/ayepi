import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SqliteDatabase } from '../src/index';

/** A database file in a fresh temp directory, opened by as many connections as asked (as separate processes would). */
export function sharedFile(connections = 2): { dbs: Database.Database[]; close(): void } {
  const dir = mkdtempSync(join(tmpdir(), 'ayepi-sqlite-'));
  const file = join(dir, 'test.db');
  const dbs = Array.from({ length: connections }, () => {
    const db = new Database(file);
    db.pragma('journal_mode = WAL');
    db.pragma('busy_timeout = 2000');
    return db;
  });
  return {
    dbs,
    close() {
      for (const db of dbs) {db.close();}
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** A fresh in-memory database. */
export const memory = (): Database.Database => new Database(':memory:');

/** A better-sqlite3 Database is a SqliteDatabase as is (checked at compile time). */
export const asPort = (db: Database.Database): SqliteDatabase => db;

/** A controllable clock. */
export function clock(start = 1_000_000): { now: () => number; advance(ms: number): void } {
  let t = start;
  return { now: () => t, advance: (ms) => void (t += ms) };
}

export const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
export async function until(check: () => boolean | Promise<boolean>, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > end) {throw new Error('timed out');}
    await wait(5);
  }
}
