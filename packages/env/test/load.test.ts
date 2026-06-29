import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { env } from '../src/index';
import { readEnvFile, loadEnv } from '../src/load';

const Schema = {
  PORT: z.coerce.number(),
  NAME: z.string(),
  META: z.object({ x: z.number() }).optional(),
};

let dir: string;
let envFile: string;
let jsonFile: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'ayepi-env-'));
  envFile = join(dir, '.env');
  jsonFile = join(dir, 'config.json');
  writeFileSync(envFile, 'PORT=1\nNAME=from-dotenv\n');
  writeFileSync(jsonFile, JSON.stringify({ PORT: 2, META: { x: 7 } }));
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('readEnvFile', () => {
  it('reads .env and .json files', () => {
    expect(readEnvFile(envFile)).toEqual({ PORT: '1', NAME: 'from-dotenv' });
    expect(readEnvFile(jsonFile)).toEqual({ PORT: 2, META: { x: 7 } });
  });
});

describe('loadEnv', () => {
  it('merges files in order (later wins), ready to feed set()', () => {
    const source = loadEnv({ files: [envFile, jsonFile] });
    expect(source).toEqual({ PORT: 2, NAME: 'from-dotenv', META: { x: 7 } }); // json PORT wins
    const ENV = env(Schema);
    ENV.set(source);
    expect(ENV.parse()).toEqual({ PORT: 2, NAME: 'from-dotenv', META: { x: 7 } });
  });

  it('skips a missing file by default, but throws when required', () => {
    expect(loadEnv({ files: [join(dir, 'nope.env')] })).toEqual({});
    expect(() => loadEnv({ files: [join(dir, 'nope.env')], required: true })).toThrow(/not found/);
  });

  it('returns an empty source with no files', () => {
    expect(loadEnv()).toEqual({});
  });
});
