/**
 * # JSON Schema helpers
 *
 * Thin wrappers over `z.toJSONSchema` shared by the OpenAPI and AsyncAPI
 * generators. Internal to the package.
 *
 * @module
 */

import { z } from 'zod';
import type { Json } from './types';

/**
 * Convert a zod schema to a JSON Schema (input view), degrading gracefully to a
 * placeholder for schemas zod can't represent.
 *
 * @internal
 */
export function jsonSchema(s: z.ZodType): Json {
  try {
    return z.toJSONSchema(s, { io: 'input' }) as Json;
  } catch {
    return { type: 'string', description: 'unrepresentable schema' };
  }
}

/**
 * Extract the `properties` map of an object schema's JSON Schema, or `{}` when
 * the schema is absent or not object-shaped.
 *
 * @internal
 */
export function propSchemas(s: z.ZodType | undefined): Record<string, Json> {
  const js = s ? jsonSchema(s) : null;
  if (js && typeof js === 'object' && !Array.isArray(js) && typeof js.properties === 'object') {
    return js.properties as Record<string, Json>;
  }
  return {};
}
