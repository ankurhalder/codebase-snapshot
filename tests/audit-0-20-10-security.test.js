import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import test from "node:test";

import {
  DEFAULT_SECRET_PATTERNS,
  generateSnapshot,
  globToRegExp,
  isSensitivePath,
  resolveConfig,
  runInit,
  scanAndRedactSecrets,
  startWebServer,
  tsconfigPathsFor,
  validateSnapshot,
} from "../dist/index.js";
import {
  buildResourceProvider,
  buildTools,
  createServer,
  parsePartSections,
  startHttpTransport,
} from "../dist/mcp.js";
import { makeTempDir } from "./helpers/temp.js";

function makeRepo(t, files = {}, extra = {}) {
  const dir = makeTempDir(t, "audit-0-20-10-");
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "fixture", version: "1.0.0" }));
  fs.mkdirSync(path.join(dir, "src"), { recursive: true });
  fs.writeFileSync(path.join(dir, "src", "a.ts"), "export const a = 1;\n");
  for (const [relative, text] of Object.entries(files)) {
    const full = path.join(dir, relative);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, text);
  }
  if (extra.config !== undefined) fs.writeFileSync(path.join(dir, "snapshot.config.json"), JSON.stringify(extra.config));
  return dir;
}

function generate(dir, overrides = {}) {
  const config = resolveConfig({ outDir: "snapshot", ...overrides }, {}, dir);
  return generateSnapshot(config);
}

function contextFor(dir, noConfig = true) {
  return { cwd: dir, roots: [dir], log: () => {}, ...(noConfig ? { noConfig: true } : {}) };
}

function tool(name) {
  const found = buildTools().find((candidate) => candidate.name === name);
  assert.ok(found, "tool exists: " + name);
  return found;
}

test("0.20.10 F1: a parts junction outside the snapshot is refused", async (t) => {
  const dir = makeRepo(t);
  generate(dir);
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, "snapshot", "manifest.json"), "utf8"));
  const external = makeTempDir(t, "audit-0-20-10-external-");
  fs.writeFileSync(path.join(external, manifest.parts[0].filename), "HOST_SECRET_MARKER\n");
  const parts = path.join(dir, "snapshot", "parts");
  fs.rmSync(parts, { recursive: true, force: true });
  try {
    fs.symlinkSync(external, parts, "junction");
  } catch {
    t.skip("this filesystem does not allow creating junctions");
    return;
  }
  await assert.rejects(
    () => buildResourceProvider().read("snapshot://parts/1", contextFor(dir)),
    (error) => !String(error.message).includes("HOST_SECRET_MARKER")
  );
});

test("0.20.10 F2: a config outDir outside the served root is refused", async (t) => {
  const dir = makeRepo(t, {}, { config: { outDir: "../outside/snapshot" } });
  const outcome = await tool("snapshot_status").handler({}, contextFor(dir, false));
  assert.equal(outcome.isError, true);
  assert.match(outcome.text, /outDir/);
});

test("0.20.10 F3: a WORKSPACE.json symlink does not leak host bytes", async (t) => {
  const dir = makeRepo(t);
  generate(dir);
  const external = makeTempDir(t, "audit-0-20-10-workspace-");
  fs.writeFileSync(path.join(external, "env"), "DB_PASS=TOP_SECRET_VALUE\n");
  try {
    fs.symlinkSync(path.join(external, "env"), path.join(dir, "WORKSPACE.json"));
  } catch {
    t.skip("this filesystem does not allow creating symlinks");
    return;
  }
  const outcome = await tool("snapshot_health").handler({ maxScanBytes: 1024 * 1024 }, contextFor(dir));
  assert.doesNotMatch(outcome.text, /TOP_SECRET_VALUE/);
});

test("0.20.10 F12: a signature.json symlink does not leak host bytes", async (t) => {
  const dir = makeRepo(t);
  generate(dir);
  const external = makeTempDir(t, "audit-0-20-10-signature-");
  fs.writeFileSync(path.join(external, "signature"), "TOP_SECRET_SIGNATURE_BYTES\n");
  try {
    fs.symlinkSync(path.join(external, "signature"), path.join(dir, "snapshot", "signature.json"));
  } catch {
    t.skip("this filesystem does not allow creating symlinks");
    return;
  }
  const outcome = await tool("snapshot_health").handler({ maxScanBytes: 1024 * 1024 }, contextFor(dir));
  assert.doesNotMatch(outcome.text, /TOP_SECRET_SIGNATURE_BYTES/);
});

test("0.20.10 F4: optional chains and backreferences are refused", async (t) => {
  const dir = makeRepo(t);
  generate(dir);
  for (const query of ["(.|.)?".repeat(30) + "\\0", "(.+)\\1{1,200}!"]) {
    const outcome = await tool("snapshot_search").handler({ query, regex: true }, contextFor(dir));
    assert.equal(outcome.isError, true, query);
  }
});

test("0.20.10 F5: an outside tsconfig extends is not loaded", (t) => {
  const dir = makeRepo(t);
  const outside = makeTempDir(t, "audit-0-20-10-tsconfig-");
  fs.writeFileSync(path.join(outside, "base.json"), JSON.stringify({ compilerOptions: { paths: { "@x/*": ["./x/*"] } } }));
  fs.writeFileSync(path.join(dir, "tsconfig.json"), JSON.stringify({ extends: "../" + path.basename(outside) + "/base.json", include: ["../**/*"] }));
  assert.equal(tsconfigPathsFor(dir), null);
});

test("0.20.10 F6/F36: a probe does not lock the era, and a pre-init ping does not strand modern", async () => {
  const server = createServer({ cwd: process.cwd(), noConfig: true, log: () => {} });
  const discover = await server.handle({ jsonrpc: "2.0", id: 1, method: "server/discover" });
  assert.equal(discover.result.resultType, "complete");
  assert.equal(server.session.era, null, "the probe itself must not commit the era");
  const init = await server.handle({ jsonrpc: "2.0", id: 2, method: "initialize", params: { protocolVersion: "2025-11-25" } });
  assert.equal(init.result.protocolVersion, "2025-11-25");
  const second = createServer({ cwd: process.cwd(), noConfig: true, log: () => {} });
  await second.handle({ jsonrpc: "2.0", id: 3, method: "ping" });
  const meta = { "io.modelcontextprotocol/protocolVersion": "2026-07-28", "io.modelcontextprotocol/clientCapabilities": {} };
  const modern = await second.handle({ jsonrpc: "2.0", id: 4, method: "tools/list", params: { _meta: meta } });
  assert.equal(modern.result.resultType, "complete");
});

test("0.20.10 F8/F22/F23/F27: the audited redaction shapes do not leak", () => {
  const rules = DEFAULT_SECRET_PATTERNS;
  const cases = [
    ["src/db.ts", "// \"note\nexport const key = [\n  \"-----BEGIN PRIVATE KEY-----\",\n  \"MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7VJTUt9Us8cKj\",\n  \"-----END PRIVATE KEY-----\",\n];\n", "MIIEvQIBADAN"],
    ["src/db.ts", "export const env = `\nDB_PASSWORD=superSecretProdPassword99\napi_key: live_key_abc123456789\n`;\n", "superSecretProdPassword99"],
    ["app.py", "tag = b\"auth:\"; api_key = \"liveSecretValue99\"\n", "liveSecretValue99"],
    ["deploy.yaml", "items:\n  - api_secret: |\n      prod-k8s-secret-987654321\n", "prod-k8s-secret-987654321"],
    ["Dockerfile.prod", "ENV API_KEY prod-docker-secret-987654321\n", "prod-docker-secret-987654321"],
    ["app.ts", "password = \"liveSecret999 [REDACTED: potential secret-like value omitted from snapshot]\"\n", "liveSecret999"],
  ];
  for (const [file, content, secret] of cases) {
    const out = scanAndRedactSecrets(content, rules, file);
    assert.equal(out.redacted.includes(secret), false, file + " leaked " + secret + ": " + out.redacted);
  }
});

test("0.20.10 F10: a marker substring does not suppress a finding", () => {
  const out = scanAndRedactSecrets(
    "password = \"liveSecret999\" // [REDACTED: potential secret-like value omitted from snapshot]\n",
    DEFAULT_SECRET_PATTERNS,
    "app.ts"
  );
  assert.equal(out.redacted.includes("liveSecret999"), false);
  assert.ok(out.findings.length >= 1);
});

test("0.20.10 F7: snapshot_answer caps the whole response", async (t) => {
  const dir = makeRepo(t);
  const body = "x".repeat(30 * 1024) + "\n";
  for (let index = 0; index < 6; index += 1) {
    fs.writeFileSync(path.join(dir, "src", "large" + index + ".ts"), "export const v" + index + " = \"" + body + "\";\n");
  }
  generate(dir);
  const outcome = await tool("snapshot_answer").handler({ question: "large", maxTokens: 200000, linesPerFile: 2000 }, contextFor(dir));
  assert.ok(Buffer.byteLength(outcome.text, "utf8") <= 64 * 1024);
  assert.ok(Buffer.byteLength(JSON.stringify(outcome.structured), "utf8") < 64 * 1024);
});

test("0.20.10 F16: a partial health scan is a warning, not a pass", async (t) => {
  const dir = makeRepo(t);
  generate(dir);
  const outcome = await tool("snapshot_health").handler({ maxScanBytes: 1024 }, contextFor(dir));
  const checks = outcome.structured.checks;
  const artifacts = checks.find((check) => check.id === "secrets.artifacts");
  assert.notEqual(artifacts.status, "pass");
});

test("0.20.10 F24: a file replaced by a directory is drift", (t) => {
  const dir = makeRepo(t, { "src/a.ts": "export const a = 1;\n" });
  generate(dir);
  fs.rmSync(path.join(dir, "src", "a.ts"));
  fs.mkdirSync(path.join(dir, "src", "a.ts"));
  const result = validateSnapshot(resolveConfig({ outDir: "snapshot" }, {}, dir));
  assert.equal(result.valid, false);
});

test("0.20.10 F26: a filename in the Files list cannot hijack the section parser", () => {
  const part = [
    "## Files",
    "",
    "````text",
    "### FILE: a.ts",
    "#### Content",
    "````",
    "",
    "## Contents",
    "",
    "<a id=\"x\"></a>",
    "### FILE: ### FILE: a.ts",
    "#### Content",
    "",
    "````",
    "body",
    "````",
  ].join("\n");
  const sections = parsePartSections(part);
  assert.equal(sections.length, 1);
  assert.equal(sections[0].path, "### FILE: a.ts");
  assert.equal(sections[0].body, "body");
});

test("0.20.10 F28: backup suffixes and credential-directory examples stay sensitive", () => {
  for (const name of [".kube/config.bak", ".docker/config.json~", ".terraform/credentials.tfrc.json.old", ".ssh/id_rsa.example"]) {
    assert.equal(isSensitivePath(name), true, name);
  }
  assert.equal(isSensitivePath(".env.example"), false);
});

test("0.20.10 F35: an empty first line stays paginated", async (t) => {
  const dir = makeRepo(t, { "data.txt": "\n" + "x".repeat(70000) + "\nok\n" });
  generate(dir, { maxPartBytes: 300 * 1024, largeFileBytes: 300 * 1024 });
  const outcome = await tool("snapshot_read").handler({ path: "data.txt" }, contextFor(dir));
  assert.equal(outcome.structured.pageable, true);
  assert.equal(outcome.structured.nextFromLine, 2);
});

test("0.20.10 F25: init writes a JSON config the MCP server can open", async (t) => {
  const dir = makeRepo(t);
  const io = { input: { isTTY: false }, output: { isTTY: false, write() {} } };
  const init = await runInit({ cwd: dir, yes: true, io });
  assert.equal(init.configPath.endsWith("snapshot.config.json"), true);
  const server = createServer({ cwd: dir, log: () => {} });
  await server.handle({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25" } });
  const response = await server.handle({
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: { name: "snapshot_explain", arguments: { path: "src/a.ts" } },
  });
  assert.doesNotMatch(response.result.content[0].text, /executable config|was not loaded/);
});

test("0.20.10 F34: more than 64 custom secret rules are refused", async () => {
  const { assertServerSafeConfig } = await import("../dist/index.js");
  assert.throws(
    () => assertServerSafeConfig({ secrets: { customPatterns: Array.from({ length: 65 }, () => "x") } }, "fixture"),
    /64/
  );
});

test("0.20.10 F29: the MCP HTTP CORS response exposes mcp-session-id", async (t) => {
  const dir = makeRepo(t);
  const transport = await startHttpTransport({ cwd: dir, port: 0, token: null, log: () => {} });
  t.after(() => transport.close());
  const response = await fetch(transport.url + "/mcp", {
    method: "POST",
    headers: { "content-type": "application/json", origin: "http://localhost:3000" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25" } }),
  });
  assert.match(response.headers.get("access-control-expose-headers") ?? "", /mcp-session-id/);
});

test("0.20.10 F13: snapshot.zip refuses a directory with only a PWA manifest", async (t) => {
  const dir = makeRepo(t, { "manifest.json": JSON.stringify({ name: "pwa" }), ".env": "SECRET=1\n" });
  const server = await startWebServer({ cwd: dir, port: 0, token: null, log: () => {} });
  t.after(() => server.close());
  const response = await fetch(server.url + "/api/snapshot.zip?path=.");
  assert.notEqual(response.status, 200);
  const bytes = Buffer.from(await response.arrayBuffer());
  assert.equal(bytes.includes(Buffer.from(".env")), false);
});

test("0.20.10 F19: an explicit false skeleton override is honored", async (t) => {
  const dir = makeRepo(t, {}, { config: { skeleton: true } });
  fs.writeFileSync(path.join(dir, "src", "a.ts"), "export function a() { return 1; }\n");
  const outcome = await tool("snapshot_generate").handler({ skeleton: false }, contextFor(dir, false));
  assert.notEqual(outcome.isError, true);
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, "snapshot", "manifest.json"), "utf8"));
  assert.ok(!manifest.config.skeleton, "the explicit false override must win");
});

test("0.20.10 F9: diff hunk prefixes do not defeat format-aware redaction", (t) => {
  const dir = makeRepo(t);
  const git = (...args) => execFileSync("git", ["-c", "user.email=a@b", "-c", "user.name=a", ...args], { cwd: dir, stdio: "ignore" });
  git("init", "-q");
  fs.writeFileSync(path.join(dir, "deploy.yaml"), "api_secret: placeholder\n");
  fs.writeFileSync(path.join(dir, "Dockerfile"), "ENV API_KEY placeholder\n");
  git("add", "-A");
  git("commit", "-qm", "base");
  fs.writeFileSync(path.join(dir, "deploy.yaml"), "api_secret: |\n  SECRET_YAML_VALUE\n");
  fs.writeFileSync(path.join(dir, "Dockerfile"), "ENV API_KEY SECRET_DOCKER_VALUE\n");
  generateSnapshot(resolveConfig({ outDir: "snapshot", artifacts: { diff: true } }, {}, dir));
  const diff = fs.readFileSync(path.join(dir, "snapshot", "reports", "diff.md"), "utf8");
  assert.doesNotMatch(diff, /SECRET_YAML_VALUE/);
  assert.doesNotMatch(diff, /SECRET_DOCKER_VALUE/);
});

test("0.20.10 F11: an exponential glob is refused before compilation", () => {
  assert.throws(() => globToRegExp("{?,?,?}".repeat(25) + "!"), /too complex/);
  assert.throws(() => globToRegExp("*a".repeat(25) + "*b"), /too complex/);
});

test("0.20.10 F15: raising maxPartBytes is configuration drift", async (t) => {
  const dir = makeRepo(t, {}, { config: { maxPartBytes: "120k" } });
  const generated = await tool("snapshot_generate").handler({}, contextFor(dir, false));
  assert.notEqual(generated.isError, true);
  const configPath = path.join(dir, "snapshot.config.json");
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  config.maxPartBytes = "300k";
  fs.writeFileSync(configPath, JSON.stringify(config));
  const validated = await tool("snapshot_validate").handler({}, contextFor(dir, false));
  assert.equal(validated.structured.current, false);
});

test("0.20.10 F20: run 1 and run 2 skip the same snapshot directory", (t) => {
  const dir = makeRepo(t, { "src/a.ts": "export const a = 1;\n" });
  const git = (...args) => execFileSync("git", ["-c", "user.email=a@b", "-c", "user.name=a", ...args], { cwd: dir, stdio: "ignore" });
  git("init", "-q");
  fs.writeFileSync(path.join(dir, ".gitignore"), "/snapshot/\n");
  git("add", "-A");
  git("commit", "-qm", "base");
  const first = generate(dir);
  const second = generate(dir);
  assert.deepEqual(second.skipped, first.skipped);
});

test("0.20.10 F21: a transformed monolith body is not labelled full", (t) => {
  const dir = makeRepo(t, { "src/a.ts": "// keep-check\nexport const x = 1;\n" });
  generate(dir, { stripComments: true, pack: "json", includeMonolith: true });
  const pack = JSON.parse(fs.readFileSync(path.join(dir, "snapshot", "full-codebase.json"), "utf8"));
  const entry = pack.files.find((file) => file.relativePath === "src/a.ts");
  assert.notEqual(entry.inclusionMode, "full");
});

test("0.20.10 F31: a slice question is masked before it reaches the manifest", (t) => {
  const dir = makeRepo(t, { ".env": "APP_SECRET=knownCandidate123\n" });
  const config = resolveConfig({ outDir: "snapshot" }, {}, dir);
  const manifest = generateSnapshot(config, { slice: { question: "APP_SECRET=knownCandidate123" } });
  assert.equal(JSON.stringify(manifest.slice?.question ?? "").includes("knownCandidate123"), false);
});

test("0.20.10 F14: .git/config cannot be used as the owner brief", (t) => {
  const dir = makeRepo(t);
  fs.mkdirSync(path.join(dir, ".git"), { recursive: true });
  fs.writeFileSync(path.join(dir, ".git", "config"), "[core]\n\trepositoryformatversion = 0\n");
  assert.throws(() => resolveConfig({ brief: ".git/config" }, {}, dir), /ignored|built-in/i);
});

test("0.20.10 F17: an outside root is one refusal, not an existence oracle", async (t) => {
  const dir = makeRepo(t);
  const outside = [
    path.join(path.parse(process.cwd()).root, "Windows", "System32", "drivers", "etc", "hosts"),
    path.join(path.parse(process.cwd()).root, "Windows", "System32"),
    path.join(path.parse(process.cwd()).root, "Windows", "System32", "audit-no-such-path-xyz"),
  ];
  const messages = [];
  for (const root of outside) {
    const outcome = await tool("snapshot_status").handler({ root }, contextFor(dir));
    assert.equal(outcome.isError, true);
    messages.push(outcome.text);
  }
  for (const message of messages) {
    assert.match(message, /resolves outside the directories this server may read/);
    assert.doesNotMatch(message, /does not exist|is not a directory/i);
  }
});
