# CLAUDE.md

Guidance for working in this repo — a pnpm monorepo of `@ayepi/*` packages.

## Documentation style — document the current state, not the change

Each package ships flat, LLM-oriented agent-reference docs — `ayepi-<pkg>.md` (plus sub-topic
files like `ayepi-<pkg>-<topic>.md`) — alongside a human `README.md`.

When editing any of these docs (or code JSDoc), **describe how things work as if they have always
worked that way.** These libraries have no public users yet, so there is no prior behavior to
contrast against — the previous state is not important. Do not frame anything as a change or as new:

- Avoid "new", "now", "recently added", "this session", "first-class" (as a novelty).
- Avoid "previously", "used to", "no longer", "as before", "unlike before".
- Avoid "backward compatible", "still (does X)", "renamed", "changed from X to Y".

Just state the behavior. (Commit messages and git history are exempt — they *are* the change log.)

Keep each `ayepi-*.md` in sync with the code it documents; when code and a doc disagree, fix the
doc. Verify every documented API against the source before writing — never invent options or fields.

## Package conventions

- Build: `tsdown`. Test: `vitest` (most packages enforce 100% coverage — check the package's
  `vitest.config.ts` thresholds before assuming). Lint: `eslint` + `node scripts/check-casts.mjs`
  (no unjustified `as unknown as` double casts).
- `@ayepi/core` stays web-standard — no `node:*` imports in its runtime code.
- Versions are shared across all packages via `node scripts/version.mjs <patch|minor|major>`.
