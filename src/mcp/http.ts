import * as http from "node:http";
import * as crypto from "node:crypto";
import { createServer } from "./run.js";
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

  const server: McpServer = createServer({ cwd: options.cwd, log });
  const sessions = new Map<string, { count: number; resetAt: number }>();

  const allowedOrigin = (origin: string | undefined): string | null => {
    if (origin === undefined) return null;
    if (isLoopbackOrigin(origin)) return origin;
    return extraOrigins.includes(origin) ? origin : null;
  };

  const httpServer = http.createServer((request, response) => {
    const send = (status: number, body: unknown, extra: Record<string, string> = {}): void => {
      const text = typeof body === "string" ? body : JSON.stringify(body);
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
      send(200, { ok: true, name: "codebase-snapshot", tools: 12 }, cors);
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

    const remote = request.socket.remoteAddress ?? "unknown";
    const now = Date.now();
    const window = sessions.get(remote);
    if (window === undefined || window.resetAt <= now) sessions.set(remote, { count: 1, resetAt: now + RATE_WINDOW_MS });
    else if (window.count >= RATE_LIMIT) {
      send(429, { error: "too many requests" }, { ...cors, "retry-after": "10" });
      return;
    } else window.count += 1;

    let received = 0;
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => {
      received += chunk.length;
      if (received > maxBody) {
        request.destroy();
        send(413, { error: "request body too large", limit: maxBody }, cors);
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      void (async () => {
        let message: unknown;
        try {
          message = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        } catch (error) {
          send(400, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error: " + (error as Error).message } }, cors);
          return;
        }
        const answers: JsonRpcResponse[] = [];
        const batch = Array.isArray(message) ? message : [message];
        for (const item of batch) {
          const answer = await server.handle(item);
          if (answer !== null) answers.push(answer);
        }
        if (answers.length === 0) {
          send(202, "", cors);
          return;
        }
        send(200, Array.isArray(message) ? answers : answers[0], cors);
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
        httpServer.close(() => resolve());
      }),
  };
}
