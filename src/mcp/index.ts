/**
 * Public surface of the MCP server.
 *
 * Exported from the package root so another tool can mount this server in-process without
 * spawning a binary — the same dispatch that backs `codebase-snapshot mcp`. Everything below the
 * protocol layer is plain functions over a repository; nothing here reads a stream or a clock
 * unless it is asked to.
 */
export { createMcpServer } from "./server.js";
export type { McpServer, McpServerOptions } from "./server.js";

export { buildTools } from "./tools.js";
export { buildPrompts } from "./prompts.js";
export { buildResourceProvider } from "./resources.js";

export { createServer, runStdioServer } from "./run.js";
export type { ServerOptions } from "./run.js";

export { createLineReader, createWriter, MAX_LINE_BYTES } from "./stdio.js";
export type { LineReaderOptions, MessageWriter } from "./stdio.js";

export { SERVER_INSTRUCTIONS } from "./instructions.js";

export {
  ERROR_CODES,
  LEGACY_PROTOCOL_VERSIONS,
  METHOD,
  MODERN_PROTOCOL_VERSIONS,
  SUPPORTED_PROTOCOL_VERSIONS,
} from "./protocol.js";
export type { JsonRpcResponse, JsonSchema } from "./protocol.js";

export { classifyRequest, createSession, inspectModernMeta, negotiateLegacyVersion } from "./era.js";
export type { ProtocolEra, SessionState } from "./era.js";

export { validateArguments } from "./schema.js";

export type {
  McpPrompt,
  McpResourceContents,
  McpResourceDescriptor,
  McpResourceTemplate,
  McpServerInfo,
  McpTool,
  ResourceProvider,
  ToolAnnotations,
  ToolContext,
  ToolOutcome,
} from "./types.js";
