#!/usr/bin/env node
// Parse a vitest/v8 coverage-final.json (istanbul shape) and print uncovered line numbers per file.
import { readFileSync } from 'node:fs'

const path = process.argv[2]
if (!path) {
  console.error('usage: node scripts/uncovered.mjs <coverage-final.json>')
  process.exit(1)
}
const cov = JSON.parse(readFileSync(path, 'utf8'))

const ranges = (nums) => {
  const out = []
  let start = null
  let prev = null
  for (const n of nums) {
    if (start === null) {
      start = prev = n
    } else if (n === prev + 1) {
      prev = n
    } else {
      out.push(start === prev ? `${start}` : `${start}-${prev}`)
      start = prev = n
    }
  }
  if (start !== null) out.push(start === prev ? `${start}` : `${start}-${prev}`)
  return out
}

for (const [file, data] of Object.entries(cov)) {
  const short = file.replace(/.*[/\\]src[/\\]/, 'src/')
  const lines = new Set()
  // statements
  for (const [id, count] of Object.entries(data.s)) {
    if (count === 0) {
      const loc = data.statementMap[id]?.start?.line
      if (loc) lines.add(loc)
    }
  }
  // functions
  for (const [id, count] of Object.entries(data.f)) {
    if (count === 0) {
      const loc = data.fnMap[id]?.decl?.start?.line
      if (loc) lines.add(loc)
    }
  }
  // branches (report the branch location if any path uncovered)
  const branchMiss = []
  for (const [id, counts] of Object.entries(data.b)) {
    if (counts.some((c) => c === 0)) {
      const loc = data.branchMap[id]?.loc?.start?.line ?? data.branchMap[id]?.line
      if (loc) branchMiss.push(loc)
    }
  }
  const sorted = [...lines].sort((a, b) => a - b)
  if (sorted.length === 0 && branchMiss.length === 0) continue
  console.log(`\n${short}`)
  if (sorted.length) console.log(`  stmt/fn: ${ranges(sorted).join(', ')}`)
  if (branchMiss.length) console.log(`  branch:  ${ranges([...new Set(branchMiss)].sort((a, b) => a - b)).join(', ')}`)
}
