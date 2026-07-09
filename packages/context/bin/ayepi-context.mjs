#!/usr/bin/env node
/**
 * ayepi-context — flatten the ayepi agent-reference docs into your repo.
 *
 * The per-package `ayepi-<pkg>.md` files ship flat in each package root
 * (`node_modules/@ayepi/<pkg>/ayepi-<pkg>.md`), and the `ayepi.md` index links to them
 * as flat siblings (`./ayepi-core.md`). This copies the index (bundled in this package)
 * plus every installed package's doc(s) into one flat folder, so the links resolve — on
 * GitHub, in your editor, and when handed to a coding agent.
 *
 *   npx @ayepi/context               # → ./docs
 *   npx @ayepi/context .claude       # → ./.claude
 *   npx @ayepi/context docs --prune  # de-link index entries for packages you didn't install
 *
 * Re-run after upgrading/adding @ayepi packages to resync.
 */
import { readdirSync, mkdirSync, copyFileSync, existsSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
if (args.includes('--help') || args.includes('-h')) {
  console.log(`Usage: ayepi-context [target-dir] [--prune]

  target-dir   where to write the flat docs (default: docs)
  --prune      de-link index entries whose package isn't installed
`);
  process.exit(0);
}

const prune = args.includes('--prune');
const target = args.find((a) => !a.startsWith('-')) ?? 'docs';
const here = dirname(fileURLToPath(import.meta.url));
const DOC_RE = /^ayepi-.*\.md$/;

/** The canonical index: shipped inside this package, or the repo root when run from source. */
function resolveIndex() {
  const candidates = [
    join(here, '..', 'ayepi.md'), // published layout: packages/context/ayepi.md
    join(here, '..', '..', '..', 'ayepi.md'), // source layout: repo root
  ];
  return candidates.find((p) => existsSync(p));
}

/** Directories that may contain an installed @ayepi package. Direct deps first (they win on dedup). */
function scopeDirs() {
  const dirs = [];
  const scope = join('node_modules', '@ayepi');
  if (existsSync(scope)) {
    for (const name of readdirSync(scope)) dirs.push(join(scope, name));
  }
  // pnpm keeps transitive @ayepi deps only under the virtual store.
  const store = join('node_modules', '.pnpm');
  if (existsSync(store)) {
    for (const entry of readdirSync(store)) {
      const nested = join(store, entry, 'node_modules', '@ayepi');
      if (existsSync(nested)) {
        for (const name of readdirSync(nested)) dirs.push(join(nested, name));
      }
    }
  }
  return dirs;
}

const index = resolveIndex();
if (!index) {
  console.error('ayepi-context: could not locate the bundled ayepi.md index.');
  process.exit(1);
}

// Collect flat docs, deduped by filename (first occurrence — i.e. a direct dep — wins).
const found = new Map(); // filename -> absolute source path
for (const dir of scopeDirs()) {
  let files;
  try {
    if (!statSync(dir).isDirectory()) continue;
    files = readdirSync(dir);
  } catch {
    continue;
  }
  for (const f of files) {
    if (DOC_RE.test(f) && !found.has(f)) found.set(f, join(dir, f));
  }
}

mkdirSync(target, { recursive: true });

// Write the index — optionally de-linking references to docs we didn't copy.
let indexText = readFileSync(index, 'utf8');
let prunedCount = 0;
if (prune) {
  indexText = indexText.replace(/\[([^\]]+)\]\(\.\/(ayepi-[^)]+\.md)\)/g, (match, label, file) => {
    if (found.has(file)) return match;
    prunedCount++;
    return label; // keep the human-readable label, drop the dead link
  });
}
writeFileSync(join(target, 'ayepi.md'), indexText);

for (const [name, src] of found) copyFileSync(src, join(target, name));

if (found.size === 0) {
  console.warn(`ayepi-docs: no @ayepi/* packages found under node_modules — copied ayepi.md only.`);
} else {
  console.log(`ayepi-context: synced ayepi.md + ${found.size} package doc(s) → ${target}/`);
}
if (prune && prunedCount) console.log(`ayepi-context: de-linked ${prunedCount} index entr${prunedCount === 1 ? 'y' : 'ies'} for uninstalled packages.`);
