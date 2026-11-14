#!/usr/bin/env node
/**
 * Publish every public @ayepi/* package whose version isn't on npm yet. The Release workflow runs it
 * after `pnpm -r build`; it can run locally too (`pnpm release:dry`, or after `npm login`).
 *
 * Every package must share one version (scripts/version.mjs keeps them together), and when started
 * from a tag the tag must be `v<that version>`. `pnpm pack` writes each tarball (rewriting the
 * `workspace:^` ranges to real versions), then npm publishes it: in GitHub Actions npm 11.5+ uses
 * trusted publishing (OIDC) with provenance, so no token is stored anywhere. Packages go out after
 * the internal packages they depend on; versions already on npm are skipped, so a re-run is safe.
 *
 *   node scripts/publish-ci.mjs            # publish
 *   node scripts/publish-ci.mjs --dry-run  # pack and run npm publish --dry-run
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const dryRun = process.argv.includes('--dry-run');
const ci = process.env.GITHUB_ACTIONS === 'true';
const shell = process.platform === 'win32';

const fail = (message) => {
  console.error(`\n${message}`);
  process.exit(1);
};

/** Public workspace packages by name. */
const packages = new Map();
for (const dir of readdirSync('packages')) {
  const file = join('packages', dir, 'package.json');
  if (!existsSync(file)) continue;
  const json = JSON.parse(readFileSync(file, 'utf8'));
  if (!json.private) packages.set(json.name, { dir: resolve('packages', dir), json });
}

const versions = [...new Set([...packages.values()].map(({ json }) => json.version))];
if (versions.length !== 1) fail(`Packages are on different versions (${versions.join(', ')}): run pnpm version:set <version>.`);
const [version] = versions;
const tag = process.env.GITHUB_REF_TYPE === 'tag' ? process.env.GITHUB_REF_NAME : '';
if (tag && tag !== `v${version}`) fail(`Tag ${tag} doesn't match the package version ${version}.`);

/** Each package after the internal packages it depends on. */
const order = [];
const visit = (name, trail) => {
  if (order.includes(name)) return;
  if (trail.includes(name)) fail(`Dependency cycle: ${[...trail, name].join(' -> ')}`);
  const { json } = packages.get(name);
  Object.keys({ ...json.dependencies, ...json.peerDependencies, ...json.optionalDependencies })
    .filter((dep) => dep !== name && packages.has(dep))
    .forEach((dep) => visit(dep, [...trail, name]));
  order.push(name);
};
[...packages.keys()].sort().forEach((name) => visit(name, []));

const onNpm = (name) =>
  spawnSync('npm', ['view', `${name}@${version}`, 'version'], { encoding: 'utf8', shell }).stdout.trim() === version;
const todo = order.filter((name) => !onNpm(name));
if (!todo.length) {
  console.log(`Every package is already on npm at ${version}.`);
  process.exit(0);
}
console.log(`To publish at ${version}: ${todo.join(', ')}`);

const out = mkdtempSync(join(tmpdir(), 'ayepi-pack-'));
for (const name of todo) {
  const { dir } = packages.get(name);
  console.log(`\n=== ${name}@${version}`);
  const packed = execFileSync('pnpm', ['pack', '--pack-destination', out], { cwd: dir, encoding: 'utf8', shell });
  const tarball = packed.trim().split(/\r?\n/).pop().trim();
  const args = ['publish', tarball, '--access', 'public'];
  if (ci) args.push('--provenance');
  if (dryRun) args.push('--dry-run');
  const result = spawnSync('npm', args, { stdio: ['inherit', 'inherit', 'pipe'], encoding: 'utf8', shell });
  process.stderr.write(result.stderr);
  // A version published moments ago sits staged for a few minutes, invisible to npm view: a re-run hits this
  if (result.status !== 0 && /previously (staged|published) version/.test(result.stderr)) {
    console.log(`${name}@${version} is already on npm (maybe still staged): skipped`);
    continue;
  }
  if (result.status !== 0) fail(`Publish failed: ${name}@${version}`);
}

console.log(dryRun ? '\nDry run complete: nothing was published.' : '\nPublished. npm can take a few minutes to show new versions.');
