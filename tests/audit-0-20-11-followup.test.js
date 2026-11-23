import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import test from "node:test";

import {
  DEFAULT_SECRET_PATTERNS,
  auditSnapshot,
  generateSnapshot,
  globToRegExp,
  resolveConfig,
  scanAndRedactSecrets,
  startWebServer,
  validateSnapshot,
} from "../dist/index.js";
import { buildTools, createServer, startHttpTransport } from "../dist/mcp.js";
import { makeTempDir } from "./helpers/temp.js";

function makeRepo(t, files = {}) {
  const dir = makeTempDir(t, "audit-0-20-11-");
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "fixture", version: "1.0.0" }));
  for (const [relative, content] of Object.entries(files)) {
    const full = path.join(dir, relative);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  return dir;
}

function generate(dir, config = {}) {
  return generateSnapshot(resolveConfig({ outDir: "snapshot", ...config }, {}, dir));
}

function contextFor(dir, noConfig = true) {
  return { cwd: dir, roots: [dir], log: () => {}, ...(noConfig ? { noConfig: true } : {}) };
}

function tool(name) {
  const found = buildTools().find((candidate) => candidate.name === name);
  assert.ok(found, "tool exists: " + name);
  return found;
}

test("0.20.11 H1: a Dockerfile marker is idempotent under health", (t) => {
  const dir = makeRepo(t, { Dockerfile: "FROM alpine\nENV API_KEY=supersecret123\nENV DB_PASSWORD=replace-me\nENV SAFE_KEY=$API_KEY\n" });
  generate(dir);
  const report = auditSnapshot({ snapshotDir: path.join(dir, "snapshot"), repoDir: dir });
  assert.equal(report.checks.find((check) => check.id === "secrets.artifacts").status, "pass");
  assert.match(fs.readFileSync(path.join(dir, "snapshot", "parts", "part-001.md"), "utf8"), /DB_PASSWORD=replace-me/);
  assert.doesNotMatch(fs.readFileSync(path.join(dir, "snapshot", "parts", "part-001.md"), "utf8"), /supersecret123/);
});

test("0.20.11 H2: a quoted secret longer than the old 512-byte bound is masked", () => {
  for (const key of ["db_password", "password", "api_secret"]) {
    const value = "A".repeat(513);
    const out = scanAndRedactSecrets(`{"${key}":"${value}"}`, DEFAULT_SECRET_PATTERNS, "config.json");
    assert.ok(out.findings.length >= 1, key + " must be found");
    assert.equal(out.redacted.includes(value), false, key + " leaked");
  }
  const unquoted = "db_password = " + "A".repeat(513);
  const bare = scanAndRedactSecrets(unquoted, DEFAULT_SECRET_PATTERNS, "app.env");
  assert.ok(bare.findings.length >= 1);
  assert.equal(bare.redacted.includes("A".repeat(20)), false);
});

test("0.20.11 H3: commented and escaped unterminated PEM bodies are masked", () => {
  const commented = "// -----BEGIN RSA PRIVATE KEY-----\n// MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC\n// dGVzdGtleWJvZHlsaW5lMg==\n";
  const escaped = 'const k = "-----BEGIN PRIVATE KEY-----\\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC";';
  for (const [file, text] of [["a.ts", commented], ["b.ts", escaped]]) {
    const out = scanAndRedactSecrets(text, DEFAULT_SECRET_PATTERNS, file);
    assert.equal(out.redacted.includes("MIIEvQIBADANBg"), false, file + " leaked PEM material");
  }
});

test("0.20.11 H3: explain reloads preset closures in the worker", async (t) => {
  const dir = makeRepo(t, { "src/a.ts": "export const a = 1;\n" });
  generate(dir);
  const server = createServer({ cwd: dir, log: () => {} });
  await server.handle({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "t", version: "1" } } });
  const response = await server.handle({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "snapshot_explain", arguments: { path: "src/a.ts" } } });
  assert.notEqual(response.result.isError, true, response.result.content[0].text);
  assert.equal(response.result.structuredContent.included, true);
  assert.equal(response.result.structuredContent.layer, "src");
});

test("0.20.11 H2: a chain of unquantified alternations is refused", async (t) => {
  const dir = makeRepo(t, { "a.ts": "export const a = 1;\n" });
  generate(dir);
  const outcome = await tool("snapshot_search").handler({ query: "(\\w|\\S|.)".repeat(28) + "!", regex: true }, contextFor(dir));
  assert.equal(outcome.isError, true);
  assert.match(outcome.text, /alternations multiply/);
});

test("0.20.11 H4: sixteen wildcard groups are refused as a glob", () => {
  assert.throws(() => globToRegExp("*a".repeat(16) + "!"), /too complex/);
});

test("0.20.11 H1: a nested forged marker cannot hide files", async (t) => {
  const dir = makeRepo(t);
  const secret = "export const backdoor = 1;\n";
  const stub = "{}\n";
  fs.mkdirSync(path.join(dir, "src", "hidden"), { recursive: true });
  fs.writeFileSync(path.join(dir, "src", "hidden", "backdoor.ts"), secret);
  fs.writeFileSync(path.join(dir, "src", "hidden", "manifest.json"), stub);
  const sha = (value) => createHash("sha256").update(value).digest("hex");
  fs.writeFileSync(path.join(dir, "src", "hidden", ".codebase-snapshot"), JSON.stringify({
    generator: "codebase-snapshot", schemaVersion: "3.0.0", state: "complete", id: randomUUID(),
    manifestSha256: sha(stub),
    files: [
      { path: "backdoor.ts", bytes: Buffer.byteLength(secret), sha256: sha(secret) },
      { path: "manifest.json", bytes: Buffer.byteLength(stub), sha256: sha(stub) },
    ],
  }));
  const manifest = generate(dir);
  assert.equal(manifest.files.some((file) => file.relativePath === "src/hidden/backdoor.ts"), false);
  assert.ok(
    manifest.skipped.some(
      (record) => record.path === "src/hidden" && record.reason === "tool-output"
    ),
    "the forged marker must be visible in skipped[]"
  );
});

test("0.20.11 H5: validate accepts a snapshot generated without parts", (t) => {
  const dir = makeRepo(t, { "a.ts": "export const a = 1;\n" });
  const config = resolveConfig({ outDir: "snapshot", artifacts: { parts: false } }, {}, dir);
  generateSnapshot(config);
  const result = validateSnapshot(config);
  assert.equal(result.valid, true, JSON.stringify(result.drift.partIssues));
});

test("0.20.11 H4: workspace members inherit generation flags", (t) => {
  const rootDir = makeTempDir(t, "audit-0-20-11-ws-");
  fs.mkdirSync(path.join(rootDir, "a"));
  fs.writeFileSync(path.join(rootDir, "a", "package.json"), JSON.stringify({ name: "a" }));
  fs.writeFileSync(path.join(rootDir, "a", "x.ts"), "export const x = 1;\n");
  const result = spawnSync(process.execPath, [path.resolve("dist", "bin.js"), "generate", "--cwd", rootDir, "--workspace", "a", "--out-dir", "ws", "--max-part-bytes", "4096"], { encoding: "utf8", cwd: path.resolve("."), env: process.env });
  assert.equal(result.status, 0, result.stderr);
  const manifest = JSON.parse(fs.readFileSync(path.join(rootDir, "ws", "a", "manifest.json"), "utf8"));
  assert.equal(manifest.config.maxPartBytes, 4096);
});

test("0.20.11 H6: a batch is charged per JSON-RPC message and initialize mints a session", async (t) => {
  const dir = makeRepo(t, { "a.ts": "export const a = 1;\n" });
  const first = await startHttpTransport({ cwd: dir, port: 0, token: null, log: () => {} });
  t.after(() => first.close());
  const batch = Array.from({ length: 61 }, (_, index) => ({ jsonrpc: "2.0", id: index, method: "ping" }));
  const limited = await fetch(first.url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(batch) });
  assert.equal(limited.status, 429);
  const second = await startHttpTransport({ cwd: dir, port: 0, token: null, log: () => {} });
  t.after(() => second.close());
  const init = [{ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "t", version: "1" } } }];
  const initialized = await fetch(second.url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(init) });
  assert.equal(initialized.status, 200);
  assert.ok(initialized.headers.get("mcp-session-id"));
});

test("0.20.11 H7: an explicit false skeleton override is drift", async (t) => {
  const dir = makeRepo(t, { "a.ts": "export function a() { return 1; }\n" });
  generate(dir, { skeleton: true });
  const outcome = await tool("snapshot_validate").handler({ skeleton: false }, contextFor(dir));
  assert.equal(outcome.structured.current, false);
});

test("0.20.11 H7: ..notes.ts is inside the repository and replays deep", (t) => {
  const dir = makeRepo(t, { "..notes.ts": "export const n = 1;\n" });
  const manifest = generate(dir);
  assert.equal(manifest.files.some((file) => file.relativePath === "..notes.ts"), true);
  const report = auditSnapshot({ snapshotDir: path.join(dir, "snapshot"), repoDir: dir, deep: true });
  assert.equal(report.checks.find((check) => check.id === "fidelity.bodies").status, "pass");
});

test("0.20.11 H8: a commit subject containing a fence does not break the log report", (t) => {
  const dir = makeRepo(t, { "notes.md": "base\n" });
  const git = (...args) => execFileSync("git", ["-c", "user.email=a@b", "-c", "user.name=a", ...args], { cwd: dir, stdio: "ignore" });
  git("init", "-q");
  git("add", "-A");
  git("commit", "-qm", "base");
  fs.writeFileSync(path.join(dir, "notes.md"), "next\n");
  git("add", "-A");
  git("commit", "-qm", "subject with ``` fence");
  generate(dir, { artifacts: { log: true } });
  const log = fs.readFileSync(path.join(dir, "snapshot", "reports", "log.md"), "utf8");
  assert.equal(log.match(/^(`{3,})text/m)[1].length, 4);
  assert.match(log, /subject with ``` fence/);
});

test("0.20.11 H6: symbol parameters are bounded and structured data is cleared when clipped", () => {
  const symbol = buildTools().find((candidate) => candidate.name === "snapshot_symbol");
  assert.equal(symbol.inputSchema.properties.lines.maximum, 500);
  assert.equal(symbol.inputSchema.properties.maxFiles.maximum, 20);
  assert.equal(symbol.inputSchema.properties.maxReferences.maximum, 100);
});

test("0.20.11 H5: a malformed workspace index is a clean refusal, not a parser excerpt", (t) => {
  const dir = makeRepo(t);
  fs.mkdirSync(path.join(dir, "snapshot"), { recursive: true });
  fs.writeFileSync(path.join(dir, "snapshot", "WORKSPACE.json"), '{"members":');
  const result = spawnSync(process.execPath, [path.resolve("dist", "bin.js"), "health", "--all-members", "--cwd", dir, "--format", "json"], { encoding: "utf8", cwd: path.resolve("."), env: process.env });
  assert.notEqual(result.status, 0);
  const output = (result.stdout ?? "") + (result.stderr ?? "");
  assert.match(output, /WORKSPACE\.json is not valid JSON/);
  assert.doesNotMatch(output, /Unexpected end|Expected property name/);
});

test("0.20.11 H8: serve rejects a non-HTTP loopback origin", async (t) => {
  const dir = makeRepo(t);
  const server = await startWebServer({ cwd: dir, port: 0, token: null, log: () => {} });
  t.after(() => server.close());
  const response = await fetch(server.url + "/healthz", { headers: { origin: "file://localhost" } });
  assert.equal(response.status, 403);
});

test("0.20.11 H9: update is not advertised as accepting --no-update-check", () => {
  const docs = fs.readFileSync(path.resolve("docs", "cli.md"), "utf8");
  assert.match(docs, /all commands except `update`/);
});

test("0.20.11 H6: snapshot_symbol caps the whole response and clears duplicated bodies", async (t) => {
  const files = {};
  const body = "x".repeat(100);
  for (let index = 0; index < 10; index += 1) {
    files[`src/f${index}.ts`] = "export const wide = 1;\n" + (body + "\n").repeat(500);
  }
  const dir = makeRepo(t, files);
  generate(dir);
  const outcome = await tool("snapshot_symbol").handler({ name: "wide", lines: 500, maxFiles: 20, maxReferences: 100 }, contextFor(dir));
  assert.ok(Buffer.byteLength(outcome.text, "utf8") <= 65536);
  assert.ok(outcome.structured.matches.every((match) => match.text === ""));
});

test("0.20.11 H1: a forged marker in a git repository is visible rather than silent", (t) => {
  const dir = makeRepo(t);
  const secret = "export const backdoor = 1;\n";
  const stub = "{}\n";
  fs.mkdirSync(path.join(dir, "src", "hidden"), { recursive: true });
  fs.writeFileSync(path.join(dir, "src", "hidden", "backdoor.ts"), secret);
  fs.writeFileSync(path.join(dir, "src", "hidden", "manifest.json"), stub);
  const sha = (value) => createHash("sha256").update(value).digest("hex");
  fs.writeFileSync(path.join(dir, "src", "hidden", ".codebase-snapshot"), JSON.stringify({
    generator: "codebase-snapshot", schemaVersion: "3.0.0", state: "complete", id: randomUUID(),
    manifestSha256: sha(stub),
    files: [
      { path: "backdoor.ts", bytes: Buffer.byteLength(secret), sha256: sha(secret) },
      { path: "manifest.json", bytes: Buffer.byteLength(stub), sha256: sha(stub) },
    ],
  }));
  const git = (...args) => execFileSync("git", ["-c", "user.email=a@b", "-c", "user.name=a", ...args], { cwd: dir, stdio: "ignore" });
  git("init", "-q");
  git("add", "-A");
  git("commit", "-qm", "hostile marker");
  const manifest = generate(dir);
  assert.equal(manifest.files.some((file) => file.relativePath.includes("backdoor")), false);
  assert.ok(
    manifest.skipped.some((record) => record.path.startsWith("src/hidden/") && record.reason === "tool-output"),
    JSON.stringify(manifest.skipped)
  );
});
