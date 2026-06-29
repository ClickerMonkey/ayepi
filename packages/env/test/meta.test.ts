import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { alias, varsOf } from '../src/index';

describe('varsOf / alias', () => {
  it('defaults to the field key when there is no aliasing metadata', () => {
    expect(varsOf(z.string(), 'PORT')).toEqual(['PORT']);
    expect(varsOf({} as unknown as z.ZodType, 'PORT')).toEqual(['PORT']); // schema without .meta()
  });

  it('reads `vars` (first present wins) and falls back to `var`', () => {
    expect(varsOf(z.string().meta({ vars: ['A', 'B'] }), 'X')).toEqual(['A', 'B']);
    expect(varsOf(z.string().meta({ var: 'ONLY' }), 'X')).toEqual(['ONLY']);
  });

  it('alias() attaches `vars`; an empty alias falls back to the key', () => {
    expect(varsOf(alias(z.string(), 'P', 'APP_P'), 'X')).toEqual(['P', 'APP_P']);
    expect(varsOf(alias(z.string()), 'X')).toEqual(['X']); // empty vars → key
  });
});
