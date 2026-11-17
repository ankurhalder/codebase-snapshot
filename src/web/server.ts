import * as http from "node:http";
import * as fs from "node:fs";
import * as path from "node:path";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { generateSnapshot } from "../index.js";
import { createServer } from "../mcp/run.js";
import { auditSnapshot } from "../auditor/health.js";
import { assertPublicHost, cloneRepository, makeCloneDirectory, parseRemoteSource } from "../remote/source.js";
import type { Manifest } from "../types.js";
import { writeZip } from "./zip.js";
import { SERVE_PAGE } from "./ui.js";

/**
 * `snapshot serve`: the browser face of the tool.
 *
 * One process serves the page, the API it calls, and the MCP endpoint, so a browser client and an
 * agent talk to the same snapshot. Three rules shape it:
 *
 *  - Loopback by default, a bearer token always (generated on first run, printed once). The page
 *    asks for the token and keeps it in localStorage, so serving / can never leak the credential.
 *  - The API only ever writes where a person pointed it: a local path that exists, with the
 *    default settings. A remote URL is refused with a message that says what is missing, rather
 *    than pretending to fetch.
 *  - Every response is bounded. The preview is the first 64 KiB of PROMPT.md, the file list is
 *    capped, the zip is built in memory and streamed once.
 */

export interface ServeOptions {
  cwd: string;
  host?: string;
  port?: number;
  token?: string | null;
  /** Allow private addresses and file: URLs for remote sources (tests and air-gapped mirrors). */
  allowPrivate?: boolean;
  log?: (line: string) => void;
}

export interface ServeHandle {
  url: string;
  port: number;
  host: string;
  token: string | null;
  close(): Promise<void>;
}

const DEFAULT_PORT = 4788;
const MAX_BODY = 64 * 1024;
const MAX_PREVIEW = 64 * 1024;

function isLoopback(origin: string): boolean {
  try {
    const url = new URL(origin);
    return ["localhost", "127.0.0.1", "[::1]", "::1"].includes(url.hostname);
  } catch {
    return false;
  }
}

export async function startWebServer(options: ServeOptions): Promise<ServeHandle> {
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? DEFAULT_PORT;
  const log = options.log ?? ((line: string) => process.stderr.write(line + "\n"));
  const token = options.token === undefined ? randomBytes(18).toString("base64url") : options.token;
  if (token === null && !["127.0.0.1", "localhost", "::1"].includes(host)) {
    throw new Error("Refusing to serve " + host + " without a token.");
  }
  const mcp = createServer({ cwd: options.cwd, log });
  /** Clones made by this process; removed when it closes, because the page can still be reading them. */
  const temporaryClones = new Set<string>();

  const authorized = (request: http.IncomingMessage): boolean => {
    if (token === null) return true;
    const header = request.headers.authorization ?? "";
    const match = /^Bearer\s+(.+)$/i.exec(header);
    if (match === null) return false;
    const given = Buffer.from(match[1].trim(), "utf8");
    const expected = Buffer.from(token, "utf8");
    return given.length === expected.length && timingSafeEqual(given, expected);
  };

  const server = http.createServer((request, response) => {
    const origin = typeof request.headers.origin === "string" ? request.headers.origin : undefined;
    const cors: Record<string, string> = {};
    if (origin !== undefined) {
      if (!isLoopback(origin)) {
        response.writeHead(403, { "content-type": "text/plain" });
        response.end("origin not allowed");
        return;
      }
      cors["access-control-allow-origin"] = origin;
      cors["vary"] = "origin";
      cors["access-control-allow-headers"] = "authorization, content-type";
      cors["access-control-allow-methods"] = "GET, POST, OPTIONS";
    }
    const send = (status: number, body: unknown, extra: Record<string, string> = {}): void => {
      const text = typeof body === "string" ? body : JSON.stringify(body);
      response.writeHead(status, {
        ...cors,
        "content-type": typeof body === "string" ? "text/plain; charset=utf-8" : "application/json",
        "content-length": String(Buffer.byteLength(text, "utf8")),
        "x-content-type-options": "nosniff",
        ...extra,
      });
      response.end(text);
    };

    if (request.method === "OPTIONS") {
      response.writeHead(204, cors);
      response.end();
      return;
    }
    if (request.method === "GET" && request.url === "/healthz") {
      send(200, { ok: true, name: "codebase-snapshot", tools: 12 });
      return;
    }
    if (request.method === "GET" && (request.url === "/" || request.url === "/index.html")) {
      send(200, SERVE_PAGE, { "content-type": "text/html; charset=utf-8" });
      return;
    }

    if (!authorized(request)) {
      send(401, { error: "unauthorized" }, { "www-authenticate": 'Bearer realm="codebase-snapshot"' });
      return;
    }

    const url = new URL(request.url ?? "/", "http://localhost");
    if (request.method === "POST" && (request.url === "/mcp" || (request.url ?? "").startsWith("/mcp?"))) {
      let received = 0;
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => {
        received += chunk.length;
        if (received > 2 * 1024 * 1024) {
          request.destroy();
          send(413, { error: "request body too large" });
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
            send(400, { jsonrpc: "2.0", id: null, error: { code: -32700, message: String(error) } });
            return;
          }
          const batch = Array.isArray(message) ? message : [message];
          const answers = [];
          for (const item of batch) {
            const answer = await mcp.handle(item);
            if (answer !== null) answers.push(answer);
          }
          if (answers.length === 0) send(202, "");
          else send(200, Array.isArray(message) ? answers : answers[0]);
        })();
      });
      return;
    }

    if (request.method === "POST" && request.url === "/api/generate") {
      let received = 0;
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => {
        received += chunk.length;
        if (received > MAX_BODY) {
          request.destroy();
          send(413, { error: "request body too large" });
          return;
        }
        chunks.push(chunk);
      });
      request.on("end", () => {
        void (async () => {
          let source = "";
          let mode: "full" | "slice" | "budget" = "full";
          let question = "";
          let budgetTokens: number | undefined;
          try {
            const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
              source?: unknown;
              mode?: unknown;
              question?: unknown;
              budgetTokens?: unknown;
            };
            source = typeof body.source === "string" ? body.source.trim() : "";
            mode = body.mode === "slice" || body.mode === "budget" ? body.mode : "full";
            question = typeof body.question === "string" ? body.question.trim() : "";
            budgetTokens = typeof body.budgetTokens === "number" ? body.budgetTokens : undefined;
          } catch {
            send(400, { error: "body must be JSON with a source string" });
            return;
          }
          if (source === "") {
            send(400, { error: "source is empty" });
            return;
          }
          if (mode === "slice" && question.length < 3) {
            send(400, { error: "slice mode needs a question of at least 3 characters" });
            return;
          }
          if (mode === "budget" && (budgetTokens === undefined || budgetTokens < 500)) {
            send(400, { error: "budget mode needs budgetTokens of at least 500" });
            return;
          }
          const isRemote = /^(https?|file):\/\//i.test(source);
          let target: string;
          let provenance: Manifest["source"];
          if (isRemote) {
            const parsed = parseRemoteSource(source, { allowPrivate: options.allowPrivate === true });
            if (!parsed.ok) {
              send(400, { error: parsed.message });
              return;
            }
            try {
              if (parsed.source.kind === "https") {
                await assertPublicHost(parsed.source.host, options.allowPrivate === true);
              }
              const clone = await cloneRepository(parsed.source, {
                dest: makeCloneDirectory(),
                token: process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN ?? null,
                allowPrivate: options.allowPrivate === true,
                log,
              });
              temporaryClones.add(clone.directory);
              target = clone.directory;
              provenance = clone.provenance;
            } catch (error) {
              send(400, { error: "Remote fetch failed: " + (error as Error).message });
              return;
            }
          } else {
            target = path.resolve(options.cwd, source);
          }
          let stat: fs.Stats;
          try {
            stat = fs.statSync(target);
          } catch {
            send(404, { error: "no such path: " + target });
            return;
          }
          if (!stat.isDirectory()) {
            send(400, { error: "not a directory: " + target });
            return;
          }
          const started = Date.now();
          try {
            const manifest = generateSnapshot({ cwd: target }, {
              ...(provenance === undefined ? {} : { source: provenance }),
              ...(mode === "slice" ? { slice: { question } } : {}),
              ...(mode === "budget" && budgetTokens !== undefined ? { budgetTokens } : {}),
            });
            const seconds = ((Date.now() - started) / 1000).toFixed(2);
            const snapshotDir = path.join(target, "snapshot");
            // The audit runs on what was just written, so the page shows whether the artifact is
            // safe to hand over rather than only how big it is.
            const health = auditSnapshot({ snapshotDir, repoDir: target });
            send(200, {
              path: snapshotDir,
              health: {
                score: health.score,
                failed: health.checks.filter((check) => check.status === "fail").map((check) => check.id),
                warnings: health.counts.warn,
              },
              files: manifest.counts.totalFiles,
              parts: manifest.counts.partsCount,
              tokens: manifest.totals.estimatedTokens ?? 0,
              fingerprint: manifest.fingerprint,
              mode,
              ...(manifest.slice === undefined ? {} : { dropped: manifest.slice.dropped }),
              ...(manifest.budget === undefined ? {} : { dropped: manifest.budget.dropped }),
              seconds,
              warning: manifest.warnings.length > 0 ? manifest.warnings[0] : null,
            });
          } catch (error) {
            send(500, { error: (error as Error).message });
          }
        })();
      });
      return;
    }

    if (request.method === "GET" && request.url?.startsWith("/api/health?") === true) {
      const target = path.resolve(options.cwd, url.searchParams.get("path") ?? options.cwd);
      if (!fs.existsSync(path.join(target, "manifest.json"))) {
        send(404, { error: "no manifest.json under " + target });
        return;
      }
      const report = auditSnapshot({ snapshotDir: target, repoDir: path.dirname(target) });
      send(200, { score: report.score, counts: report.counts, checks: report.checks });
      return;
    }

    if (request.method === "GET" && (request.url?.startsWith("/api/snapshot?") === true || request.url === "/api/snapshot")) {
      const target = path.resolve(options.cwd, url.searchParams.get("path") ?? options.cwd);
      const manifestFile = path.join(target, "manifest.json");
      let manifest: { fingerprint?: string; generatedAt?: string; counts?: { totalFiles?: number; skippedCount?: number }; totals?: { estimatedTokens?: number }; files?: Array<{ relativePath: string; part: string }> };
      try {
        manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
      } catch {
        send(404, { error: "no manifest.json under " + target });
        return;
      }
      let prompt = "";
      try {
        prompt = fs.readFileSync(path.join(target, "PROMPT.md"), "utf8").slice(0, MAX_PREVIEW);
      } catch {
        prompt = "(this snapshot has no PROMPT.md)";
      }
      send(200, {
        fingerprint: manifest.fingerprint ?? "",
        generatedAt: manifest.generatedAt ?? "",
        included: manifest.counts?.totalFiles ?? 0,
        skipped: manifest.counts?.skippedCount ?? 0,
        tokens: manifest.totals?.estimatedTokens ?? 0,
        files: (manifest.files ?? []).map((file) => ({ path: file.relativePath, part: file.part })),
        prompt,
      });
      return;
    }

    if (request.method === "GET" && request.url?.startsWith("/api/snapshot.zip") === true) {
      const target = path.resolve(options.cwd, url.searchParams.get("path") ?? options.cwd);
      if (!fs.existsSync(path.join(target, "manifest.json")) && !fs.existsSync(path.join(target, ".codebase-snapshot"))) {
        send(404, { error: "not a snapshot directory: " + target });
        return;
      }
      try {
        const zip = writeZip({ directory: target });
        response.writeHead(200, {
          ...cors,
          "content-type": "application/zip",
          "content-length": String(zip.length),
          "content-disposition": 'attachment; filename="snapshot.zip"',
        });
        response.end(zip);
      } catch (error) {
        send(500, { error: (error as Error).message });
      }
      return;
    }

    send(404, { error: "not found" });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  const address = server.address();
  const actualPort = typeof address === "object" && address !== null ? address.port : port;
  const display = host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host;
  log("serve: http://" + display + ":" + actualPort + "/");

  return {
    url: "http://" + display + ":" + actualPort + "/",
    port: actualPort,
    host,
    token,
    close: () =>
      new Promise<void>((resolve) => {
        for (const directory of temporaryClones) {
          try {
            fs.rmSync(directory, { recursive: true, force: true });
          } catch {
            // A leftover temp tree is better than a crash on shutdown.
          }
        }
        server.close(() => resolve());
      }),
  };
}
