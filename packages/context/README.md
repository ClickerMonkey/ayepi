# @ayepi/context

Pull **ayepi's agent context** — the flat agent-reference docs — into your repo with one command.

ayepi ships its LLM/agent docs as flat markdown: an `ayepi.md` index that links to a
per-package `ayepi-<pkg>.md` reference for each `@ayepi/*` package. Those per-package files
ship inside each installed package (`node_modules/@ayepi/core/ayepi-core.md`, …), and the
index links to them as flat siblings (`./ayepi-core.md`). This CLI copies the index plus every
installed package's doc into one flat folder, so the links actually resolve — on GitHub, in
your editor, and when you point a coding agent at them.

## Usage

```bash
npx @ayepi/context             # → ./docs
npx @ayepi/context .claude     # → any target directory
npx @ayepi/context docs --prune  # de-link index rows for packages you didn't install
```

Run it from your project root (wherever `node_modules/` lives). Re-run after adding or
upgrading `@ayepi/*` packages to resync. To wire it into your project:

```jsonc
// package.json
"scripts": { "context:sync": "ayepi-context" }
```

## What it does

1. Writes the `ayepi.md` index (bundled in this package) to the target folder.
2. Scans `node_modules/@ayepi/*` (and pnpm's virtual store) for `ayepi-*.md` files and copies
   each, flat, into the same folder. Deduped by filename; direct dependencies win.

Only files are copied — nothing is deleted from the target. With `--prune`, index links whose
package isn't installed are de-linked (the label stays, the dead link is removed) so you don't
ship broken links for docs you don't have.

## Options

| Arg | Meaning |
| --- | --- |
| `[target-dir]` | Where to write the flat docs. Default: `docs`. |
| `--prune` | De-link index entries for packages not present in `node_modules`. |
| `--help` | Show usage. |
