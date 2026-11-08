/**
 * Tools defined at runtime: {@link McpToolSet} is a tool source whose tools are added, replaced and removed while it
 * serves, each from a JSON Schema or a zod schema, with every call's arguments checked against that schema before the
 * tool runs.
 *
 * @module
 */

import { z } from 'zod';
import { Listeners } from './listeners';
import { errorResult, messageOf, type McpCaller, type McpToolSource } from './protocol';
import type { McpTool, McpToolResult } from './shapes';

/** The names MCP allows for tools: 1 to 128 letters, digits, `_`, `-` and `.`. */
export const MCP_TOOL_NAME = /^[A-Za-z0-9_.-]{1,128}$/;

/** A tool name MCP allows, made from any text: other characters become `_`, and it is cut to 128 characters. */
export function mcpToolName(text: string): string {
  const name = text.replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 128);
  return name === '' ? '_' : name;
}

/** What a tool's run gets besides its arguments. */
export interface McpToolContext {
  /** Aborts when the client cancels or goes away. */
  readonly signal: AbortSignal;
  /** Who asked. */
  readonly caller: McpCaller;
}

/** Runs a tool with its checked arguments. A thrown error becomes an `isError` result. */
export type McpToolRun<A> = (args: A, context: McpToolContext) => McpToolResult | Promise<McpToolResult>;

/** What a tool lists besides its input schema. */
type ToolFace = Omit<McpTool, 'inputSchema'>;

/** A tool whose arguments are described by a JSON Schema, checked as zod reads it (`z.fromJSONSchema`). */
export interface McpJsonToolDefinition extends ToolFace {
  readonly inputSchema: z.core.JSONSchema.JSONSchema;
  /**
   * Check arguments against `inputSchema` before running (default `true`). With `false` the schema is only listed,
   * and a schema zod can't read is accepted.
   */
  readonly validate?: boolean;
  readonly run: McpToolRun<Readonly<Record<string, unknown>>>;
}

/** A tool whose arguments are a zod schema: its input JSON Schema is derived from it, and `run` gets the parsed output. */
export interface McpZodToolDefinition<S extends z.ZodType> extends ToolFace {
  readonly args: S;
  readonly run: McpToolRun<z.output<S>>;
}

/** A defined tool: what is listed, and its run behind the argument check. */
interface Defined {
  readonly tool: McpTool;
  readonly run: (args: Readonly<Record<string, unknown>>, context: McpToolContext) => McpToolResult | Promise<McpToolResult>;
}

/** The result for arguments that don't fit: an `isError` result, so the model can read it and try again. */
export function invalidArgumentsResult(tool: string, error: z.ZodError): McpToolResult {
  return errorResult(`invalid arguments for tool "${tool}":\n${z.prettifyError(error)}`);
}

/** A run behind a zod check of its arguments. */
function checked<S extends z.ZodType>(name: string, schema: S, run: McpToolRun<z.output<S>>): Defined['run'] {
  return async (args, context) => {
    const parsed = await schema.safeParseAsync(args);
    return parsed.success ? run(parsed.data, context) : invalidArgumentsResult(name, parsed.error);
  };
}

/** The listed face of a definition, without its run or options. */
function faceOf(def: ToolFace): ToolFace {
  return {
    name: def.name,
    ...(def.title === undefined ? {} : { title: def.title }),
    ...(def.description === undefined ? {} : { description: def.description }),
    ...(def.outputSchema === undefined ? {} : { outputSchema: def.outputSchema }),
    ...(def.annotations === undefined ? {} : { annotations: def.annotations }),
  };
}

/**
 * A tool source defined at runtime. {@link McpToolSet.define} adds a tool (or replaces the one with its name) from a
 * JSON Schema or a zod schema; {@link McpToolSet.remove} takes one away. Each change tells the listeners, so a server
 * over the set sends `notifications/tools/list_changed`; {@link McpToolSet.batch} makes many changes one notice.
 *
 * A call's arguments are checked against the tool's schema first: arguments that don't fit are an `isError` result
 * naming what is wrong ({@link invalidArgumentsResult}), and the tool doesn't run.
 *
 * @example
 * ```ts
 * const tools = new McpToolSet()
 *   .define({ name: 'add', args: z.object({ a: z.number(), b: z.number() }), run: ({ a, b }) => jsonResult({ sum: a + b }) })
 *   .define({ name: 'echo', inputSchema: { type: 'object', properties: { text: { type: 'string' } } }, run: (args) => jsonResult(args) });
 * const server = mcpToolServer(tools);
 * ```
 */
export class McpToolSet implements McpToolSource {
  readonly #tools = new Map<string, Defined>();
  readonly #listeners = new Listeners<void>();
  /** How deep in {@link batch} calls, and whether anything changed inside them. */
  #batching = 0;
  #changed = false;

  /**
   * Add a tool, or replace the one with its name. Throws for a name MCP doesn't allow ({@link MCP_TOOL_NAME}) and for
   * a JSON Schema zod can't read when it is to be checked.
   */
  define(def: McpJsonToolDefinition): this;
  define<S extends z.ZodType>(def: McpZodToolDefinition<S>): this;
  define<S extends z.ZodType>(def: McpJsonToolDefinition | McpZodToolDefinition<S>): this {
    if (!MCP_TOOL_NAME.test(def.name)) { throw new Error(`"${def.name}" is not an MCP tool name (1 to 128 of A-Z a-z 0-9 _ - .)`); }
    this.#tools.set(def.name, 'args' in def ? McpToolSet.#zod(def) : McpToolSet.#json(def));
    this.#change();
    return this;
  }

  /** Take a tool away; `false` when there was none by that name. */
  remove(name: string): boolean {
    const had = this.#tools.delete(name);
    if (had) { this.#change(); }
    return had;
  }

  /** Whether a tool by that name is defined. */
  has(name: string): boolean {
    return this.#tools.has(name);
  }

  /** Take every tool away. */
  clear(): void {
    if (this.#tools.size === 0) { return; }
    this.#tools.clear();
    this.#change();
  }

  /** Make many changes, telling the listeners once at the end (and only when something changed). */
  batch(changes: (set: this) => void): void {
    this.#batching += 1;
    try {
      changes(this);
    } finally {
      this.#batching -= 1;
      if (this.#batching === 0 && this.#changed) {
        this.#changed = false;
        this.#listeners.emit();
      }
    }
  }

  tools(): McpTool[] {
    return [...this.#tools.values()].map((defined) => defined.tool);
  }

  async call(name: string, args: Readonly<Record<string, unknown>>, signal: AbortSignal, caller: McpCaller): Promise<McpToolResult | undefined> {
    return this.#tools.get(name)?.run(args, { signal, caller });
  }

  onChange(listener: () => void): () => void {
    return this.#listeners.add(listener);
  }

  #change(): void {
    if (this.#batching > 0) {
      this.#changed = true;
      return;
    }
    this.#listeners.emit();
  }

  static #zod<S extends z.ZodType>(def: McpZodToolDefinition<S>): Defined {
    const inputSchema = z.toJSONSchema(def.args, { io: 'input', unrepresentable: 'any' });
    return { tool: { ...faceOf(def), inputSchema }, run: checked(def.name, def.args, def.run) };
  }

  static #json(def: McpJsonToolDefinition): Defined {
    const tool: McpTool = { ...faceOf(def), inputSchema: def.inputSchema };
    if (def.validate === false) { return { tool, run: def.run }; }
    let schema: z.ZodType;
    try {
      schema = z.fromJSONSchema(def.inputSchema);
    } catch (error) {
      throw new Error(`the input schema of tool "${def.name}" can't be checked: ${messageOf(error)}`, { cause: error });
    }
    return { tool, run: checked(def.name, schema.pipe(z.record(z.string(), z.unknown())), def.run) };
  }
}
