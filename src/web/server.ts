import * as http from "node:http";
import * as fs from "node:fs";
import * as path from "node:path";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { assertServerSafeConfig, loadConfigFileDetailed } from "../config.js";
import { createMcpHttpHandler } from "../mcp/http.js";
import { generateInWorker } from "../mcp/generate-worker.js";
import { analysisInWorker } from "../mcp/analysis-worker.js";
import { auditSnapshot } from "../auditor/health.js";
import { assertPublicHost, cloneRepository, makeCloneDirectory, parseRemoteSource } from "../remote/source.js";
import { describeManifestShapeProblem } from "../validator/validate.js";
import { readConfinedBytes, readConfinedText } from "../security/confine.js";
import type { Manifest } from "../types.js";
import { writeZip } from "./zip.js";
import { parseBearerToken } from "../auth.js";
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
 *    repository's own JSON settings and its executable config refused. A remote URL is refused
 *    with a message that says what is missing, rather
 *    than pretending to fetch.
 *  - Every response is bounded. The preview is the first 64 KiB of PROMPT.md, the file list is
 *    capped, the zip is built in memory and streamed once.
 */

/** Artifact keys to their written paths. Kept in step with the manifest's artifact record. */
const ARTIFACT_PATHS: Record<string, string> = {
  readme: "README.md",
  prompt: "PROMPT.md",
  navigation: "reports/navigation.md",
  projectTree: "reports/project-tree.md",
  audit: "reports/audit.md",
  diff: "reports/diff.md",
  log: "reports/log.md",
  tokenTree: "reports/tokens.md",
  selection: "reports/selection.md",
  fullJson: "full-codebase.json",
  fullMarkdown: "full-codebase.md",
  fullXml: "full-codebase.xml",
  sarif: "reports/audit.sarif",
};

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
/** Concurrent browser generations. Each one owns a worker and an output directory. */
const MAX_GENERATE_JOBS = 2;
/** Remote clones kept alive for the page's later reads; older ones are removed on eviction. */
const MAX_TEMPORARY_CLONES = 8;

function isLoopback(origin: string): boolean {
  try {
    const url = new URL(origin);
    if (url.protocol !== "http:" && url.protocol !== "https:") return false;
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
  // One mountable MCP transport, the same one `mcp --http` uses. `serve` used to carry a
  // per-socket copy with no session header, no CORS header for it, and no /sse or /messages.
  const mcp = createMcpHttpHandler({
    cwd: options.cwd,
    token,
    maxBodyBytes: 2 * 1024 * 1024,
    log,
  });
  const toolCount = mcp.toolCount;
  /** Bound the browser API's request rate; one slow scanner should not starve every other route. */
  const rateWindows = new Map<string, { count: number; resetAt: number }>();
  const rateLimited = (request: http.IncomingMessage): boolean => {
    const remote = request.socket.remoteAddress ?? "unknown";
    const now = Date.now();
    const window = rateWindows.get(remote);
    if (window === undefined || window.resetAt <= now) {
      if (!rateWindows.has(remote) && rateWindows.size >= 1024) {
        for (const [key, value] of rateWindows) if (value.resetAt <= now) rateWindows.delete(key);
      }
      rateWindows.set(remote, { count: 1, resetAt: now + 10_000 });
      return false;
    }
    if (window.count >= 120) return true;
    window.count += 1;
    return false;
  };
  /** Clones made by this process; removed when it closes, because the page can still be reading them. */
  const temporaryClones = new Set<string>();
  let generateJobs = 0;

  /**
   * Directories this server may read from: the working directory it was started for, plus the
   * clones it created itself.
   *
   * `/api/snapshot` and `/api/health` take a `path`, and `path.resolve` accepts an absolute one —
   * so before this check the bearer token doubled as an arbitrary-file-read primitive for anything
   * the process could read. The token is still the boundary for who may ask; this is the boundary
   * for what may be asked about.
   */
  const allowedRoots = [path.resolve(options.cwd)];
  /** Snapshot directory -> repository root, recorded when a generation succeeds. */
  const snapshotRepoRoots = new Map<string, string>();
  /**
   * Canonical path, or null when it does not exist.
   *
   * The lexical check this replaces was bypassed by a symlink inside the served directory: the
   * name resolved inside, the target did not, and /api/snapshot.zip shipped the target. A path
   * that cannot be resolved is not inside anything.
   */
  const canonical = (candidate: string): string | null => {
    try {
      return fs.realpathSync(candidate);
    } catch {
      return null;
    }
  };
  const fold = (value: string): string =>
    process.platform === "win32" || process.platform === "darwin" ? value.toLowerCase() : value;
  const inside = (resolved: string): boolean =>
    allowedRoots.some((root) => {
      const canonicalRoot = canonical(root);
      if (canonicalRoot === null) return false;
      const relative = path.relative(fold(canonicalRoot), fold(resolved));
      return (
        relative === "" ||
        (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
      );
    });
  const insideAllowedRoots = (candidate: string): boolean => {
    const resolved = canonical(candidate);
    return resolved === null ? false : inside(resolved);
  };
  /** Lexical containment: used to answer 403 before 404 without following a link. */
  const lexicallyInside = (candidate: string): boolean => {
    const resolved = fold(path.resolve(candidate));
    return allowedRoots.some((root) => {
      const resolvedRoot = fold(path.resolve(root));
      return resolved === resolvedRoot || resolved.startsWith(resolvedRoot + path.sep);
    });
  };
  /** The same check for a directory this request is about to create. */
  const insideAllowedRootsForWrite = (candidate: string): boolean => {
    let existing = path.resolve(candidate);
    const tail: string[] = [];
    while (!fs.existsSync(existing)) {
      tail.unshift(path.basename(existing));
      const parent = path.dirname(existing);
      if (parent === existing) break;
      existing = parent;
    }
    const resolved = canonical(existing);
    if (resolved === null) return false;
    return inside(tail.length === 0 ? resolved : path.join(resolved, ...tail));
  };

  const authorized = (request: http.IncomingMessage): boolean => {
    if (token === null) return true;
    const presented = parseBearerToken(request.headers.authorization);
    if (presented === null) return false;
    const given = Buffer.from(presented, "utf8");
    const expected = Buffer.from(token, "utf8");
    return given.length === expected.length && timingSafeEqual(given, expected);
  };

  const server = http.createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    // The shared MCP handler owns /mcp, /sse and /messages, including their auth, CORS and session
    // headers. Mount it before the browser API's token gate so an EventSource-style client can
    // authenticate /sse with ?token= exactly as it can on `mcp --http`.
    if (url.pathname === "/mcp" || url.pathname === "/sse" || url.pathname === "/messages") {
      if (mcp.handle(request, response)) return;
    }
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
    // One response per request. A body split across TCP chunks used to call send(413) once per
    // chunk after the limit, and the second writeHead threw ERR_HTTP_HEADERS_SENT and killed the
    // server. The flag makes the first answer final.
    let responseSent = false;
    const send = (status: number, body: unknown, extra: Record<string, string> = {}): void => {
      if (responseSent) return;
      responseSent = true;
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
    if (rateLimited(request)) {
      send(429, { error: "too many requests" }, { "retry-after": "10" });
      return;
    }
    if (request.method === "GET" && request.url === "/healthz") {
      send(200, { ok: true, name: "codebase-snapshot", tools: toolCount });
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

    if (request.method === "POST" && request.url === "/api/generate") {
      let received = 0;
      let tooLarge = false;
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => {
        if (tooLarge) return;
        received += chunk.length;
        if (received > MAX_BODY) {
          tooLarge = true;
          request.destroy();
          send(413, { error: "request body too large" });
          return;
        }
        chunks.push(chunk);
      });
      request.on("end", () => {
        if (tooLarge) return;
        if (generateJobs >= MAX_GENERATE_JOBS) {
          send(429, { error: "too many generations in flight; wait for one to finish" });
          return;
        }
        generateJobs += 1;
        void (async () => {
          try {
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
          let provenance: Manifest["source"] | undefined;
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
              allowedRoots.push(clone.directory);
              while (temporaryClones.size > MAX_TEMPORARY_CLONES) {
                const oldest = temporaryClones.values().next().value;
                if (oldest === undefined) break;
                temporaryClones.delete(oldest);
                // The evicted tree is no longer an allowed root; leaving it in this array let a
                // long-running server accumulate stale read capabilities for directories it had
                // already deleted.
                const rootIndex = allowedRoots.indexOf(oldest);
                if (rootIndex >= 0) allowedRoots.splice(rootIndex, 1);
                for (const [snapshot, repoRoot] of snapshotRepoRoots) {
                  if (repoRoot === oldest) snapshotRepoRoots.delete(snapshot);
                }
                try {
                  fs.rmSync(oldest, { recursive: true, force: true });
                } catch {
                  // A clone that cannot be removed is still only this server's temporary tree.
                }
              }
              target = clone.directory;
              provenance = clone.provenance;
            } catch (error) {
              send(400, { error: "Remote fetch failed: " + (error as Error).message });
              return;
            }
          } else {
            target = path.resolve(options.cwd, source);
            // The bearer token is not a filesystem capability. /api/generate accepted an
            // absolute path anywhere on the host and scanned it; the GET endpoints had the
            // check, this one did not.
            if (!insideAllowedRoots(target)) {
              send(403, { error: "outside the served directory: " + target });
              return;
            }
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
          // The page used to generate on built-in defaults: a repository with a snapshot.config.json
          // produced a different snapshot from the browser than from the CLI, and an executable
          // config was silently ignored rather than refused — the one thing the MCP server and the
          // security review both promise this surface does not do.
          // A remote clone's config is repository content, not a decision about this host. The CLI
          // sets noConfig for --remote; serve loaded it, so a hostile package.json-adjacent config
          // could supply a catastrophic custom secret regex and freeze the server.
          const loaded = isRemote
            ? { config: null, file: null, errors: [] as string[] }
            : await loadConfigFileDetailed(target, { allowExecutableConfig: false });
          if (loaded.errors.length > 0) {
            send(400, { error: loaded.errors.join("; ") });
            return;
          }
          try {
            assertServerSafeConfig(loaded.config, loaded.file ?? target);
          } catch (error) {
            send(400, { error: error instanceof Error ? error.message : String(error) });
            return;
          }
          // A remote repository's config is data from the repository, not a decision about this
          // host. Its outDir/tmpDir were passed straight through, so a public repo could write
          // outside the clone; hooks are stripped for the same reason. A local path keeps its
          // config, but the resulting output directory must still be inside the served roots.
          const runConfig = isRemote
            ? {
                outDir: "snapshot",
                tmpDir: "snapshot.tmp",
                hooks: {},
              }
            : (loaded.config ?? {});
          const configuredOutDir =
            typeof runConfig.outDir === "string" && runConfig.outDir.trim() !== ""
              ? runConfig.outDir
              : "snapshot";
          const snapshotDir = path.resolve(target, configuredOutDir);
          if (!insideAllowedRootsForWrite(snapshotDir)) {
            send(403, { error: "the configured outDir resolves outside the served directory" });
            return;
          }
          // The staging root is written to as well. Checking only outDir left a host path that
          // a local config could name; a remote clone already forces both values.
          const configuredTmpDir =
            typeof runConfig.tmpDir === "string" && runConfig.tmpDir.trim() !== ""
              ? runConfig.tmpDir
              : "snapshot.tmp";
          const stagingDir = path.resolve(target, configuredTmpDir);
          if (!insideAllowedRootsForWrite(stagingDir)) {
            send(403, { error: "the configured tmpDir resolves outside the served directory" });
            return;
          }
          const started = Date.now();
          try {
            // Generate off the request thread: a 3,000-file scan used to freeze every other
            // browser request and the MCP endpoint for the duration of the scan.
            const generated = await generateInWorker(
              target,
              { cwd: target },
              {
                config: runConfig,
                configLoaded: true,
                ...(provenance === undefined ? {} : { source: provenance }),
                ...(mode === "slice" && question.length >= 3
                  ? { narrow: { slice: { question } } }
                  : {}),
                ...(mode === "budget" && budgetTokens !== undefined
                  ? { narrow: { budgetTokens } }
                  : {}),
              }
            );
            if (!generated.ok) {
              send(500, { error: generated.message });
              return;
            }
            const manifestRead = readConfinedText(snapshotDir, "manifest.json");
            if (!manifestRead.ok) {
              send(500, { error: "the generate worker did not write manifest.json" });
              return;
            }
            const manifest = JSON.parse(manifestRead.text) as Manifest;
            const shape = describeManifestShapeProblem(manifest);
            if (shape !== null) {
              send(500, { error: "the generated manifest is not a snapshot manifest: " + shape });
              return;
            }
            const seconds = ((Date.now() - started) / 1000).toFixed(2);
            snapshotRepoRoots.set(
              canonical(snapshotDir) ?? path.resolve(snapshotDir),
              path.resolve(target)
            );
            // The audit runs on what was just written, so the page shows whether the artifact is
            // safe to hand over rather than only how big it is.
            const audit = await analysisInWorker({
              task: "health",
              options: { snapshotDir, repoDir: target },
            });
            if (!audit.ok) {
              send(500, { error: audit.message });
              return;
            }
            const health = audit.result as { score: number; counts: { warn: number }; checks: Array<{ status: string; id: string }> };
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
          } finally {
            generateJobs -= 1;
          }
        })().catch((error: unknown) => {
          log("serve: " + (error as Error).message);
          try {
            send(500, { error: "internal error" });
          } catch {
            // The response is already gone.
          }
        });
      });
      return;
    }

    if (request.method === "GET" && request.url?.startsWith("/api/health?") === true) {
      const target = path.resolve(options.cwd, url.searchParams.get("path") ?? options.cwd);
      if (!lexicallyInside(target)) {
        send(403, { error: "outside the served directory: " + target });
        return;
      }
      if (!fs.existsSync(target)) {
        send(404, { error: "no snapshot directory at " + target });
        return;
      }
      if (!insideAllowedRoots(target)) {
        send(403, { error: "outside the served directory: " + target });
        return;
      }
      // A nested outDir (artifacts/snapshot) is not one level below the repository. Prefer the
      // source root recorded by the successful generation; fall back to the served directory
      // rather than inventing a parent from the snapshot depth.
      const repoDir =
        snapshotRepoRoots.get(canonical(target) ?? path.resolve(target)) ?? path.resolve(options.cwd);
      if (!insideAllowedRoots(repoDir)) {
        send(403, { error: "the repository root for this snapshot is outside the served directory" });
        return;
      }
      if (!fs.existsSync(path.join(target, "manifest.json"))) {
        send(404, { error: "no manifest.json under " + target });
        return;
      }
      void analysisInWorker({
        task: "health",
        options: { snapshotDir: target, repoDir },
      })
        .then((analysis) => {
          if (!analysis.ok) {
            send(500, { error: analysis.message });
            return;
          }
          const report = analysis.result as ReturnType<typeof auditSnapshot>;
          send(200, { score: report.score, counts: report.counts, checks: report.checks });
        })
        .catch((error: unknown) => {
          send(500, { error: error instanceof Error ? error.message : String(error) });
        });
      return;
    }

    if (request.method === "GET" && (request.url?.startsWith("/api/snapshot?") === true || request.url === "/api/snapshot")) {
      const target = path.resolve(options.cwd, url.searchParams.get("path") ?? options.cwd);
      if (!lexicallyInside(target)) {
        send(403, { error: "outside the served directory: " + target });
        return;
      }
      if (!fs.existsSync(target)) {
        send(404, { error: "no manifest.json under " + target });
        return;
      }
      if (!insideAllowedRoots(target)) {
        send(403, { error: "outside the served directory: " + target });
        return;
      }
      const manifestRead = readConfinedText(target, "manifest.json");
      if (!manifestRead.ok) {
        if (manifestRead.reason === "outside") {
          send(403, { error: "manifest.json resolves outside the snapshot directory" });
        } else {
          send(404, { error: "no readable manifest.json under " + target });
        }
        return;
      }
      let manifest: { fingerprint?: string; generatedAt?: string; counts?: { totalFiles?: number; skippedCount?: number }; totals?: { estimatedTokens?: number }; files?: Array<{ relativePath: string; part: string }> };
      try {
        manifest = JSON.parse(manifestRead.text);
      } catch {
        send(404, { error: "no manifest.json under " + target });
        return;
      }
      const shapeProblem = describeManifestShapeProblem(manifest);
      if (shapeProblem !== null) {
        send(400, { error: "manifest.json is not a snapshot manifest: " + shapeProblem });
        return;
      }
      const promptRead = readConfinedText(target, "PROMPT.md");
      const prompt = promptRead.ok
        ? promptRead.text.slice(0, MAX_PREVIEW)
        : "(this snapshot has no readable PROMPT.md)";
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
      if (!lexicallyInside(target)) {
        send(403, { error: "outside the served directory: " + target });
        return;
      }
      if (!fs.existsSync(target)) {
        send(404, { error: "not a snapshot directory: " + target });
        return;
      }
      if (!insideAllowedRoots(target)) {
        send(403, { error: "outside the served directory: " + target });
        return;
      }
      const manifestRead = readConfinedText(target, "manifest.json");
      if (!manifestRead.ok) {
        send(manifestRead.reason === "outside" ? 403 : 404, {
          error: "no readable manifest.json under " + target,
        });
        return;
      }
      let zipManifest: Manifest;
      try {
        zipManifest = JSON.parse(manifestRead.text) as Manifest;
      } catch {
        send(404, { error: "manifest.json is not valid JSON" });
        return;
      }
      const zipProblem = describeManifestShapeProblem(zipManifest);
      if (zipProblem !== null) {
        send(400, { error: "manifest.json is not a snapshot manifest: " + zipProblem });
        return;
      }
      // Zip the files the manifest declares, not every regular file in the directory. Existence of
      // a manifest (or a marker) is not evidence that its neighbours are snapshot content: a PWA
      // manifest.json at the repository root used to turn this endpoint into a full unredacted
      // repository archive, including .env and .git.
      const wanted = new Set<string>(["manifest.json"]);
      for (const part of zipManifest.parts) {
        if (typeof part.filename === "string" && part.filename.length > 0) {
          wanted.add("parts/" + part.filename);
        }
      }
      const artifactRecord = (zipManifest.artifacts ?? {}) as Record<string, unknown>;
      for (const [key, relative] of Object.entries(ARTIFACT_PATHS)) {
        if (artifactRecord[key] !== undefined && artifactRecord[key] !== null) wanted.add(relative);
      }
      wanted.add("signature.json");
      const entries: Array<{ name: string; content: Buffer; mtime: Date }> = [];
      for (const relative of wanted) {
        const read = readConfinedBytes(target, relative, 256 * 1024 * 1024);
        if (!read.ok) continue;
        entries.push({ name: relative, content: read.bytes, mtime: read.stats.mtime });
      }
      if (entries.length === 0) {
        send(404, { error: "the snapshot manifest declares no readable files" });
        return;
      }
      try {
        const zip = writeZip({ entries });
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
    close: async () => {
      await mcp.close();
      for (const directory of temporaryClones) {
        try {
          fs.rmSync(directory, { recursive: true, force: true });
        } catch {
          // A leftover temp tree is better than a crash on shutdown.
        }
      }
      // Keep-alive connections hold close() open indefinitely; the MCP transport already does
      // this, and serve needs the same shutdown behavior.
      server.closeAllConnections();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    },
  };
}
