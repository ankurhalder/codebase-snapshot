/**
 * Validation for the modern Streamable HTTP request headers.
 *
 * Revision 2026-07-28 mirrors parts of the JSON-RPC body into headers so intermediaries can route
 * without parsing it, and requires the server to reject a request when the two disagree. The
 * body remains the source of truth: every check here compares the header to the parsed message.
 *
 * A missing header is not a legacy client. Legacy traffic does not carry `Mcp-Method`, so this
 * module stays out of its way; modern traffic is identified by its per-request `_meta`, by
 * `server/discover`, or by the presence of one of the new headers.
 */
import type { IncomingMessage } from "node:http";
import { inspectModernMeta } from "./era.js";
import { ERROR_CODES, META_KEYS, errorResponse, isJsonObject } from "./protocol.js";
import type { JsonObject, JsonRpcId, JsonRpcResponse } from "./protocol.js";

const PROTOCOL_HEADER = "mcp-protocol-version";
const METHOD_HEADER = "mcp-method";
const NAME_HEADER = "mcp-name";
const BASE64_PREFIX = "=?base64?";
const BASE64_SUFFIX = "?=";

/** Methods whose `Mcp-Name` is required by the transport specification. */
const NAMED_METHODS = new Set(["tools/call", "resources/read", "prompts/get"]);

export interface ModernHeaderVerdict {
  /** True when the message is modern HTTP traffic and the header rules apply. */
  modern: boolean;
  /** A complete JSON-RPC refusal when a required header is missing or disagrees. */
  error?: JsonRpcResponse;
}

function requestId(message: JsonObject): JsonRpcId | null {
  const raw = message.id;
  return typeof raw === "string" || typeof raw === "number" ? raw : null;
}

function header(request: IncomingMessage, name: string): string | null {
  const value = request.headers[name];
  return typeof value === "string" ? value : null;
}

/** Visible ASCII, space and tab: the field-value characters RFC 9110 permits. */
function isSafeHeaderValue(value: string): boolean {
  return /^[\x20-\x7e\t]+$/.test(value);
}

/**
 * Decodes the Base64 sentinel the specification defines for names that are not header-safe.
 *
 * A value that does not start with the sentinel is returned unchanged after the safe-character
 * check. A malformed sentinel is refused rather than treated as a literal name, because a server
 * that guessed would compare a header to the wrong body value.
 */
export function decodeMcpHeaderValue(value: string): string | null {
  if (!value.startsWith(BASE64_PREFIX)) {
    return isSafeHeaderValue(value) ? value : null;
  }
  if (!value.endsWith(BASE64_SUFFIX)) return null;
  const encoded = value.slice(BASE64_PREFIX.length, -BASE64_SUFFIX.length);
  if (encoded.length === 0 || encoded.length % 4 !== 0) return null;
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) return null;
  const decoded = Buffer.from(encoded, "base64").toString("utf8");
  // Node's decoder tolerates non-canonical input; a round trip rejects it. Invalid UTF-8 also
  // fails this comparison because decoding replaces it with U+FFFD.
  if (Buffer.from(decoded, "utf8").toString("base64") !== encoded) return null;
  return decoded;
}

/** True when this request belongs to the modern HTTP shape rather than the legacy one. */
export function isModernHttpMessage(request: IncomingMessage, message: unknown): boolean {
  if (Array.isArray(message)) {
    return message.some((item) => isModernHttpMessage(request, item));
  }
  if (!isJsonObject(message)) return false;
  if (message.method === "server/discover") return true;
  const params = isJsonObject(message.params) ? message.params : undefined;
  const meta = isJsonObject(params?._meta) ? params._meta : undefined;
  // A legacy request may carry `_meta.progressToken`; only the modern protocol keys identify the
  // modern envelope. An incomplete modern envelope still contains one of these two keys.
  if (
    meta !== undefined &&
    (META_KEYS.protocolVersion in meta || META_KEYS.clientCapabilities in meta)
  ) {
    return true;
  }
  return header(request, METHOD_HEADER) !== null || header(request, NAME_HEADER) !== null;
}

function refuse(
  id: JsonRpcId | null,
  code: number,
  message: string,
  data?: unknown
): JsonRpcResponse {
  return errorResponse(id, code, message, data);
}

/**
 * Validates the modern transport headers against one parsed JSON-RPC message.
 *
 * The return value is advisory for legacy messages. For modern messages an `error` field means
 * the caller must answer `400 Bad Request` with that JSON-RPC body and dispatch nothing.
 */
export function validateModernHttpHeaders(
  request: IncomingMessage,
  message: unknown
): ModernHeaderVerdict {
  if (!isModernHttpMessage(request, message)) return { modern: false };

  if (Array.isArray(message)) {
    return {
      modern: true,
      error: refuse(null, ERROR_CODES.invalidRequest, "Batch requests are not supported."),
    };
  }
  if (!isJsonObject(message)) {
    return {
      modern: true,
      error: refuse(null, ERROR_CODES.invalidRequest, "Message is not a JSON object."),
    };
  }

  const id = requestId(message);
  const method = message.method;
  const params = isJsonObject(message.params) ? message.params : undefined;
  if (typeof method !== "string" || method.length === 0) {
    return {
      modern: true,
      error: refuse(id, ERROR_CODES.invalidRequest, 'Message must carry a "method" string.'),
    };
  }

  const versionHeader = header(request, PROTOCOL_HEADER);
  if (versionHeader === null) {
    return {
      modern: true,
      error: refuse(
        id,
        ERROR_CODES.headerMismatch,
        `Header mismatch: ${PROTOCOL_HEADER} is required for a modern request.`
      ),
    };
  }
  if (!isSafeHeaderValue(versionHeader)) {
    return {
      modern: true,
      error: refuse(
        id,
        ERROR_CODES.headerMismatch,
        `Header mismatch: ${PROTOCOL_HEADER} contains invalid characters.`
      ),
    };
  }

  const meta = inspectModernMeta(params);
  if (meta.kind !== "present") {
    const missing = meta.kind === "incomplete" ? meta.missing : META_KEYS.protocolVersion;
    return {
      modern: true,
      error: refuse(
        id,
        ERROR_CODES.invalidParams,
        `The request _meta is missing the required key "${missing}".`
      ),
    };
  }
  if (versionHeader !== meta.meta.version) {
    return {
      modern: true,
      error: refuse(
        id,
        ERROR_CODES.headerMismatch,
        `Header mismatch: ${PROTOCOL_HEADER} "${versionHeader}" does not match body value "${meta.meta.version}".`
      ),
    };
  }

  const methodHeader = header(request, METHOD_HEADER);
  if (methodHeader === null) {
    return {
      modern: true,
      error: refuse(
        id,
        ERROR_CODES.headerMismatch,
        `Header mismatch: ${METHOD_HEADER} is required for a modern request.`
      ),
    };
  }
  if (!isSafeHeaderValue(methodHeader) || methodHeader !== method) {
    return {
      modern: true,
      error: refuse(
        id,
        ERROR_CODES.headerMismatch,
        `Header mismatch: ${METHOD_HEADER} value "${methodHeader}" does not match body value "${method}".`
      ),
    };
  }

  if (NAMED_METHODS.has(method)) {
    const nameHeader = header(request, NAME_HEADER);
    if (nameHeader === null) {
      return {
        modern: true,
        error: refuse(
          id,
          ERROR_CODES.headerMismatch,
          `Header mismatch: ${NAME_HEADER} is required for ${method}.`
        ),
      };
    }
    const decoded = decodeMcpHeaderValue(nameHeader);
    if (decoded === null) {
      return {
        modern: true,
        error: refuse(
          id,
          ERROR_CODES.headerMismatch,
          `Header mismatch: ${NAME_HEADER} contains an invalid value.`
        ),
      };
    }
    const bodyValue = method === "resources/read" ? params?.uri : params?.name;
    if (typeof bodyValue !== "string") {
      return {
        modern: true,
        error: refuse(
          id,
          ERROR_CODES.invalidParams,
          `${method} requires a "${method === "resources/read" ? "uri" : "name"}" string.`
        ),
      };
    }
    if (decoded !== bodyValue) {
      return {
        modern: true,
        error: refuse(
          id,
          ERROR_CODES.headerMismatch,
          `Header mismatch: ${NAME_HEADER} value "${decoded}" does not match body value "${bodyValue}".`
        ),
      };
    }
  }

  return { modern: true };
}

/** The HTTP status a modern JSON-RPC answer must carry, per the transport specification. */
export function modernHttpStatus(response: JsonRpcResponse): number {
  if (!("error" in response)) return 200;
  switch (response.error.code) {
    case ERROR_CODES.headerMismatch:
    case ERROR_CODES.unsupportedProtocolVersion:
    case ERROR_CODES.invalidParams:
    case ERROR_CODES.invalidRequest:
    case ERROR_CODES.parseError:
      return 400;
    case ERROR_CODES.methodNotFound:
      return 404;
    case ERROR_CODES.internalError:
      return 500;
    case ERROR_CODES.overloaded:
      return 503;
    default:
      return 200;
  }
}
