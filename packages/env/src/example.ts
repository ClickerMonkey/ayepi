/**
 * # `envExample(...)` — a `.env.example` from a config's own description
 *
 * Render {@link EnvView.describe}'s fields as a commented `.env` file, so the example a project
 * ships is generated from the schemas instead of kept by hand beside them.
 *
 * ```ts
 * writeFileSync('.env.example', envExample(settings.describe()))
 * ```
 *
 * @module
 */
import type { EnvFieldInfo } from './env';

/** The text a value has in a `.env` file: strings as written, anything else as JSON. */
function dotenvText(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value);
}

/**
 * A `.env.example` for `fields`: each field read from a source key becomes a `KEY=default` line under its
 * description as a comment. A field with no default is written as an empty `KEY=` marked `(required)`, or
 * commented out when it is optional. Computed fields read no key and are left out.
 */
export function envExample(fields: readonly EnvFieldInfo[]): string {
  const blocks = fields
    .filter((field) => !field.computed)
    .map((field) => {
      const key = field.vars[0] ?? field.key;
      const notes = [field.description, field.required ? '(required)' : undefined].filter((note) => note !== undefined);
      const comment = notes.length === 0 ? [] : notes.join(' ').split('\n').map((text) => `# ${text}`);
      const line = 'default' in field ? `${key}=${dotenvText(field.default)}` : field.required ? `${key}=` : `# ${key}=`;
      return [...comment, line].join('\n');
    });
  return blocks.length === 0 ? '' : `${blocks.join('\n\n')}\n`;
}
