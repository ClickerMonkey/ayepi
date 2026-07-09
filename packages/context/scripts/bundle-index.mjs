#!/usr/bin/env node
/**
 * Copy the canonical repo-root `ayepi.md` into this package so it ships with `@ayepi/context`.
 *
 * The root `ayepi.md` is the single source of truth; this runs at build/prepack time so the
 * published package carries an up-to-date copy (the copy is gitignored).
 */
import { copyFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const src = join(here, '..', '..', '..', 'ayepi.md'); // packages/context/scripts -> repo root
const dest = join(here, '..', 'ayepi.md');

if (!existsSync(src)) {
  console.error(`bundle-index: source index not found at ${src}`);
  process.exit(1);
}
copyFileSync(src, dest);
console.log(`bundle-index: copied ayepi.md into @ayepi/context`);
