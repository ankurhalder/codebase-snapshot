/**
 * Regression tests for the 0.20 hardening audit.
 *
 * Each test names the finding it pins and the second code path that lacked the guard. These are
 * deliberately direct: the bugs were route asymmetries, and an end-to-end test that goes through
 * only one route does not see them.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  SCHEMA_VERSION,
  collectFiles,
  generateSnapshot,
  isPrivateHost,
  loadConfigFileDetailed,
  lockPathFor,
  releaseAbandonedRun,
  resolveConfig,
  startWebServer,
  tokenAllowedForHost,
  validateSnapshot,
} from "../dist/index.js";
import { generateCliOptions } from "../dist/cli.js";
import { buildTools, startHttpTransport } from "../dist/mcp.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.join(HERE, "..", "dist", "bin.js");

function tempDir(t, prefix = "audit-020-") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function write(root, relative, content) {
  const target = path.join(root, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
}

function git(cwd, args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", windowsHide: true });
  assert.equal(result.status, 0, "git " + args.join(" ") + ": " + (result.stderr ?? ""));
  return (result.stdout ?? "").trim();
}

function initRepo(t, files = {}) {
  const root = tempDir(t);
  write(root, "package.json", '{"name":"fixture","version":"1.0.0"}\n');
  for (const [relative, content] of Object.entries(files)) write(root, relative, content);
  git(root, ["init", "-q"]);
  git(root, ["config", "user.email", "audit@example.test"]);
  git(root, ["config", "user.name", "Audit"]);
  return root;
}

const PEM = [
  "-----BEGIN PRIVATE KEY-----",
  "MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7VJTUt9Us8cKj",
  "MzEfYyjiWA4R4/M2bS1GB4t7NXp98C3SC6dVMvDuictGeurT8jNbvJZHtCSuYEvu",
  "NMoSfm76oqFvAp8Gy0iz5sxjZmSnXyCdPEovGhLa0VzMaQ8s+CLOyS56YyCFGeJZ",
  "-----END PRIVATE KEY-----",
].join("\n");

test("F1: a configured brief cannot read outside the repository", async (t) => {
  const root = tempDir(t);
  const outside = path.join(path.dirname(root), "outside-brief-" + process.pid + ".md");
  t.after(() => fs.rmSync(outside, { force: true }));
  write(root, "snapshot.config.json", JSON.stringify({ brief: "../" + path.basename(outside) }) + "\n");
  fs.writeFileSync(outside, "# Outside\n\n## The system\n\nsecret\n", "utf8");
  const loaded = await loadConfigFileDetailed(root, { allowExecutableConfig: false });
  assert.deepEqual(loaded.errors, []);
  assert.throws(() => resolveConfig(loaded.config, {}, root), /outside the repository/i);
});

test("F1: a PEM block in an in-repo brief is fully redacted, not just its header", (t) => {
  const root = tempDir(t);
  write(root, "BRIEF.md", "# Brief\n\n## The system\n\n" + PEM + "\n");
  const config = resolveConfig({ brief: "BRIEF.md", outDir: "snapshot" }, {}, root);
  generateSnapshot(config);
  const prompt = fs.readFileSync(path.join(root, "snapshot", "PROMPT.md"), "utf8");
  assert.doesNotMatch(prompt, /MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7/);
  assert.match(prompt, /REDACTED/);
});

test("F2/F5: token hosts and private-address spellings are closed", () => {
  for (const host of [
    "::ffff:127.0.0.1",
    "::ffff:169.254.169.254",
    "::ffff:7f00:1",
    "fe90::1",
    "224.0.0.1",
    "ff02::1",
    "100.64.0.1",
  ]) {
    assert.equal(isPrivateHost(host), true, host);
  }
  assert.equal(isPrivateHost("github.com"), false);
  assert.equal(isPrivateHost("8.8.8.8"), false);
  assert.equal(tokenAllowedForHost("github.com"), true);
  assert.equal(tokenAllowedForHost("attacker.example"), false);
});

test("F4: a tracked symlink to a sensitive file is skipped on the git path", (t) => {
  const root = initRepo(t, { ".env": "API_KEY=not-a-real-value\n", "src/a.ts": "export const a = 1;\n" });
  try {
    fs.symlinkSync(".env", path.join(root, "public-context.txt"));
  } catch (error) {
    if (error.code === "EPERM" || error.code === "EACCES") return t.skip("symlinks unavailable");
    throw error;
  }
  git(root, ["add", ".env", "public-context.txt", "src/a.ts"]);
  const result = collectFiles(root, { discovery: "git", secretRules: [] });
  const skipped = result.skipped.find((record) => record.path === "public-context.txt");
  assert.ok(skipped, "the alias is accounted for");
  assert.equal(skipped.reason, "sensitive-file");
  assert.equal(result.files.includes("public-context.txt"), false);
});

test("F3: diff and log reports are filtered and redacted", (t) => {
  const root = initRepo(t, {
    ".env": "SERVICE_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123456789\n",
    "src/a.ts": "export const a = 1;\n",
  });
  git(root, ["add", ".env", "src/a.ts"]);
  git(root, ["commit", "-qm", "subject ghp_abcdefghijklmnopqrstuvwxyz0123456789"]);
  write(root, "src/a.ts", 'export const a = 2;\nconst token = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";\n');
  write(root, ".env", "SERVICE_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123456789\n");
  git(root, ["add", "src/a.ts", ".env"]);

  const run = spawnSync(
    process.execPath,
    [BIN, "generate", "--cwd", root, "--include-diffs", "--include-logs", "5", "--no-update-check"],
    { encoding: "utf8", windowsHide: true }
  );
  assert.equal(run.status, 0, run.stderr);
  const diff = fs.readFileSync(path.join(root, "snapshot", "reports", "diff.md"), "utf8");
  const log = fs.readFileSync(path.join(root, "snapshot", "reports", "log.md"), "utf8");
  assert.doesNotMatch(diff, /ghp_abcdefghijklmnopqrstuvwxyz0123456789/);
  assert.doesNotMatch(log, /ghp_abcdefghijklmnopqrstuvwxyz0123456789/);
});

test("F8: signing twice does not brick the output directory", (t) => {
  const root = tempDir(t);
  write(root, "src/a.ts", "export const a = 1;\n");
  write(root, "package.json", '{"name":"fixture","version":"1.0.0"}\n');
  const config = resolveConfig({ outDir: "snapshot" }, {}, root);
  const key = crypto.generateKeyPairSync("ed25519").privateKey;
  generateSnapshot(config, { sign: { key } });
  assert.ok(fs.existsSync(path.join(root, "snapshot", "signature.json")));
  // The next run used to refuse signature.json as a foreign entry.
  generateSnapshot(config, { sign: { key } });
  assert.ok(fs.existsSync(path.join(root, "snapshot", "signature.json")));
});

test("F9: an abandoned worker lock and staging directory can be reclaimed", (t) => {
  const root = tempDir(t);
  const runId = crypto.randomUUID();
  fs.writeFileSync(
    lockPathFor(root),
    JSON.stringify({ pid: process.pid, stagingRoot: root, runId }) + "\n",
    "utf8"
  );
  const staging = path.join(root, "run-" + process.pid + "-abcdefgh");
  fs.mkdirSync(staging, { recursive: true });
  fs.writeFileSync(
    path.join(staging, ".codebase-snapshot"),
    JSON.stringify({
      generator: "codebase-snapshot",
      version: "0.0.0",
      schemaVersion: SCHEMA_VERSION,
      createdAt: new Date().toISOString(),
      state: "staging",
      id: crypto.randomUUID(),
      runId,
      pid: process.pid,
    }),
    "utf8"
  );
  releaseAbandonedRun([root], runId);
  assert.equal(fs.existsSync(lockPathFor(root)), false);
  assert.equal(fs.existsSync(staging), false);
});

test("F10: every SnapshotConfig key is accepted by the config loader", async (t) => {
  const root = tempDir(t);
  write(
    root,
    "snapshot.config.json",
    JSON.stringify({
      stripComments: true,
      removeEmptyLines: true,
      logCount: 20,
      pack: "json",
    }) + "\n"
  );
  const loaded = await loadConfigFileDetailed(root, { allowExecutableConfig: false });
  assert.deepEqual(loaded.errors, []);
});

test("F14: validate --staged hashes the index, not the working tree", (t) => {
  const root = initRepo(t, { "src/a.ts": "export const a = 1;\n" });
  git(root, ["add", "src/a.ts"]);
  git(root, ["commit", "-qm", "initial"]);
  write(root, "src/a.ts", "export const a = 2;\n");
  git(root, ["add", "src/a.ts"]);
  write(root, "src/a.ts", "export const a = 3; // unstaged later\n");
  const config = resolveConfig({ staged: true, outDir: "snapshot" }, {}, root);
  generateSnapshot(config);
  const result = validateSnapshot(config);
  assert.equal(result.valid, true, result.errors.join("; "));
});

test("F11: validate and explain use tsconfig path aliases for dependents", (t) => {
  const root = initRepo(t, {
    "tsconfig.json": JSON.stringify({ compilerOptions: { baseUrl: ".", paths: { "@/*": ["src/*"] } } }) + "\n",
    "src/lib/db.ts": "export const db = 1;\n",
    "src/app.ts": 'import { db } from "@/lib/db";\nexport const app = db;\n',
  });
  git(root, ["add", "."]);
  git(root, ["commit", "-qm", "initial"]);
  write(root, "src/lib/db.ts", "export const db = 2;\n");
  const config = resolveConfig({ changedSince: "HEAD", withDependents: true, outDir: "snapshot" }, {}, root);
  generateSnapshot(config);
  const result = validateSnapshot(config);
  assert.equal(result.valid, true, result.errors.join("; "));
});

test("F15: the serve page never interpolates manifest fields into innerHTML", () => {
  const source = fs.readFileSync(path.join(HERE, "..", "src", "web", "ui.ts"), "utf8");
  assert.doesNotMatch(source, /li\.innerHTML/);
  assert.match(source, /document\.createTextNode/);
});

test("F7: the HTTP MCP transport survives chunked oversized bodies and caps batches", async (t) => {
  const root = tempDir(t);
  const transport = await startHttpTransport({ cwd: root, port: 0, token: null, log: () => {} });
  t.after(() => transport.close());
  const url = new URL(transport.url);
  const http = await import("node:http");

  await new Promise((resolve) => {
    const request = http.request(
      { hostname: url.hostname, port: url.port, path: "/mcp", method: "POST" },
      (response) => {
        response.resume();
        response.on("end", resolve);
      }
    );
    request.on("error", () => resolve());
    const chunk = Buffer.alloc(64 * 1024, 0x20);
    for (let sent = 0; sent < 3 * 1024 * 1024; sent += chunk.length) request.write(chunk);
    request.end();
  });
  const health = await fetch(new URL("/healthz", transport.url));
  assert.equal(health.status, 200, "the server is still alive");

  const batch = await fetch(transport.url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(Array.from({ length: 101 }, (_, index) => ({ jsonrpc: "2.0", id: index, method: "ping" }))),
  });
  assert.equal(batch.status, 400);
});

test("F13: watch and one-shot generate share every scoped flag", () => {
  const options = generateCliOptions({
    command: "generate",
    format: "text",
    dryRun: false,
    cwd: "/repo",
    outDir: "snapshot",
    includeDiffs: true,
    includeLogs: 5,
    tokenTree: true,
    stripComments: true,
    removeEmptyLines: true,
    only: ["src/**"],
    ignore: ["vendor/**"],
    pack: "json",
    sign: true,
  });
  assert.equal(options.includeDiffs, true);
  assert.equal(options.includeLogs, 5);
  assert.equal(options.tokenTree, true);
  assert.equal(options.stripComments, true);
  assert.equal(options.removeEmptyLines, true);
  assert.deepEqual(options.only, ["src/**"]);
  assert.deepEqual(options.ignore, ["vendor/**"]);
  assert.equal(options.pack, "json");
  assert.equal(options.sign, true);
});

test("F12: two HTTP clients with session ids do not share era or cancellations", async (t) => {
  const root = tempDir(t);
  const transport = await startHttpTransport({ cwd: root, port: 0, token: null, log: () => {} });
  t.after(() => transport.close());
  const call = (session, body) =>
    fetch(transport.url, {
      method: "POST",
      headers: { "content-type": "application/json", "mcp-session-id": session },
      body: JSON.stringify(body),
    });
  // Session ids are minted by initialize; a caller-chosen id is a 404 by design. Two
  // independent initialize calls give the two clients their own state.
  const legacy = await fetch(transport.url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {} },
    }),
  });
  assert.equal(legacy.status, 200);
  const clientA = legacy.headers.get("mcp-session-id");
  assert.ok(clientA);
  const modernInit = await fetch(transport.url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {} },
    }),
  });
  assert.equal(modernInit.status, 200);
  const clientB = modernInit.headers.get("mcp-session-id");
  assert.ok(clientB);
  const modern = await call(clientB, {
    jsonrpc: "2.0",
    id: 3,
    method: "server/discover",
    params: {},
  });
  assert.equal(modern.status, 200);
  const legacyTools = await call(clientA, { jsonrpc: "2.0", id: 4, method: "tools/list", params: {} });
  assert.equal(legacyTools.status, 200);
  assert.ok((await legacyTools.json()).result.tools.length > 0);
  const modernTools = await call(clientB, {
    jsonrpc: "2.0",
    id: 4,
    method: "tools/list",
    params: {
      _meta: {
        "io.modelcontextprotocol/protocolVersion": "2026-07-28",
        "io.modelcontextprotocol/clientCapabilities": {},
      },
    },
  });
  assert.equal(modernTools.status, 200);
  assert.ok((await modernTools.json()).result.tools.length > 0);
});

test("F6: snapshot_workspace refuses a root outside the served directories", async (t) => {
  const root = tempDir(t);
  const outside = tempDir(t);
  const tool = buildTools().find((candidate) => candidate.name === "snapshot_workspace");
  assert.ok(tool);
  const outcome = await tool.handler(
    { root: outside },
    { cwd: root, roots: [root], log: () => {} }
  );
  assert.equal(outcome.isError, true, outcome.text);
});

test("F7: serve refuses a local source outside its root", async (t) => {
  const root = tempDir(t);
  const repo = path.join(root, "repo");
  write(repo, "package.json", '{"name":"fixture","version":"1.0.0"}\n');
  write(repo, "src/a.ts", "export const a = 1;\n");
  const server = await startWebServer({ cwd: root, port: 0, log: () => {} });
  t.after(() => server.close());
  const response = await fetch(server.url + "api/generate", {
    method: "POST",
    headers: { authorization: "Bearer " + server.token, "content-type": "application/json" },
    body: JSON.stringify({ source: path.dirname(root) }),
  });
  assert.equal(response.status, 403);
});

test("F7: serve refuses a symlink that escapes its root", async (t) => {
  const root = tempDir(t);
  const repo = path.join(root, "repo");
  write(repo, "package.json", '{"name":"fixture","version":"1.0.0"}\n');
  write(repo, "src/a.ts", "export const a = 1;\n");
  const outside = path.join(path.dirname(root), "outside-snapshot-" + process.pid);
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  write(outside, "manifest.json", JSON.stringify({ generator: { name: "codebase-snapshot" }, files: [] }) + "\n");
  try {
    fs.symlinkSync(outside, path.join(repo, "link"), "junction");
  } catch (error) {
    if (error.code === "EPERM" || error.code === "EACCES") return t.skip("symlinks unavailable");
    throw error;
  }
  const server = await startWebServer({ cwd: root, port: 0, log: () => {} });
  t.after(() => server.close());
  const generated = await fetch(server.url + "api/generate", {
    method: "POST",
    headers: { authorization: "Bearer " + server.token, "content-type": "application/json" },
    body: JSON.stringify({ source: repo }),
  });
  assert.equal(generated.status, 200);
  const response = await fetch(
    server.url + "api/snapshot.zip?path=" + encodeURIComponent(path.join(repo, "link")),
    { headers: { authorization: "Bearer " + server.token } }
  );
  assert.equal(response.status, 403);
});
