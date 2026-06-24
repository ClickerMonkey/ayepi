#!/usr/bin/env node
/**
 * Sync (and optionally bump) the version of every publishable workspace package.
 *
 * All `@ayepi/*` packages share one version. Internal deps use `workspace:^`, which
 * `pnpm publish` rewrites to the real version at publish time — so this only touches the
 * `"version"` field of each `packages/<pkg>/package.json` (surgically, preserving formatting).
 *
 *   node scripts/version.mjs 1.2.3      # set every package to an explicit version
 *   node scripts/version.mjs patch      # bump patch from the current (max) version
 *   node scripts/version.mjs minor      # bump minor
 *   node scripts/version.mjs major      # bump major
 *   node scripts/version.mjs            # print the current version(s) and exit
 *
 * A `-pre.N` style prerelease string is accepted as an explicit version (e.g. `1.2.3-rc.0`).
 */
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const PKGS = 'packages';
const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.-]+)?$/;

/** Every publishable package's path + parsed json. */
const packages = readdirSync(PKGS)
  .map((dir) => join(PKGS, dir, 'package.json'))
  .filter((path) => existsSync(path))
  .map((path) => ({ path, json: JSON.parse(readFileSync(path, 'utf8')) }))
  .filter((p) => !p.json.private);

if (packages.length === 0) {
  console.error('no publishable packages found under packages/*');
  process.exit(1);
}

const cmp = (a, b) => {
  const pa = a.split('-')[0].split('.').map(Number);
  const pb = b.split('-')[0].split('.').map(Number);
  return pa[0] - pb[0] || pa[1] - pb[1] || pa[2] - pb[2];
};
const bump = (v, kind) => {
  const m = SEMVER.exec(v);
  if (!m) {
    console.error(`current version "${v}" is not semver; pass an explicit version to reset it`);
    process.exit(1);
  }
  const [, major, minor, patch] = m.map(Number);
  if (kind === 'major') return `${major + 1}.0.0`;
  if (kind === 'minor') return `${major}.${minor + 1}.0`;
  return `${major}.${minor}.${patch + 1}`;
};

const current = [...new Set(packages.map((p) => p.json.version))].sort(cmp);
const arg = process.argv[2];

if (!arg) {
  console.log(`current: ${current.join(', ')} across ${packages.length} packages`);
  process.exit(0);
}

const next = ['major', 'minor', 'patch'].includes(arg) ? bump(current[current.length - 1] ?? '0.0.0', arg) : arg;
if (!SEMVER.test(next)) {
  console.error(`invalid version "${next}" — expected X.Y.Z[-pre] or major|minor|patch`);
  process.exit(1);
}

for (const { path, json } of packages) {
  const txt = readFileSync(path, 'utf8');
  const updated = txt.replace(/("version"\s*:\s*)"[^"]*"/, `$1"${next}"`);
  if (updated === txt && json.version !== next) {
    console.error(`!! could not update version in ${path}`);
    process.exit(1);
  }
  writeFileSync(path, updated);
}
console.log(`set ${packages.length} packages to ${next}`);
