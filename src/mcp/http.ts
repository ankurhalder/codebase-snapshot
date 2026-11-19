import * as http from "node:http";
import * as crypto from "node:crypto";
import { createServer } from "./run.js";
import { buildTools } from "./tools.js";
import { GENERATOR_VERSION } from "../version.js";
import type { McpServer } from "./server.js";
import type { JsonRpcResponse } from "./protocol.js";

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
  log?: (line: string) => void;
}

export interface HttpTransport {
  url: string;
  port: number;
  host: string;
  token: string | null;
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

export async function startHttpTransport(options: HttpTransportOptions): Promise<HttpTransport> {
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? DEFAULT_PORT;
  const log = options.log ?? ((line: string) => process.stderr.write(line + "\n"));
  const token = options.token === undefined ? generateToken() : options.token;
  const maxBody = options.maxBodyBytes ?? DEFAULT_MAX_BODY;
  const extraOrigins = options.allowedOrigins ?? [];
  if (token === null && host !== "127.0.0.1" && host !== "localhost" && host !== "::1") {
    throw new Error(
      "Refusing to serve " + host + " without a token: a repository reachable from the network " +
        "must require Authorization. Drop --no-auth, or bind the loopback address."
    );
  }

  const createMcp = (): McpServer => createServer({ cwd: options.cwd, log });
  const toolCount = buildTools().length;
  /**
   * One server per client, not one per process.
   *
   * The era and the cancellation map are session state. A shared instance let client A's
   * `server/discover` permanently reject client B's legacy `initialize`, and let a cancellation
   * from one client stop request id 1 in another. Streamable HTTP clients name their session with
   * `mcp-session-id`; clients that do not get one server per TCP socket.
   */
  const mcpSessions = new Map<string, McpServer>();
  const socketServers = new WeakMap<object, McpServer>();
  /** Insert a server by session id, evicting the oldest when the table is full. */
  const rememberSession = (id: string, server: McpServer): void => {
    // Do not evict an existing session to make room for a caller-chosen id. A client that sends
    // 64 random ids could otherwise push real clients out; a new id beyond the cap gets a server
    // for this request but no stored state.
    if (!mcpSessions.has(id) && mcpSessions.size >= MAX_SESSION_ENTRIES) return;
    mcpSessions.set(id, server);
  };
  // Fallback for clients that do not forward the session header. The spec-compliant path is the
  // header; a client that ignores it still needs initialize and tools/list to share state, so
  // this pool is keyed by remote address and user agent. Two clients on one host with the same
  // user agent remain a limitation, and naming the session header is the fix.
  const anonymousServers = new Map<string, McpServer>();
  const serverFor = (request: http.IncomingMessage): McpServer => {
    const header = request.headers["mcp-session-id"];
    const supplied = typeof header === "string" ? header.trim() : "";
    if (supplied !== "") {
      let existing = mcpSessions.get(supplied);
      if (existing === undefined) {
        existing = createMcp();
        rememberSession(supplied, existing);
      }
      return existing;
    }
    const onSocket = socketServers.get(request.socket);
    if (onSocket !== undefined) return onSocket;
    const userAgent =
      typeof request.headers["user-agent"] === "string" ? request.headers["user-agent"] : "";
    const fallbackKey = (request.socket.remoteAddress ?? "unknown") + "\0" + userAgent;
    let fallback = anonymousServers.get(fallbackKey);
    if (fallback === undefined) {
      fallback = createMcp();
      if (anonymousServers.size >= 64) {
        const oldest = anonymousServers.keys().next().value;
        if (oldest !== undefined) anonymousServers.delete(oldest);
      }
      anonymousServers.set(fallbackKey, fallback);
    }
    socketServers.set(request.socket, fallback);
    return fallback;
  };
  const newSessionId = (): string => crypto.randomBytes(12).toString("hex");
  /**
   * Legacy SSE sessions: `GET /sse` hands out an endpoint URL, `POST /messages` answers on the
   * open stream. It exists for clients that predate Streamable HTTP and cannot send headers —
   * which is also why the token may arrive as a query parameter here. That is a leak into logs,
   * so it is confined to this path and the docs say so.
   */
  const sseSessions = new Map<
    string,
    { write: (payload: string) => void; end: () => void; server: McpServer }
  >();
  const tokenAccepted = (request: http.IncomingMessage, url: URL): boolean => {
    if (token === null) return true;
    const header = request.headers.authorization ?? "";
    const match = /^Bearer\s+(.+)$/i.exec(header);
    if (match !== null && timingSafeEqual(match[1].trim(), token)) return true;
    const fromQuery = url.searchParams.get("token");
    return fromQuery !== null && timingSafeEqual(fromQuery, token);
  };
  const sessions = new Map<string, { count: number; resetAt: number }>();
  /**
   * Admission control for expensive calls.
   *
   * `runStdioServer` has `MAX_IN_FLIGHT`; HTTP had none, so 50 concurrent `snapshot_generate`
   * requests spawned 50 workers and could exhaust the process. The limit is shared by the
   * Streamable HTTP and legacy SSE paths because both dispatch to the same tool table.
   */
  let inFlight = 0;
  const acquireToolSlot = (): boolean => {
    if (inFlight >= MAX_IN_FLIGHT) return false;
    inFlight += 1;
    return true;
  };
  const releaseToolSlot = (): void => {
    if (inFlight > 0) inFlight -= 1;
  };
  const busyResponse = (id: unknown): JsonRpcResponse => ({
    jsonrpc: "2.0",
    id: typeof id === "string" || typeof id === "number" || id === null ? id : null,
    error: {
      code: -32001,
      message: "server busy: too many tool calls are already in flight",
    },
  });
  const isToolCall = (message: unknown): boolean =>
    message !== null &&
    typeof message === "object" &&
    (message as { method?: unknown }).method === "tools/call";

  /** Bound the rate table as addresses rotate; expired entries are dropped first. */
  const rememberRateWindow = (remote: string, now: number): void => {
    if (!sessions.has(remote) && sessions.size >= MAX_RATE_WINDOWS) {
      for (const [key, value] of sessions) if (value.resetAt <= now) sessions.delete(key);
      while (sessions.size >= MAX_RATE_WINDOWS) {
        const oldest = sessions.keys().next().value;
        if (oldest === undefined) break;
        sessions.delete(oldest);
      }
    }
    sessions.set(remote, { count: 1, resetAt: now + RATE_WINDOW_MS });
  };

  /**
   * Request counters for `/metrics`.
   *
   * Deliberately tiny: a total, a count per method, and the number of rate-limited or refused
   * requests. Nothing per-tool and nothing per-path — a metric label built from a URL is an
   * unbounded map and a way to leak what was asked for into a monitoring system.
   */
  const metrics = {
    requests: 0,
    byMethod: new Map<string, number>(),
    refused: 0,
    rateLimited: 0,
    started: Date.now(),
  };
  const noteRequest = (request: http.IncomingMessage): void => {
    metrics.requests += 1;
    const method = request.method ?? "UNKNOWN";
    metrics.byMethod.set(method, (metrics.byMethod.get(method) ?? 0) + 1);
  };

  /** True when this remote address has spent its window; the caller sends the 429. */
  const rateLimited = (request: http.IncomingMessage): boolean => {
    const remote = request.socket.remoteAddress ?? "unknown";
    const now = Date.now();
    const window = sessions.get(remote);
    if (window === undefined || window.resetAt <= now) {
      rememberRateWindow(remote, now);
      return false;
    }
    if (window.count >= RATE_LIMIT) return true;
    window.count += 1;
    return false;
  };

  const allowedOrigin = (origin: string | undefined): string | null => {
    if (origin === undefined) return null;
    if (isLoopbackOrigin(origin)) return origin;
    return extraOrigins.includes(origin) ? origin : null;
  };

  const httpServer = http.createServer((request, response) => {
    noteRequest(request);
    // One response per request. Oversized bodies arrive in several chunks; without this flag the
    // data handler answered 413 once per chunk and the second writeHead threw
    // ERR_HTTP_HEADERS_SENT, taking the server down.
    let responseSent = false;
    const send = (status: number, body: unknown, extra: Record<string, string> = {}): void => {
      if (responseSent) return;
      responseSent = true;
      const text = typeof body === "string" ? body : JSON.stringify(body);
      // One place counts refusals, so a future early return cannot forget to. A 4xx is a
      // refusal (the client's request was not dispatched); 429 has its own counter because the
      // question it answers is different, and a 5xx is our failure, not a refusal.
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
      cors["vary"] = "origin";
      cors["access-control-allow-headers"] = "authorization, content-type, mcp-protocol-version, mcp-session-id";
      cors["access-control-allow-methods"] = "POST, GET, OPTIONS";
      cors["access-control-max-age"] = "600";
    }

    if (request.method === "OPTIONS") {
      send(204, "", cors);
      return;
    }

    if (request.method === "GET" && request.url === "/healthz") {
      // A load balancer needs liveness and a human needs to know which build answered. Both
      // are cheap; uptime is seconds since this server started listening.
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
      // Metrics are not repository content, but on a network bind they still reveal request
      // volume and uptime. Keep the loopback convenience and require the same bearer token when
      // the server is reachable from another machine.
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
      // Prometheus text format, no dependency. The values are process-local: this server does not
      // aggregate across instances, and a monitoring system that needs that can sum them. No metric
      // carries a path or a tool name — a label built from a URL is an unbounded map, and it would
      // publish what was asked for to the monitoring system.
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

    const url = new URL(request.url ?? "/", "http://localhost");

    if (request.method === "GET" && url.pathname === "/sse") {
      if (!tokenAccepted(request, url)) {
        send(401, { error: "unauthorized" }, { ...cors, "www-authenticate": 'Bearer realm="codebase-snapshot"' });
        return;
      }
      if (rateLimited(request)) {
        metrics.rateLimited += 1;
        send(429, { error: "too many requests" }, { ...cors, "retry-after": "10" });
        return;
      }
      if (sseSessions.size >= MAX_SSE_SESSIONS) {
        send(503, { error: "too many open SSE sessions" }, { ...cors, "retry-after": "10" });
        return;
      }
      const id = crypto.randomBytes(12).toString("hex");
      response.writeHead(200, {
        ...cors,
        "content-type": "text/event-stream",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
        "x-accel-buffering": "no",
      });
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
      return;
    }

    if (request.method === "POST" && url.pathname === "/messages") {
      if (!tokenAccepted(request, url)) {
        send(401, { error: "unauthorized" }, { ...cors, "www-authenticate": 'Bearer realm="codebase-snapshot"' });
        return;
      }
      if (rateLimited(request)) {
        metrics.rateLimited += 1;
        send(429, { error: "too many requests" }, { ...cors, "retry-after": "10" });
        return;
      }
      const id = url.searchParams.get("sessionId") ?? "";
      const stream = sseSessions.get(id);
      if (stream === undefined) {
        send(404, { error: "unknown sessionId; open GET /sse first" });
        return;
      }
      const chunks: Buffer[] = [];
      let received = 0;
      let tooLarge = false;
      request.on("data", (chunk: Buffer) => {
        if (tooLarge) return;
        received += chunk.length;
        if (received > maxBody) {
          tooLarge = true;
          request.destroy();
          send(413, { error: "request body too large", limit: maxBody });
          return;
        }
        chunks.push(chunk);
      });
      request.on("end", () => {
        if (tooLarge) return;
        void (async () => {
          let message: unknown;
          try {
            message = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          } catch (error) {
            send(400, { jsonrpc: "2.0", id: null, error: { code: -32700, message: String(error) } });
            return;
          }
          const gated = isToolCall(message);
          if (gated && !acquireToolSlot()) {
            const answer = busyResponse((message as { id?: unknown }).id);
            stream.write("event: message\ndata: " + JSON.stringify(answer) + "\n\n");
            send(202, "", cors);
            return;
          }
          try {
            const answer = await stream.server.handle(message);
            if (answer !== null) stream.write("event: message\ndata: " + JSON.stringify(answer) + "\n\n");
          } finally {
            if (gated) releaseToolSlot();
          }
          send(202, "", cors);
        })().catch((error: unknown) => {
          log("mcp/http: " + (error as Error).message);
          try {
            send(500, { jsonrpc: "2.0", id: null, error: { code: -32603, message: "Internal error" } }, cors);
          } catch {
            // The stream is already gone.
          }
        });
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

    if (request.method !== "POST" || request.url !== "/mcp") {
      send(405, { error: "method not allowed" }, { ...cors, allow: "POST, OPTIONS" });
      return;
    }

    if (token !== null) {
      const header = request.headers.authorization ?? "";
      const match = /^Bearer\s+(.+)$/i.exec(header);
      if (match === null || !timingSafeEqual(match[1].trim(), token)) {
        send(401, { error: "unauthorized" }, { ...cors, "www-authenticate": 'Bearer realm="codebase-snapshot"' });
        return;
      }
    }

    if (rateLimited(request)) {
      metrics.rateLimited += 1;
      send(429, { error: "too many requests" }, { ...cors, "retry-after": "10" });
      return;
    }

    const activeServer = serverFor(request);
    const sessionHeader = request.headers["mcp-session-id"];
    let sessionId = typeof sessionHeader === "string" ? sessionHeader.trim() : "";
    let received = 0;
    let tooLarge = false;
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => {
      if (tooLarge) return;
      received += chunk.length;
      if (received > maxBody) {
        tooLarge = true;
        request.destroy();
        send(413, { error: "request body too large", limit: maxBody }, cors);
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      if (tooLarge) return;
      void (async () => {
        let message: unknown;
        try {
          message = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        } catch (error) {
          send(400, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error: " + (error as Error).message } }, cors);
          return;
        }
        const batch = Array.isArray(message) ? message : [message];
        if (batch.length > 100) {
          send(400, { error: "JSON-RPC batch is limited to 100 messages" }, cors);
          return;
        }
        // Assign a session on the first initialize and return it in the header. A client that
        // ignores the header still gets the per-socket server above, so state cannot leak.
        if (
          sessionId === "" &&
          !Array.isArray(message) &&
          (message as { method?: unknown }).method === "initialize"
        ) {
          sessionId = newSessionId();
          rememberSession(sessionId, activeServer);
        }
        const sessionHeaders = sessionId === "" ? cors : { ...cors, "mcp-session-id": sessionId };
        const answers: JsonRpcResponse[] = [];
        for (const item of batch) {
          const gated = isToolCall(item);
          if (gated && !acquireToolSlot()) {
            answers.push(busyResponse((item as { id?: unknown }).id));
            continue;
          }
          try {
            const answer = await activeServer.handle(item);
            if (answer !== null) answers.push(answer);
          } finally {
            if (gated) releaseToolSlot();
          }
        }
        if (answers.length === 0) {
          send(202, "", sessionHeaders);
          return;
        }
        send(200, Array.isArray(message) ? answers : answers[0], sessionHeaders);
      })().catch((error: unknown) => {
        log("mcp/http: " + (error as Error).message);
        send(500, { jsonrpc: "2.0", id: null, error: { code: -32603, message: "Internal error" } }, cors);
      });
    });
    request.on("error", () => {
      try {
        response.destroy();
      } catch {
        // The socket is already gone; there is nothing to report to.
      }
    });
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
    close: () =>
      new Promise<void>((resolve) => {
        // An open SSE stream keeps `close()` waiting forever, and a shutdown that never finishes
        // is indistinguishable from a server that ignored the signal.
        for (const [, session] of sseSessions) {
          try {
            session.end();
          } catch {
            // The client may already be gone.
          }
        }
        sseSessions.clear();
        httpServer.close(() => resolve());
        httpServer.closeAllConnections();
      }),
  };
}
