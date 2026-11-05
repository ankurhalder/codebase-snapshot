/**
 * Era detection and version negotiation.
 *
 * The modern revision deleted the handshake, so a server cannot know which era it is talking to
 * until a request arrives. The rule that decides it is small and is the whole reason this file
 * exists on its own:
 *
 *   - `initialize` means the caller speaks the legacy era;
 *   - `server/discover`, or any request carrying modern `_meta`, means the modern era;
 *   - a request with neither is a legacy client that skipped the handshake.
 *
 * The two eras also disagree about what an unsupported version means. Legacy negotiates *down*:
 * the lifecycle says the server answers with a version it does support and the client decides
 * whether to continue. Modern *rejects* the request with `-32022` and lists what it supports, so
 * the client can pick a version and retry. Getting this backwards breaks one era while looking
 * correct in the other, which is why both paths are tested separately.
 */
import {
  DEFAULT_LEGACY_PROTOCOL_VERSION,
  ERROR_CODES,
  LEGACY_PROTOCOL_VERSIONS,
  METHOD,
  META_KEYS,
  MODERN_PROTOCOL_VERSIONS,
  SUPPORTED_PROTOCOL_VERSIONS,
  isJsonObject,
} from "./protocol.js";
import type { JsonObject } from "./protocol.js";

export type ProtocolEra = "legacy" | "modern";

/** Per-connection state. The modern era has no session, so this stays empty until legacy init. */
export interface SessionState {
  /** Which era the connection committed to, or null before the first decisive request. */
  era: ProtocolEra | null;
  /** The revision in force. Null in legacy until `initialize` has been negotiated. */
  protocolVersion: string | null;
  /** True once `initialize` has been answered, which is the legacy lifecycle's gate. */
  ready: boolean;
}

export function createSession(): SessionState {
  return { era: null, protocolVersion: null, ready: false };
}

export function isLegacyVersion(version: string): boolean {
  return LEGACY_PROTOCOL_VERSIONS.includes(version);
}

export function isModernVersion(version: string): boolean {
  return MODERN_PROTOCOL_VERSIONS.includes(version);
}

export function isSupportedVersion(version: string): boolean {
  return SUPPORTED_PROTOCOL_VERSIONS.includes(version);
}

/** The modern request metadata, when a request carries it at all. */
export interface ModernMeta {
  version: string;
  clientCapabilities: JsonObject;
  clientInfo: JsonObject | null;
}

export type MetaInspection =
  | { kind: "absent" }
  | { kind: "incomplete"; missing: string }
  | { kind: "present"; meta: ModernMeta };

/**
 * Reads `_meta` from a request.
 *
 * `absent` and `incomplete` are different answers: a request with no `_meta` at all is a legacy
 * client, while a request with `_meta` that lacks a required key is a modern client making a
 * mistake — and telling those two apart is what keeps the legacy era from being rejected for a
 * field it never had.
 */
export function inspectModernMeta(params: JsonObject | undefined): MetaInspection {
  const raw = params?._meta;
  if (!isJsonObject(raw)) return { kind: "absent" };

  const version = raw[META_KEYS.protocolVersion];
  if (typeof version !== "string" || version.length === 0) {
    return { kind: "incomplete", missing: META_KEYS.protocolVersion };
  }
  const capabilities = raw[META_KEYS.clientCapabilities];
  if (!isJsonObject(capabilities)) {
    return { kind: "incomplete", missing: META_KEYS.clientCapabilities };
  }
  const info = raw[META_KEYS.clientInfo];

  return {
    kind: "present",
    meta: {
      version,
      clientCapabilities: capabilities,
      clientInfo: isJsonObject(info) ? info : null,
    },
  };
}

/** The error body a modern client needs in order to retry with a version we do speak. */
export function unsupportedVersionData(requested: string): JsonObject {
  return { requested, supported: [...SUPPORTED_PROTOCOL_VERSIONS] };
}

export type EraDecision =
  | { kind: "era"; era: ProtocolEra; version: string | null }
  | { kind: "error"; code: number; message: string; data?: unknown };

/**
 * Decides which era a request belongs to, and whether its version is acceptable.
 *
 * Once a connection commits to an era it stays committed. A legacy client that suddenly sends
 * modern `_meta` is confused rather than clever, and silently switching would answer half a
 * session in each shape.
 */
export function classifyRequest(
  method: string,
  params: JsonObject | undefined,
  session: SessionState
): EraDecision {
  const inspection = inspectModernMeta(params);

  if (session.era === "modern") {
    if (inspection.kind === "absent") {
      return {
        kind: "error",
        code: ERROR_CODES.invalidRequest,
        message:
          "This request has no _meta. The modern era requires " +
          `"${META_KEYS.protocolVersion}" and "${META_KEYS.clientCapabilities}" on every request.`,
      };
    }
    if (inspection.kind === "incomplete") {
      return {
        kind: "error",
        code: ERROR_CODES.invalidParams,
        message: `The request _meta is missing the required key "${inspection.missing}".`,
      };
    }
    if (!isModernVersion(inspection.meta.version)) {
      return {
        kind: "error",
        code: ERROR_CODES.unsupportedProtocolVersion,
        message: `Unsupported protocol version "${inspection.meta.version}".`,
        data: unsupportedVersionData(inspection.meta.version),
      };
    }
    return { kind: "era", era: "modern", version: inspection.meta.version };
  }

  if (session.era === "legacy") {
    return { kind: "era", era: "legacy", version: session.protocolVersion };
  }

  if (method === METHOD.initialize) {
    return { kind: "era", era: "legacy", version: null };
  }

  if (inspection.kind === "present") {
    if (!isModernVersion(inspection.meta.version)) {
      return {
        kind: "error",
        code: ERROR_CODES.unsupportedProtocolVersion,
        message: `Unsupported protocol version "${inspection.meta.version}".`,
        data: unsupportedVersionData(inspection.meta.version),
      };
    }
    return { kind: "era", era: "modern", version: inspection.meta.version };
  }

  if (inspection.kind === "incomplete") {
    return {
      kind: "error",
      code: ERROR_CODES.invalidParams,
      message: `The request _meta is missing the required key "${inspection.missing}".`,
    };
  }

  // `server/discover` with no `_meta` at all is the backward-compatibility probe the modern
  // specification describes for stdio: answer it, and the client learns which era it is on.
  if (method === METHOD.discover) {
    return { kind: "era", era: "modern", version: MODERN_PROTOCOL_VERSIONS[0] };
  }

  return { kind: "era", era: "legacy", version: null };
}

export interface LegacyNegotiation {
  version: string;
  /** False when the client asked for something we cannot speak and was negotiated down. */
  matched: boolean;
}

/**
 * Legacy version negotiation: echo a supported request, otherwise answer with our best.
 *
 * A client that asked for a modern revision here gets the newest *legacy* revision, not an error:
 * under this lifecycle the server's answer is the offer, and the client decides.
 */
export function negotiateLegacyVersion(requested: unknown): LegacyNegotiation {
  if (typeof requested === "string" && isLegacyVersion(requested)) {
    return { version: requested, matched: true };
  }
  return { version: DEFAULT_LEGACY_PROTOCOL_VERSION, matched: false };
}
