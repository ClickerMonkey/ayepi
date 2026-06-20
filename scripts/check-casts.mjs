#!/usr/bin/env node
/**
 * Cast gate. The library's hard rule is that type-assertion escape hatches stay
 * confined to internal plumbing and are justified in place. This enforces the
 * sharpest form — every double cast (`as unknown as`), the only way to fully
 * launder a type — carries an `// internal cast:` comment on the same line.
 *
 * Scans every `packages/<pkg>/src/**.ts`. Exits non-zero on any unjustified
 * double cast, printing file:line.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const roots = readdirSync('packages', { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => join('packages', d.name, 'src'))
  .filter((p) => {
    try {
      return statSync(p).isDirectory()
    } catch {
      return false
    }
  })

/** @param {string} dir */
function walk(dir) {
  /** @type {string[]} */
  const out = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walk(full))
    else if (entry.name.endsWith('.ts')) out.push(full)
  }
  return out
}

const violations = []
for (const root of roots) {
  for (const file of walk(root)) {
    const lines = readFileSync(file, 'utf8').split('\n')
    lines.forEach((line, i) => {
      if (line.includes('as unknown as') && !line.includes('internal cast:')) {
        violations.push(`${file}:${i + 1}: ${line.trim()}`)
      }
    })
  }
}

if (violations.length > 0) {
  console.error('✗ unjustified double casts (add an `// internal cast: <why>` comment):\n')
  for (const v of violations) console.error('  ' + v)
  process.exit(1)
}
console.log('✓ cast gate: all double casts are justified')
