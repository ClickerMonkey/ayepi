/**
 * The MCP objects a server sends and a client reads: tools, tool results, resources, resource templates, resource
 * contents, prompts, and the `initialize` result. Each is a zod schema first, with its type derived from it, so the
 * server's sources and the client's parsed results share one definition.
 *
 * @module
 */

import { z } from 'zod';

/** A JSON-RPC id. */
export const JsonRpcId = z.union([z.string(), z.number()]);
export type JsonRpcId = z.infer<typeof JsonRpcId>;

/** A JSON object of any shape (a JSON Schema, capabilities, metadata). */
const JsonObject = z.custom<object>((value) => typeof value === 'object' && value !== null && !Array.isArray(value), 'expected an object');

/* ---- content blocks ------------------------------------------------------- */

/** The text of a resource. */
export const McpTextContents = z.object({ uri: z.string(), mimeType: z.string().optional(), text: z.string() });
export type McpTextContents = z.infer<typeof McpTextContents>;

/** The bytes of a resource, base64. */
export const McpBlobContents = z.object({ uri: z.string(), mimeType: z.string().optional(), blob: z.string() });
export type McpBlobContents = z.infer<typeof McpBlobContents>;

/** One part of a read resource: its text or its bytes. */
export const McpResourceContents = z.union([McpTextContents, McpBlobContents]);
export type McpResourceContents = z.infer<typeof McpResourceContents>;

/** A resource the server lists: something a client can read by its URI. */
export const McpResource = z.object({
  uri: z.string(),
  name: z.string(),
  title: z.string().optional(),
  description: z.string().optional(),
  mimeType: z.string().optional(),
  /** Its size in bytes, when known. */
  size: z.number().optional(),
});
export type McpResource = z.infer<typeof McpResource>;

/** A content block in a tool result or a prompt message. */
export const McpContent = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), text: z.string() }),
  z.object({ type: z.literal('image'), data: z.string(), mimeType: z.string() }),
  z.object({ type: z.literal('audio'), data: z.string(), mimeType: z.string() }),
  z.object({ type: z.literal('resource'), resource: McpResourceContents }),
  McpResource.extend({ type: z.literal('resource_link') }),
]);
export type McpContent = z.infer<typeof McpContent>;

/* ---- tools ---------------------------------------------------------------- */

/** A tool: what an MCP client lists and calls. `inputSchema` is a JSON Schema object of its arguments. */
export const McpTool = z.object({
  name: z.string(),
  title: z.string().optional(),
  description: z.string().optional(),
  inputSchema: JsonObject,
  outputSchema: JsonObject.optional(),
});
export type McpTool = z.infer<typeof McpTool>;

/** What `tools/call` returns. `isError` marks a failure the model reads. */
export const McpToolResult = z.object({
  content: z.array(McpContent),
  structuredContent: JsonObject.optional(),
  isError: z.boolean().optional(),
});
export type McpToolResult = z.infer<typeof McpToolResult>;

/* ---- resources ------------------------------------------------------------ */

/** A family of resources a client can read by filling in an RFC 6570 URI template. */
export const McpResourceTemplate = z.object({
  uriTemplate: z.string(),
  name: z.string(),
  title: z.string().optional(),
  description: z.string().optional(),
  mimeType: z.string().optional(),
});
export type McpResourceTemplate = z.infer<typeof McpResourceTemplate>;

/** A page of resources. `nextCursor` is absent on the last page. */
export const McpResourcePage = z.object({ resources: z.array(McpResource), nextCursor: z.string().optional() });
export type McpResourcePage = z.infer<typeof McpResourcePage>;

/* ---- prompts -------------------------------------------------------------- */

/** An argument a prompt takes. Every argument value is a string. */
export const McpPromptArgument = z.object({ name: z.string(), description: z.string().optional(), required: z.boolean().optional() });
export type McpPromptArgument = z.infer<typeof McpPromptArgument>;

/** A prompt: a template a person picks, filled with arguments into messages. */
export const McpPrompt = z.object({
  name: z.string(),
  title: z.string().optional(),
  description: z.string().optional(),
  arguments: z.array(McpPromptArgument).optional(),
});
export type McpPrompt = z.infer<typeof McpPrompt>;

/** One message of a filled prompt. */
export const McpPromptMessage = z.object({ role: z.enum(['user', 'assistant']), content: McpContent });
export type McpPromptMessage = z.infer<typeof McpPromptMessage>;

/** What `prompts/get` returns. */
export const McpPromptResult = z.object({ description: z.string().optional(), messages: z.array(McpPromptMessage) });
export type McpPromptResult = z.infer<typeof McpPromptResult>;

/* ---- initialize ----------------------------------------------------------- */

/** Who a server or client is. */
export const McpImplementation = z.object({ name: z.string(), version: z.string(), title: z.string().optional() });
export type McpImplementation = z.infer<typeof McpImplementation>;

/** What a server can do, as `initialize` reports it. A capability that is absent is not offered. */
export const McpServerCapabilities = z.object({
  tools: z.object({ listChanged: z.boolean().optional() }).optional(),
  resources: z.object({ subscribe: z.boolean().optional(), listChanged: z.boolean().optional() }).optional(),
  prompts: z.object({ listChanged: z.boolean().optional() }).optional(),
  logging: JsonObject.optional(),
  completions: JsonObject.optional(),
});
export type McpServerCapabilities = z.infer<typeof McpServerCapabilities>;

/** What `initialize` returns. */
export const McpInitializeResult = z.object({
  protocolVersion: z.string(),
  capabilities: McpServerCapabilities,
  serverInfo: McpImplementation,
  instructions: z.string().optional(),
});
export type McpInitializeResult = z.infer<typeof McpInitializeResult>;

/* ---- results by method ---------------------------------------------------- */

/** The result each request method returns: the one statement of it, read by the client to check answers. */
export const McpResults = {
  'initialize': McpInitializeResult,
  'ping': z.object({}),
  'tools/list': z.object({ tools: z.array(McpTool), nextCursor: z.string().optional() }),
  'tools/call': McpToolResult,
  'resources/list': McpResourcePage,
  'resources/templates/list': z.object({ resourceTemplates: z.array(McpResourceTemplate), nextCursor: z.string().optional() }),
  'resources/read': z.object({ contents: z.array(McpResourceContents) }),
  'resources/subscribe': z.object({}),
  'resources/unsubscribe': z.object({}),
  'prompts/list': z.object({ prompts: z.array(McpPrompt), nextCursor: z.string().optional() }),
  'prompts/get': McpPromptResult,
} as const;
/** A request method this package speaks. */
export type McpMethod = keyof typeof McpResults;
/** Each request method's result. */
type ResultMap = { [M in McpMethod]: z.output<(typeof McpResults)[M]> };
/** The result of a request method. */
export type McpResultOf<M extends McpMethod> = ResultMap[M];
/** The result schemas, typed so a generic method's schema parses to that method's result. */
export const MCP_RESULTS: { readonly [M in McpMethod]: z.ZodType<McpResultOf<M>> } = McpResults;

/** The params each request method takes. */
export const McpParams = {
  'initialize': z.object({ protocolVersion: z.string(), capabilities: JsonObject.optional(), clientInfo: McpImplementation.optional() }),
  'ping': z.object({}).optional(),
  'tools/list': z.object({ cursor: z.string().optional() }).optional(),
  'tools/call': z.object({ name: z.string(), arguments: z.record(z.string(), z.unknown()).optional() }),
  'resources/list': z.object({ cursor: z.string().optional() }).optional(),
  'resources/templates/list': z.object({ cursor: z.string().optional() }).optional(),
  'resources/read': z.object({ uri: z.string() }),
  'resources/subscribe': z.object({ uri: z.string() }),
  'resources/unsubscribe': z.object({ uri: z.string() }),
  'prompts/list': z.object({ cursor: z.string().optional() }).optional(),
  'prompts/get': z.object({ name: z.string(), arguments: z.record(z.string(), z.string()).optional() }),
} as const satisfies Record<McpMethod, z.ZodType>;
/** Each request method's params, as checked. */
type ParamsMap = { [M in McpMethod]: z.output<(typeof McpParams)[M]> };
/** The checked params of a request method. */
export type McpParamsOf<M extends McpMethod> = ParamsMap[M];
/** The params schemas, typed so a generic method's schema parses to that method's params. */
export const MCP_PARAMS: { readonly [M in McpMethod]: z.ZodType<McpParamsOf<M>> } = McpParams;

/** The notifications a server sends, by method, with their params. */
export const McpNotifications = {
  'notifications/tools/list_changed': z.object({}).optional(),
  'notifications/resources/list_changed': z.object({}).optional(),
  'notifications/prompts/list_changed': z.object({}).optional(),
  'notifications/resources/updated': z.object({ uri: z.string() }),
} as const;
/** A notification method a server sends. */
export type McpNotificationMethod = keyof typeof McpNotifications;
