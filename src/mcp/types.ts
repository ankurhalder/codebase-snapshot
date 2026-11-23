/**
 * The capability records the MCP server serves.
 *
 * These are the shapes the protocol layer deals in, kept apart from the handlers that fill them so
 * the server can be tested with a fixed set of stubs and the tool table can be built without a
 * running transport.
 */
import type { InputSchema, JsonObject } from "./protocol.js";

/** Everything a handler may touch. Deliberately small: no transport, no session, no protocol. */
export interface ToolContext {
  /** Repository the server was launched for; every relative path resolves against it. */
  cwd: string;
  /** Absolute directories a `root` argument is allowed to resolve into. */
  roots: string[];
  /** True when `mcp --no-config` asked to ignore every configuration file. */
  noConfig?: boolean;
  /** Writes one line to stderr. Never stdout, which carries protocol messages only. */
  log: (line: string) => void;
  /**
   * Emits a progress notification for the current call.
   *
   * Present only when the client supplied a `progressToken` in `_meta` and the transport can carry
   * a notification mid-call (stdio). A tool that never calls it is still correct; a tool that does
   * gives a long run a heartbeat instead of a silent pause.
   */
  notify?: (event: { message: string; progress?: number; total?: number }) => void;
  /**
   * Registers a callback the server runs when the client cancels this call.
   *
   * A tool that can stop early (a generate terminates its worker) calls this once with the function
   * that stops it. A tool that cannot stops nothing, and the server simply runs it to completion.
   */
  onCancel?: (cancel: () => void) => void;
}

/**
 * Client-facing hints.
 *
 * `readOnlyHint` is the one that changes behaviour rather than appearance: clients use it to
 * auto-approve a call. Twenty-five of the 26 tools never write, so they are marked read-only;
 * only `snapshot_generate` writes.
 */
export interface ToolAnnotations {
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint: boolean;
  openWorldHint: boolean;
}

/** What a handler returns. The protocol layer turns this into a `CallToolResult`. */
export interface ToolOutcome {
  /** The text block a model reads. Keep it short: bulk content belongs in a windowed read. */
  text: string;
  /** Typed mirror of `text`, declared by the tool's `outputSchema`. */
  structured?: JsonObject;
  /** True for a tool-level failure. Reported inside the result, not as a JSON-RPC error. */
  isError?: boolean;
}

/**
 * How expensive a tool call is, in the units an agent can act on.
 *
 * `cheap` reads the manifest; `medium` reads one or a few parts; `expensive` reads the repository,
 * partitions it, or writes. The class is a hint for choosing between two tools that answer the
 * same question, and it is stated as a class because a token count depends on the repository.
 */
export type ToolCost = "cheap" | "medium" | "expensive";

export interface McpTool {
  name: string;
  title: string;
  description: string;
  inputSchema: InputSchema;
  outputSchema?: InputSchema;
  annotations: ToolAnnotations;
  /** Relative cost of a call; see `ToolCost`. */
  cost: ToolCost;
  handler(args: JsonObject, context: ToolContext): Promise<ToolOutcome>;
}

/** One addressable resource, as `resources/list` reports it. */
export interface McpResourceDescriptor {
  uri: string;
  name: string;
  title?: string;
  description: string;
  mimeType: string;
}

export interface McpResourceContents {
  uri: string;
  mimeType: string;
  text: string;
}

/** A parameterised resource family, as `resources/templates/list` reports it. */
export interface McpResourceTemplate {
  uriTemplate: string;
  name: string;
  title?: string;
  description: string;
  mimeType: string;
}

/**
 * Resources are computed per call rather than declared once.
 *
 * The list depends on what is on disk — a snapshot that has not been generated has manifest
 * resources that do not exist yet — so a static table would advertise resources whose read then
 * fails, which is worse than an honest short list.
 */
export interface ResourceProvider {
  list(context: ToolContext): Promise<McpResourceDescriptor[]>;
  templates(): McpResourceTemplate[];
  /** Resolves one URI. Returns null when this server does not own it. */
  read(uri: string, context: ToolContext): Promise<McpResourceContents | null>;
}

export interface PromptArgument {
  name: string;
  description: string;
  required: boolean;
}

export interface PromptMessage {
  role: "user" | "assistant";
  content: { type: "text"; text: string };
}

export interface McpPrompt {
  name: string;
  title?: string;
  description: string;
  arguments: PromptArgument[];
  build(args: JsonObject): { description: string; messages: PromptMessage[] };
}

/** Identity reported at handshake and in every modern result's `_meta`. */
export interface McpServerInfo {
  name: string;
  title: string;
  version: string;
  websiteUrl: string;
}
