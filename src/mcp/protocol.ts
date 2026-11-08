/**
 * JSON-RPC 2.0 envelopes and the Model Context Protocol revisions this server speaks.
 *
 * Two protocol eras coexist and this file is the only place that knows which revision belongs
 * to which era. The legacy era (`2025-11-25` and earlier) opens every connection with an
 * `initialize` handshake. The modern era (`2026-07-28`) removed the handshake: every request
 * carries the protocol version and client capabilities in `_meta`, `server/discover` is
 * mandatory, every result carries `resultType`, and `ping` no longer exists.
 *
 * The constants are read by the negotiation in `era.ts`, by the dispatch in `server.ts` and by
 * the `describe` contract, so a revision cannot be added to one of them and forgotten in the
 * others.
 */

/** A JSON object as it appears on the wire: the shape every `params`/`result` takes. */
export type JsonObject = Record<string, unknown>;

export type JsonRpcId = string | number;

/** A request: has an `id` and expects exactly one response. */
export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: JsonRpcId;
  method: string;
  params?: JsonObject;
}

/** A notification: no `id`, and a response is a protocol violation. */
export interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: JsonObject;
}

export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

export interface JsonRpcSuccessResponse {
  jsonrpc: "2.0";
  id: JsonRpcId | null;
  result: JsonObject;
}

export interface JsonRpcErrorResponse {
  jsonrpc: "2.0";
  id: JsonRpcId | null;
  error: JsonRpcError;
}

export type JsonRpcResponse = JsonRpcSuccessResponse | JsonRpcErrorResponse;

/**
 * Revisions that open with the `initialize` handshake, newest first.
 *
 * The server echoes the requested revision when it is in this list and otherwise answers with
 * the newest entry: the legacy lifecycle says a server that cannot speak the requested version
 * responds with one it does speak, and the client decides whether to continue.
 */
export const LEGACY_PROTOCOL_VERSIONS: readonly string[] = ["2025-11-25", "2025-06-18"];

/** Revisions that carry version and capabilities on every request, newest first. */
export const MODERN_PROTOCOL_VERSIONS: readonly string[] = ["2026-07-28"];

/** Everything advertised in `server/discover` and in an unsupported-version error. */
export const SUPPORTED_PROTOCOL_VERSIONS: readonly string[] = [
  ...MODERN_PROTOCOL_VERSIONS,
  ...LEGACY_PROTOCOL_VERSIONS,
];

/** The revision a legacy client gets when it asks for something this server cannot speak. */
export const DEFAULT_LEGACY_PROTOCOL_VERSION = LEGACY_PROTOCOL_VERSIONS[0];

/**
 * JSON-RPC error codes, plus the one the modern era added.
 *
 * `-32022` is not a generic bad-params error: a client that receives it knows to read
 * `data.supported` and retry with a mutually supported revision. Reporting it as `-32602`
 * would leave a modern client with no way to recover.
 */
export const ERROR_CODES = {
  parseError: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internalError: -32603,
  /**
   * A resource whose complete text is larger than one read may return.
   *
   * `-32000` is JSON-RPC's range for implementation-defined server errors, which is what this is:
   * there is no standard code for "the document is too large", and answering with -32602 would tell
   * a client its request was malformed when it was not. The message names the size, the limit and
   * the tool to use instead, because a resource read that cannot return the whole resource must not
   * invent a partial one.
   */
  resourceTooLarge: -32000,
  unsupportedProtocolVersion: -32022,
} as const;

/** Method names, kept as constants so a typo is a compile error rather than a `-32601`. */
export const METHOD = {
  initialize: "initialize",
  initialized: "notifications/initialized",
  discover: "server/discover",
  ping: "ping",
  toolsList: "tools/list",
  toolsCall: "tools/call",
  resourcesList: "resources/list",
  resourcesRead: "resources/read",
  resourceTemplatesList: "resources/templates/list",
  promptsList: "prompts/list",
  promptsGet: "prompts/get",
  cancelled: "notifications/cancelled",
} as const;

/** `_meta` keys the modern era defines. */
export const META_KEYS = {
  protocolVersion: "io.modelcontextprotocol/protocolVersion",
  clientCapabilities: "io.modelcontextprotocol/clientCapabilities",
  clientInfo: "io.modelcontextprotocol/clientInfo",
  serverInfo: "io.modelcontextprotocol/serverInfo",
  progressToken: "progressToken",
} as const;

/** True for a plain JSON object, which is the only thing a `params`/`result` may be. */
export function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * A JSON Schema subset, as far as this server needs it.
 *
 * Deliberately not `unknown`: the tool table is authored by hand, and the compiler catching a
 * misspelled keyword is worth more than accepting every dialect feature we never emit.
 */
export interface JsonSchema {
  type?: "object" | "string" | "number" | "integer" | "boolean" | "array";
  description?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  enum?: readonly string[];
  default?: string | number | boolean;
  additionalProperties?: boolean;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
}

/** An `inputSchema` root: MCP requires a top-level object schema. */
export interface InputSchema extends JsonSchema {
  type: "object";
  properties: Record<string, JsonSchema>;
}

/**
 * `_meta` every result carries in the modern era.
 *
 * A server identifies itself on each result rather than once at handshake, because there is no
 * handshake any more. The legacy era has no equivalent and must not receive this field.
 */
export function serverInfoMeta(info: {
  name: string;
  title?: string;
  version: string;
}): JsonObject {
  const value: JsonObject = { name: info.name, version: info.version };
  if (info.title) value.title = info.title;
  return { [META_KEYS.serverInfo]: value };
}

/** Builds a successful response. `modern` decides whether `resultType` and `_meta` appear. */
export function successResponse(
  id: JsonRpcId | null,
  result: JsonObject,
  modern: boolean,
  info: { name: string; title?: string; version: string }
): JsonRpcSuccessResponse {
  if (!modern) return { jsonrpc: "2.0", id, result };
  const withMeta: JsonObject = {
    ...result,
    resultType: "complete",
    _meta: { ...(isJsonObject(result._meta) ? result._meta : {}), ...serverInfoMeta(info) },
  };
  return { jsonrpc: "2.0", id, result: withMeta };
}

/** Builds an error response. Errors are identical in both eras. */
export function errorResponse(
  id: JsonRpcId | null,
  code: number,
  message: string,
  data?: unknown
): JsonRpcErrorResponse {
  const error: JsonRpcError = { code, message };
  if (data !== undefined) error.data = data;
  return { jsonrpc: "2.0", id, error };
}
