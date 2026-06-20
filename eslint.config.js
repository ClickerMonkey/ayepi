import tseslint from 'typescript-eslint'
import stylistic from '@stylistic/eslint-plugin'

/**
 * Flat ESLint config. The headline rule is `no-explicit-any: error` — the public
 * generic surface must infer without `any`. Internals may use type assertions
 * (`as`), but each must carry an `// internal cast:` comment; that's enforced
 * separately by the `lint:casts` grep gate (see package scripts), not by ESLint.
 *
 * Style preferences are enforced via `@stylistic` (the successor to ESLint's removed
 * formatting rules): **braces on every control statement** and **semicolons**
 * (statements and type/interface members). There is deliberately **no line-length /
 * wrapping rule** — long lines are fine; only these specific conventions are enforced.
 */
export default tseslint.config(
  { ignores: ['**/dist/**', '**/node_modules/**', '**/*.d.ts', '**/*.snap'] },
  ...tseslint.configs.recommended,
  {
    plugins: { '@stylistic': stylistic },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/no-empty-object-type': 'off', // EmptyObject = {} is intentional
      'no-empty': ['error', { allowEmptyCatch: true }],
      // ---- style preferences (no line-wrapping rule on purpose) ----
      curly: ['error', 'all'], // braces on every if/else/for/while
      '@stylistic/semi': ['error', 'always'], // statement semicolons
      '@stylistic/no-extra-semi': 'error', // …but no redundant ones (drops the old leading-`;` ASI guards)
      '@stylistic/member-delimiter-style': 'error', // semicolons after interface/type members too (default style)
    },
  },
  {
    // tests + the executable example deliberately use casts, ts-expect-error, and any
    files: ['**/test/**', '**/example.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/ban-ts-comment': 'off',
      '@typescript-eslint/no-unused-vars': 'off',
    },
  },
)
