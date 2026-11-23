import * as http from "node:http";
import * as crypto from "node:crypto";
import { createServer } from "./run.js";
import { buildTools } from "./tools.js";
import { GENERATOR_VERSION } from "../version.js";
import { parseBearerToken } from "../auth.js";
import type { McpServer } from "./server.js";
import type { JsonRpcResponse } from "./protocol.js";
import { isJsonObject } from "./protocol.js";
import { inspectModernMeta } from "./era.js";


/**
 * MCP over HTTP, for clients that are not a child process.
 *
 * The stdio transport is the default and stays the default: a client that can spawn a process
 * gets the simplest, most reliable path. This exists for the clients that cannot — browser-based
 * agents, hosted editors, anything living inside a page. It implements the Streamable HTTP shape:
 * one POST endpoint that carries a JSON-RPC message and answers with a JSON-RPC response.
 *
 * Three properties are deliberate:
 *
 *  - **Loopback unless told otherwise.** The server binds 127.0.0.1 by default. Making a
 *    repository readable from the network is a decision the user makes with --host, not a default.
 *  - **A token, or an explicit opt-out.** A page in a browser is a request with an Origin, and
 *    localhost ports are guessable. The token is generated on first use, printed once, and
 *    compared in constant time. --no-auth exists for the case where the client cannot send a
 *    header, and says what it gave up.
 *  - **No unbounded reads.** Request bodies are capped, rate is capped, and every response is one
 *    bounded JSON document. A browser tab that loops cannot pin the CPU.
 */

export interface HttpTransportOptions {
  /** Repository the tools operate on. */
  cwd: string;
  host?: string;
  port?: number;
  /** Bearer token. `undefined` generates one, `null` disables auth. */
  token?: string | null;
  /** Extra origins, beyond loopback. */
  allowedOrigins?: readonly string[];
  maxBodyBytes?: number;
  /** True when `mcp --no-config` asked to ignore every config file. */
  noConfig?: boolean;
  log?: (line: string) => void;
}

export interface HttpTransport {
  url: string;
  port: number;
  host: string;
  token: string | null;
  close(): Promise<void>;
}

export interface McpHttpHandlerOptions {
  cwd: string;
  token: string | null;
  allowedOrigins?: readonly string[];
  maxBodyBytes?: number;
  noConfig?: boolean;
  log?: (line: string) => void;
  /** Called for every MCP request, including a refused one. */
  onRequest?: (method: string) => void;
  /** Called for a 4xx refusal other than 429. */
  onRefused?: () => void;
  /** Called for a 429. */
  onRateLimited?: () => void;
}

export interface McpHttpHandler {
  readonly toolCount: number;
  /** Handles /mcp, /sse and /messages when the URL matches; false otherwise. */
  handle(request: http.IncomingMessage, response: http.ServerResponse): boolean;
  close(): Promise<void>;
}

const DEFAULT_PORT = 4789;
const DEFAULT_MAX_BODY = 2 * 1024 * 1024;
const RATE_LIMIT = 60;
const RATE_WINDOW_MS = 10_000;
/** Expensive tool calls allowed in flight across every HTTP session. */
const MAX_IN_FLIGHT = 4;
/** Bound on per-session servers and per-remote rate windows. */
const MAX_SESSION_ENTRIES = 64;
/** A session with no request for this long is no longer reachable. */
const SESSION_TTL_MS = 30 * 60 * 1000;
const MAX_SSE_SESSIONS = 64;
const MAX_RATE_WINDOWS = 1024;

/** The token a server generates when the caller did not pick one. */
export function generateToken(): string {
  return crypto.randomBytes(24).toString("base64url");
}

function isLoopbackOrigin(origin: string): boolean {
  try {
    const url = new URL(origin);
    if (url.protocol !== "http:" && url.protocol !== "https:") return false;
    const host = url.hostname;
    return host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host === "::1";
  } catch {
    return false;
  }
}

function timingSafeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left, "utf8");
  const b = Buffer.from(right, "utf8");
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function sessionHeader(request: http.IncomingMessage): string {
  const header = request.headers["mcp-session-id"];
  return typeof header === "string" ? header.trim() : "";
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isToolCall(message: unknown): boolean {
  return isObject(message) && message.method === "tools/call";
}

function methodOf(message: unknown): string | null {
  return isObject(message) && typeof message.method === "string" ? message.method : null;
}

/** True when any message in a request carries complete modern `_meta`. */
function hasModernMeta(message: unknown): boolean {
  const messages = Array.isArray(message) ? message : [message];
  return messages.some(
    (item) =>
      isJsonObject(item) &&
      isJsonObject(item.params) &&
      inspectModernMeta(item.params).kind === "present"
  );
}

/**
 * One mountable MCP HTTP/SSE handler.
 *
 * `startHttpTransport` and `serve` both use this function. They used to carry two separate
 * implementations: the second one kept MCP state per TCP socket, ignored `mcp-session-id`, omitted
 * the header from CORS, and had no /sse or /messages at all even though the deployment docs
 * advertised them. A transport bug fixed in one copy could not reach the other.
 */
export function createMcpHttpHandler(options: McpHttpHandlerOptions): McpHttpHandler {
  const log = options.log ?? ((line: string) => process.stderr.write(line + "\n"));
  const token = options.token;
  const maxBody = options.maxBodyBytes ?? DEFAULT_MAX_BODY;
  const extraOrigins = options.allowedOrigins ?? [];
  const createMcp = (): McpServer =>
    createServer({
      cwd: options.cwd,
      log,
      ...(options.noConfig === true ? { noConfig: true } : {}),
    });
  const toolCount = buildTools().length;

  const mcpSessions = new Map<string, { server: McpServer; lastSeen: number }>();
  const socketServers = new WeakMap<object, McpServer>();
  const anonymousServers = new Map<string, McpServer>();
  const sseSessions = new Map<
    string,
    { write: (payload: string) => void; end: () => void; server: McpServer }
  >();
  const rateWindows = new Map<string, { count: number; resetAt: number }>();
  let inFlight = 0;

  const newSessionId = (): string => crypto.randomBytes(12).toString("hex");

  /** Drop sessions past their idle TTL before any lookup or insertion. */
  const pruneSessions = (now: number): void => {
    for (const [id, entry] of mcpSessions) {
      if (now - entry.lastSeen > SESSION_TTL_MS) mcpSessions.delete(id);
    }
  };

  /** Insert a session, evicting the oldest idle session rather than silently dropping a new one. */
  const rememberSession = (id: string, server: McpServer, now: number): void => {
    pruneSessions(now);
    if (!mcpSessions.has(id) && mcpSessions.size >= MAX_SESSION_ENTRIES) {
      let oldestId: string | null = null;
      let oldestSeen = Infinity;
      for (const [candidate, entry] of mcpSessions) {
        if (entry.lastSeen < oldestSeen) {
          oldestSeen = entry.lastSeen;
          oldestId = candidate;
        }
      }
      if (oldestId !== null) mcpSessions.delete(oldestId);
    }
    mcpSessions.set(id, { server, lastSeen: now });
  };

  const anonymousKey = (request: http.IncomingMessage): string => {
    const userAgent =
      typeof request.headers["user-agent"] === "string" ? request.headers["user-agent"] : "";
    return (request.socket.remoteAddress ?? "unknown") + "\0" + userAgent;
  };
  const rememberAnonymous = (key: string, server: McpServer): void => {
    if (anonymousServers.size >= 64 && !anonymousServers.has(key)) {
      const oldest = anonymousServers.keys().next().value;
      if (oldest !== undefined) anonymousServers.delete(oldest);
    }
    anonymousServers.set(key, server);
  };
  const fallbackServer = (request: http.IncomingMessage): McpServer => {
    // Fallback for clients that do not forward the session header. The spec-compliant path is the
    // header; a client that ignores it still needs initialize and tools/list to share state, so
    // this pool is keyed by remote address and user agent.
    const onSocket = socketServers.get(request.socket);
    if (onSocket !== undefined) return onSocket;
    const fallbackKey = anonymousKey(request);
    let fallback = anonymousServers.get(fallbackKey);
    if (fallback === undefined) {
      fallback = createMcp();
      rememberAnonymous(fallbackKey, fallback);
    }
    socketServers.set(request.socket, fallback);
    return fallback;
  };
  const allowedOrigin = (origin: string | undefined): string | null => {
    if (origin === undefined) return null;
    if (isLoopbackOrigin(origin)) return origin;
    return extraOrigins.includes(origin) ? origin : null;
  };

  const tokenAccepted = (
    request: http.IncomingMessage,
    url: URL,
    allowQuery: boolean
  ): boolean => {
    if (token === null) return true;
    const presented = parseBearerToken(request.headers.authorization);
    if (presented !== null && timingSafeEqual(presented, token)) return true;
    if (!allowQuery) return false;
    const fromQuery = url.searchParams.get("token");
    return fromQuery !== null && timingSafeEqual(fromQuery, token);
  };

  const rememberRateWindow = (remote: string, now: number, cost = 1): void => {
    if (!rateWindows.has(remote) && rateWindows.size >= MAX_RATE_WINDOWS) {
      for (const [key, value] of rateWindows) if (value.resetAt <= now) rateWindows.delete(key);
      while (rateWindows.size >= MAX_RATE_WINDOWS) {
        const oldest = rateWindows.keys().next().value;
        if (oldest === undefined) break;
        rateWindows.delete(oldest);
      }
    }
    rateWindows.set(remote, { count: cost, resetAt: now + RATE_WINDOW_MS });
  };

  const rateLimited = (request: http.IncomingMessage, cost = 1): boolean => {
    const remote = request.socket.remoteAddress ?? "unknown";
    const now = Date.now();
    const window = rateWindows.get(remote);
    if (window === undefined || window.resetAt <= now) {
      rememberRateWindow(remote, now, cost);
      return cost > RATE_LIMIT;
    }
    if (window.count + cost > RATE_LIMIT) return true;
    window.count += cost;
    return false;
  };

  const send = (
    response: http.ServerResponse,
    status: number,
    body: unknown,
    cors: Record<string, string>,
    extra: Record<string, string> = {}
  ): void => {
    if (response.headersSent || response.writableEnded) return;
    const text = typeof body === "string" ? body : JSON.stringify(body);
    const headers: Record<string, string> = {
      ...cors,
      "content-type":
        typeof body === "string" ? "text/plain; charset=utf-8" : "application/json; charset=utf-8",
      "content-length": String(Buffer.byteLength(text, "utf8")),
      "x-content-type-options": "nosniff",
      ...extra,
    };
    if (status >= 400 && status < 500 && status !== 429) options.onRefused?.();
    try {
      response.writeHead(status, headers);
      response.end(text);
    } catch {
      // The peer may have closed between the check and the write.
    }
  };

  const corsFor = (
    request: http.IncomingMessage,
    response: http.ServerResponse
  ): Record<string, string> | null => {
    const origin = typeof request.headers.origin === "string" ? request.headers.origin : undefined;
    const allowed = allowedOrigin(origin);
    if (origin !== undefined && allowed === null) {
      send(response, 403, { error: "origin not allowed" }, {});
      return null;
    }
    if (allowed === null) return {};
    return {
      "access-control-allow-origin": allowed,
      vary: "origin",
      "access-control-allow-headers":
        "authorization, content-type, mcp-protocol-version, mcp-session-id",
      // Without this a browser can send the header but cannot read it: mcp-session-id is not a
      // CORS-safelisted response header, so every cross-origin client silently lost its session.
      "access-control-expose-headers": "mcp-session-id",
      "access-control-allow-methods": "POST, GET, OPTIONS, DELETE",
      "access-control-max-age": "600",
    };
  };

  const unauthorized = (
    response: http.ServerResponse,
    cors: Record<string, string>
  ): void => {
    send(response, 401, { error: "unauthorized" }, cors, {
      "www-authenticate": 'Bearer realm="codebase-snapshot"',
    });
  };

  const tooMany = (response: http.ServerResponse, cors: Record<string, string>): void => {
    options.onRateLimited?.();
    send(response, 429, { error: "too many requests" }, cors, { "retry-after": "10" });
  };

  const busyResponse = (id: unknown): JsonRpcResponse => ({
    jsonrpc: "2.0",
    id: typeof id === "string" || typeof id === "number" || id === null ? id : null,
    error: {
      code: -32001,
      message: "server busy: too many tool calls are already in flight",
    },
  });

  const acquireToolSlot = (): boolean => {
    if (inFlight >= MAX_IN_FLIGHT) return false;
    inFlight += 1;
    return true;
  };
  const releaseToolSlot = (): void => {
    if (inFlight > 0) inFlight -= 1;
  };

  const readJsonBody = (
    request: http.IncomingMessage,
    response: http.ServerResponse,
    cors: Record<string, string>,
    onBody: (message: unknown) => void
  ): void => {
    let received = 0;
    let tooLarge = false;
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => {
      if (tooLarge) return;
      received += chunk.length;
      if (received > maxBody) {
        tooLarge = true;
        // Stop buffering, but let the 413 reach the client before the socket is torn down.
        // Destroying the request here reset the connection first and the documented 413 was
        // never observed by a streaming client (it saw ECONNRESET).
        chunks.length = 0;
        request.pause();
        send(response, 413, { error: "request body too large", limit: maxBody }, cors, {
          connection: "close",
        });
        response.once("finish", () => {
          try {
            request.destroy();
          } catch {
            // Already gone.
          }
        });
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      if (tooLarge) return;
      let message: unknown;
      try {
        message = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch (error) {
        send(
          response,
          400,
          { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error: " + (error as Error).message } },
          cors
        );
        return;
      }
      onBody(message);
    });
    request.on("error", () => {
      try {
        response.destroy();
      } catch {
        // Already gone.
      }
    });
  };

  const handleSse = (
    request: http.IncomingMessage,
    response: http.ServerResponse,
    url: URL,
    cors: Record<string, string>
  ): void => {
    if (!tokenAccepted(request, url, true)) {
      unauthorized(response, cors);
      return;
    }
    if (rateLimited(request)) {
      tooMany(response, cors);
      return;
    }
    if (sseSessions.size >= MAX_SSE_SESSIONS) {
      send(response, 503, { error: "too many open SSE sessions" }, cors, { "retry-after": "10" });
      return;
    }
    const id = crypto.randomBytes(12).toString("hex");
    const streamCors = {
      ...cors,
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    };
    response.writeHead(200, streamCors);
    const write = (payload: string): void => {
      try {
        response.write(payload);
      } catch {
        // A client that disconnected mid-call is not a server failure.
      }
    };
    sseSessions.set(id, {
      write,
      end: () => {
        try {
          response.end();
        } catch {
          // Already closed.
        }
      },
      server: createMcp(),
    });
    const heartbeat = setInterval(() => write(": ping\n\n"), 15_000);
    const cleanup = (): void => {
      clearInterval(heartbeat);
      sseSessions.delete(id);
    };
    request.on("close", cleanup);
    response.on("close", cleanup);
    write("event: endpoint\ndata: /messages?sessionId=" + id + "\n\n");
  };

  const handleMessages = (
    request: http.IncomingMessage,
    response: http.ServerResponse,
    url: URL,
    cors: Record<string, string>
  ): void => {
    if (!tokenAccepted(request, url, true)) {
      unauthorized(response, cors);
      return;
    }
    if (rateLimited(request)) {
      tooMany(response, cors);
      return;
    }
    const id = url.searchParams.get("sessionId") ?? "";
    const stream = sseSessions.get(id);
    if (stream === undefined) {
      send(response, 404, { error: "unknown sessionId; open GET /sse first" }, cors);
      return;
    }
    readJsonBody(request, response, cors, (message) => {
      const gated = isToolCall(message);
      if (gated && !acquireToolSlot()) {
        const answer = busyResponse(isObject(message) ? message.id : null);
        stream.write("event: message\ndata: " + JSON.stringify(answer) + "\n\n");
        send(response, 202, "", cors);
        return;
      }
      void (async () => {
        try {
          const answer = await stream.server.handle(message);
          if (answer !== null) stream.write("event: message\ndata: " + JSON.stringify(answer) + "\n\n");
        } finally {
          if (gated) releaseToolSlot();
        }
        send(response, 202, "", cors);
      })().catch((error: unknown) => {
        log("mcp/http: " + (error as Error).message);
        send(response, 500, { jsonrpc: "2.0", id: null, error: { code: -32603, message: "Internal error" } }, cors);
      });
    });
  };

  const handleMcp = (
    request: http.IncomingMessage,
    response: http.ServerResponse,
    cors: Record<string, string>
  ): void => {
    if (!tokenAccepted(request, new URL(request.url ?? "/", "http://localhost"), false)) {
      unauthorized(response, cors);
      return;
    }
    // Charge the HTTP envelope before reading the body. Charging after parsing let malformed
    // JSON, an oversized body and an empty batch reach the parser without ever touching the
    // window; [] added zero, so a client could send them forever.
    if (rateLimited(request)) {
      tooMany(response, cors);
      return;
    }

    if (request.method === "DELETE") {
      const supplied = sessionHeader(request);
      if (supplied === "") {
        send(response, 400, { error: "DELETE /mcp requires mcp-session-id" }, cors);
        return;
      }
      const now = Date.now();
      pruneSessions(now);
      if (!mcpSessions.has(supplied)) {
        send(response, 404, { error: "unknown mcp-session-id" }, cors);
        return;
      }
      mcpSessions.delete(supplied);
      send(response, 204, "", cors);
      return;
    }

    if (request.method !== "POST") {
      send(response, 405, { error: "method not allowed" }, cors, { allow: "POST, DELETE, OPTIONS" });
      return;
    }

    readJsonBody(request, response, cors, (message) => {
      const batch = Array.isArray(message) ? message : [message];
      // JSON-RPC 2.0 requires a batch to contain at least one request. Accepting [] with 202
      // was also the zero-cost rate-limit path.
      if (batch.length === 0) {
        send(
          response,
          400,
          { jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid Request: empty batch" } },
          cors
        );
        return;
      }
      if (batch.length > 100) {
        send(response, 400, { error: "JSON-RPC batch is limited to 100 messages" }, cors);
        return;
      }
      // The envelope was charged above. Charge the remaining JSON-RPC messages, so the
      // documented 60-per-10s bound applies to dispatches rather than envelopes.
      if (batch.length > 1 && rateLimited(request, batch.length - 1)) {
        tooMany(response, cors);
        return;
      }

      const supplied = sessionHeader(request);
      let server: McpServer;
      let responseSession = "";
      const initializeInBatch = batch.some((item) => methodOf(item) === "initialize");
      if (initializeInBatch) {
        // JSON-RPC allows a batch, but initialize is a connection handshake that must be alone.
        // Letting it through as an array skipped the session-minting branch and returned a 200
        // with no mcp-session-id, leaving the client on the anonymous shared fallback.
        if (batch.length !== 1 || supplied !== "") {
          send(response, 400, { error: "initialize must be sent alone, without mcp-session-id" }, cors);
          return;
        }
        // A new initialize gets a new server even on a reused connection. Reusing the per-socket
        // fallback here meant two clients that both initialized without forwarding the header
        // shared one era state, so one client's `server/discover` rejected the other's legacy
        // requests. The socket map is updated so a client that ignores the header on later
        // requests still reaches this server.
        server = createMcp();
        socketServers.set(request.socket, server);
        // A client that ignores the header can reconnect; keep the initialized server reachable
        // through the documented per-address fallback as well as this socket.
        rememberAnonymous(anonymousKey(request), server);
        responseSession = newSessionId();
        rememberSession(responseSession, server, Date.now());
      } else if (supplied !== "") {
        const now = Date.now();
        pruneSessions(now);
        const existing = mcpSessions.get(supplied);
        if (existing === undefined) {
          // Never mint state for a caller-chosen id. The old implementation created a server for
          // any header and then silently failed to store it once the table was full.
          send(response, 404, { error: "unknown mcp-session-id" }, cors);
          return;
        }
        existing.lastSeen = now;
        server = existing.server;
        responseSession = supplied;
      } else if (hasModernMeta(message)) {
        // A stateless modern request is complete on its own. Sharing the anonymous pool with a
        // co-located legacy client let that client's initialize overwrite the era state, so a
        // later modern response was shaped as legacy. A fresh dispatcher has exactly the state
        // a stateless request is entitled to.
        server = createMcp();
      } else {
        server = fallbackServer(request);
      }

      const sessionHeaders =
        responseSession === "" ? cors : { ...cors, "mcp-session-id": responseSession };
      const answers: JsonRpcResponse[] = [];
      void (async () => {
        for (const item of batch) {
          const gated = isToolCall(item);
          if (gated && !acquireToolSlot()) {
            answers.push(busyResponse(isObject(item) ? item.id : null));
            continue;
          }
          try {
            const answer = await server.handle(item);
            if (answer !== null) answers.push(answer);
          } finally {
            if (gated) releaseToolSlot();
          }
        }
        if (answers.length === 0) {
          send(response, 202, "", sessionHeaders);
          return;
        }
        send(response, 200, Array.isArray(message) ? answers : answers[0], sessionHeaders);
      })().catch((error: unknown) => {
        log("mcp/http: " + (error as Error).message);
        send(response, 500, { jsonrpc: "2.0", id: null, error: { code: -32603, message: "Internal error" } }, cors);
      });
    });
  };

  return {
    toolCount,
    handle(request: http.IncomingMessage, response: http.ServerResponse): boolean {
      let url: URL;
      try {
        url = new URL(request.url ?? "/", "http://localhost");
      } catch {
        return false;
      }
      if (url.pathname !== "/mcp" && url.pathname !== "/sse" && url.pathname !== "/messages") {
        return false;
      }
      options.onRequest?.(request.method ?? "UNKNOWN");
      const cors = corsFor(request, response);
      if (cors === null) return true;
      if (request.method === "OPTIONS") {
        send(response, 204, "", cors);
        return true;
      }
      if (url.pathname === "/sse") {
        if (request.method !== "GET") {
          send(response, 405, { error: "method not allowed" }, cors, { allow: "GET, OPTIONS" });
          return true;
        }
        handleSse(request, response, url, cors);
        return true;
      }
      if (url.pathname === "/messages") {
        if (request.method !== "POST") {
          send(response, 405, { error: "method not allowed" }, cors, { allow: "POST, OPTIONS" });
          return true;
        }
        handleMessages(request, response, url, cors);
        return true;
      }
      handleMcp(request, response, cors);
      return true;
    },
    async close(): Promise<void> {
      for (const [, session] of sseSessions) {
        try {
          session.end();
        } catch {
          // The client may already be gone.
        }
      }
      sseSessions.clear();
      mcpSessions.clear();
      anonymousServers.clear();
      rateWindows.clear();
    },
  };
}

export async function startHttpTransport(options: HttpTransportOptions): Promise<HttpTransport> {
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? DEFAULT_PORT;
  const log = options.log ?? ((line: string) => process.stderr.write(line + "\n"));
  const token = options.token === undefined ? generateToken() : options.token;
  if (token === null && host !== "127.0.0.1" && host !== "localhost" && host !== "::1") {
    throw new Error(
      "Refusing to serve " + host + " without a token: a repository reachable from the network " +
        "must require Authorization. Drop --no-auth, or bind the loopback address."
    );
  }

  const metrics = {
    requests: 0,
    byMethod: new Map<string, number>(),
    refused: 0,
    rateLimited: 0,
    started: Date.now(),
  };
  const noteRequest = (method: string): void => {
    metrics.requests += 1;
    metrics.byMethod.set(method, (metrics.byMethod.get(method) ?? 0) + 1);
  };
  const mcp = createMcpHttpHandler({
    cwd: options.cwd,
    token,
    ...(options.allowedOrigins === undefined ? {} : { allowedOrigins: options.allowedOrigins }),
    ...(options.maxBodyBytes === undefined ? {} : { maxBodyBytes: options.maxBodyBytes }),
    ...(options.noConfig === true ? { noConfig: true } : {}),
    log,
    onRequest: noteRequest,
    onRefused: () => {
      metrics.refused += 1;
    },
    onRateLimited: () => {
      metrics.rateLimited += 1;
    },
  });
  const toolCount = mcp.toolCount;
  const extraOrigins = options.allowedOrigins ?? [];
  const allowedOrigin = (origin: string | undefined): string | null => {
    if (origin === undefined) return null;
    if (isLoopbackOrigin(origin)) return origin;
    return extraOrigins.includes(origin) ? origin : null;
  };
  const tokenAccepted = (request: http.IncomingMessage, _url: URL): boolean => {
    if (token === null) return true;
    const presented = parseBearerToken(request.headers.authorization);
    return presented !== null && timingSafeEqual(presented, token);
  };

  const httpServer = http.createServer((request, response) => {
    if (mcp.handle(request, response)) return;
    noteRequest(request.method ?? "UNKNOWN");

    // One response per request. Oversized bodies arrive in several chunks; without this flag the
    // data handler answered 413 once per chunk and the second writeHead threw
    // ERR_HTTP_HEADERS_SENT, taking the server down.
    let responseSent = false;
    const send = (status: number, body: unknown, extra: Record<string, string> = {}): void => {
      if (responseSent) return;
      responseSent = true;
      const text = typeof body === "string" ? body : JSON.stringify(body);
      if (status >= 400 && status < 500 && status !== 429) metrics.refused += 1;
      response.writeHead(status, {
        "content-type": typeof body === "string" ? "text/plain; charset=utf-8" : "application/json",
        "content-length": Buffer.byteLength(text, "utf8"),
        "x-content-type-options": "nosniff",
        ...extra,
      });
      response.end(text);
    };

    const origin = typeof request.headers.origin === "string" ? request.headers.origin : undefined;
    const allowed = allowedOrigin(origin);
    if (origin !== undefined && allowed === null) {
      send(403, { error: "origin not allowed" });
      return;
    }
    const cors: Record<string, string> = {};
    if (allowed !== null) {
      cors["access-control-allow-origin"] = allowed;
      cors.vary = "origin";
      cors["access-control-allow-headers"] =
        "authorization, content-type, mcp-protocol-version, mcp-session-id";
      cors["access-control-expose-headers"] = "mcp-session-id";
      cors["access-control-allow-methods"] = "POST, GET, OPTIONS, DELETE";
      cors["access-control-max-age"] = "600";
    }

    if (request.method === "OPTIONS") {
      send(204, "", cors);
      return;
    }

    if (request.method === "GET" && request.url === "/healthz") {
      send(
        200,
        {
          ok: true,
          name: "codebase-snapshot",
          version: GENERATOR_VERSION,
          tools: toolCount,
          uptimeSeconds: Math.round(process.uptime()),
        },
        cors
      );
      return;
    }

    if (request.method === "GET" && request.url === "/metrics") {
      if (
        token !== null &&
        host !== "127.0.0.1" &&
        host !== "localhost" &&
        host !== "::1" &&
        !tokenAccepted(request, new URL(request.url, "http://localhost"))
      ) {
        send(401, { error: "unauthorized" }, { "www-authenticate": 'Bearer realm="codebase-snapshot"' });
        return;
      }
      const lines = [
        "# HELP snapshot_uptime_seconds Seconds since the process started.",
        "# TYPE snapshot_uptime_seconds gauge",
        "snapshot_uptime_seconds " + Math.round(process.uptime()),
        "# HELP snapshot_requests_total HTTP requests received.",
        "# TYPE snapshot_requests_total counter",
        "snapshot_requests_total " + metrics.requests,
        "# HELP snapshot_requests_refused_total Requests refused before dispatch (4xx other than 429).",
        "# TYPE snapshot_requests_refused_total counter",
        "snapshot_requests_refused_total " + metrics.refused,
        "# HELP snapshot_requests_rate_limited_total Requests rejected by the rate limit.",
        "# TYPE snapshot_requests_rate_limited_total counter",
        "snapshot_requests_rate_limited_total " + metrics.rateLimited,
        "# HELP snapshot_tools Number of tools this server serves.",
        "# TYPE snapshot_tools gauge",
        "snapshot_tools " + toolCount,
      ];
      for (const [method, count] of metrics.byMethod) {
        lines.push('snapshot_requests_by_method_total{method="' + method + '"} ' + count);
      }
      send(200, lines.join("\n") + "\n", {
        ...cors,
        "content-type": "text/plain; version=0.0.4; charset=utf-8",
      });
      return;
    }

    if (request.url === "/") {
      send(
        200,
        "codebase-snapshot MCP server\n\nPOST JSON-RPC 2.0 to /mcp. Health: GET /healthz.\n",
        cors
      );
      return;
    }

    send(405, { error: "method not allowed" }, { ...cors, allow: "POST, GET, OPTIONS, DELETE" });
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(port, host, () => {
      httpServer.removeListener("error", reject);
      resolve();
    });
  });

  const address = httpServer.address();
  const actualPort = typeof address === "object" && address !== null ? address.port : port;
  const displayHost = host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host;

  return {
    url: "http://" + displayHost + ":" + actualPort + "/mcp",
    port: actualPort,
    host,
    token,
    close: async () => {
      await mcp.close();
      await new Promise<void>((resolve) => {
        httpServer.close(() => resolve());
        httpServer.closeAllConnections();
      });
    },
  };
}
