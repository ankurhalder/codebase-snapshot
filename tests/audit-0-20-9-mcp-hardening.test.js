import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { spawnSync } from "node:child_process";

import { loadConfigFileDetailed, startWebServer } from "../dist/index.js";
import {
  buildResourceProvider,
  buildTools,
  createMcpServer,
  startHttpTransport,
} from "../dist/mcp.js";

const BIN = path.resolve("dist/bin.js");

function makeRepo(t, files = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-hardening-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.writeFileSync(path.join(root, "package.json"), '{"name":"fixture","version":"1.0.0"}\n');
  fs.writeFileSync(
    path.join(root, "src", "a.ts"),
    'export const a = "' + "a".repeat(60) + '";\nexport const b = 2;\n'
  );
  for (const [relative, text] of Object.entries(files)) {
    const full = path.join(root, relative);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, text);
  }
  return root;
}

function contextFor(root) {
  return { cwd: root, roots: [root], log: () => {} };
}

function toolMap() {
  return new Map(buildTools().map((tool) => [tool.name, tool]));
}

async function call(name, args, context) {
  const tool = toolMap().get(name);
  assert.ok(tool, "tool exists: " + name);
  return tool.handler(args, context);
}

const rpc = (id, method, params) => ({ jsonrpc: "2.0", id, method, params });

test("regex checker refuses both audited bypass shapes and stays fast", async (t) => {
  const root = makeRepo(t);
  const context = contextFor(root);
  await call("snapshot_generate", {}, context);
  const patterns = [
    "{z|(.+)+!|}",
    "{((a+)+)$}",
    ".{1,10000}.{1,10000}.{1,10000}!",
    ".{1,200}.{1,200}!",
  ];
  for (const query of patterns) {
    const started = Date.now();
    const result = await call("snapshot_search", { query, regex: true }, context);
    assert.equal(result.isError, true, "refused: " + query);
    assert.match(result.text, /refused|complex|repetition/i);
    assert.ok(Date.now() - started < 500, "refusal is immediate: " + query);
  }
  const safe = await call("snapshot_search", { query: "(ab)+", regex: true }, context);
  assert.equal(safe.isError, undefined, "an ordinary repeated group still runs");
});

test("an unknown HTTP session id is rejected and cannot fill the session table", async (t) => {
  const root = makeRepo(t);
  const transport = await startHttpTransport({ cwd: root, port: 0, token: null, log: () => {} });
  t.after(() => transport.close());
  const headers = { "content-type": "application/json" };
  // Stay below the 60/10s rate limit while proving that caller-chosen ids are never stored.
  for (let index = 0; index < 50; index += 1) {
    const response = await fetch(transport.url, {
      method: "POST",
      headers: { ...headers, "mcp-session-id": "filler-" + index },
      body: JSON.stringify(rpc(index, "ping")),
    });
    assert.equal(response.status, 404);
  }
  const initialized = await fetch(transport.url, {
    method: "POST",
    headers,
    body: JSON.stringify(rpc(100, "initialize", { protocolVersion: "2025-06-18", capabilities: {} })),
  });
  assert.equal(initialized.status, 200, await initialized.clone().text());
  const sessionId = initialized.headers.get("mcp-session-id");
  assert.ok(sessionId, "initialize still mints a session");
  const listed = await fetch(transport.url, {
    method: "POST",
    headers: { ...headers, "mcp-session-id": sessionId },
    body: JSON.stringify(rpc(101, "tools/list")),
  });
  assert.equal(listed.status, 200, await listed.clone().text());
  assert.ok((await listed.json()).result.tools.length >= 20);
  const deleted = await fetch(transport.url, {
    method: "DELETE",
    headers: { ...headers, "mcp-session-id": sessionId },
  });
  assert.equal(deleted.status, 204);
  const gone = await fetch(transport.url, {
    method: "POST",
    headers: { ...headers, "mcp-session-id": sessionId },
    body: JSON.stringify(rpc(102, "tools/list")),
  });
  assert.equal(gone.status, 404);
});

test("a modern stateless request works without server/discover", async (t) => {
  const root = makeRepo(t);
  const server = createMcpServer({
    info: { name: "fixture", title: "fixture", version: "0.0.0", websiteUrl: "https://example.test" },
    instructions: "",
    tools: [],
    resources: { list: async () => [], templates: () => [], read: async () => null },
    prompts: [],
    context: contextFor(root),
  });
  const response = await server.handle({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/list",
    params: {
      _meta: {
        "io.modelcontextprotocol/protocolVersion": "2026-07-28",
        "io.modelcontextprotocol/clientCapabilities": {},
      },
    },
  });
  assert.equal(response.result.resultType, "complete");
  assert.deepEqual(response.result.tools, []);
});

test("a JSON config loads beside an executable config without running it", async (t) => {
  const root = makeRepo(t, {
    "snapshot.config.ts":
      'import fs from "node:fs"; fs.writeFileSync("EXECUTED", "yes"); export default {};\n',
    "snapshot.config.json": '{"outDir":"json-out"}\n',
  });
  const loaded = await loadConfigFileDetailed(root, { allowExecutableConfig: false });
  assert.deepEqual(loaded.errors, []);
  assert.equal(loaded.config.outDir, "json-out");
  assert.equal(fs.existsSync(path.join(root, "EXECUTED")), false, "the .ts config never ran");
  const status = await call("snapshot_status", {}, contextFor(root));
  assert.equal(status.isError, undefined, status.text);
});

test("mcp accepts --no-config in the published contract", () => {
  const run = spawnSync(process.execPath, [BIN, "describe", "--format", "json"], {
    encoding: "utf8",
    timeout: 15000,
    windowsHide: true,
  });
  assert.equal(run.status, 0, run.stderr);
  const contract = JSON.parse(run.stdout);
  const option = contract.options.find((entry) => entry.flag === "--no-config");
  assert.ok(option, "the contract lists --no-config");
  assert.match(option.appliesTo, /mcp/);
});

test("MCP refuses sensitive-file and unsafe-regex configs instead of honoring them", async (t) => {
  const sensitive = makeRepo(t, {
    ".env": "API_KEY=ghp_123456789012345678901234567890123456\n",
    "snapshot.config.json": JSON.stringify({ includeSensitiveFiles: true }) + "\n",
  });
  const refused = await call("snapshot_generate", {}, contextFor(sensitive));
  assert.equal(refused.isError, true);
  assert.match(refused.text, /includeSensitiveFiles/);
  assert.equal(fs.existsSync(path.join(sensitive, "snapshot")), false);

  const unsafe = makeRepo(t, {
    "snapshot.config.json": JSON.stringify({
      secrets: { customPatterns: ["(a+)+$"] },
    }) + "\n",
  });
  const regexRefused = await call("snapshot_generate", {}, contextFor(unsafe));
  assert.equal(regexRefused.isError, true);
  assert.match(regexRefused.text, /unsafe custom secret regex/);
});

test("health applies a project custom secret rule to written parts", async (t) => {
  const root = makeRepo(t, {
    "snapshot.config.json": JSON.stringify({
      secrets: { customPatterns: [{ rule: "corp", pattern: "CORP-[A-Z0-9]{8}" }] },
    }) + "\n",
  });
  const context = contextFor(root);
  const generated = await call("snapshot_generate", {}, context);
  assert.equal(generated.isError, undefined, generated.text);
  assert.equal(generated.structured.validationStatus, "passed");
  const partsDir = path.join(root, "snapshot", "parts");
  const part = fs.readdirSync(partsDir).find((name) => name.endsWith(".md"));
  assert.ok(part, "a part was written");
  fs.appendFileSync(path.join(partsDir, part), "\nCORP-ABCD1234\n");
  const health = await call("snapshot_health", {}, context);
  const check = health.structured.checks.find((item) => item.id === "secrets.artifacts");
  assert.equal(check.status, "fail", "the custom token is detected");
});

test("snapshot_read omits nextFromLine when the whole file was returned", async (t) => {
  const root = makeRepo(t);
  const context = contextFor(root);
  await call("snapshot_generate", {}, context);
  const whole = await call("snapshot_read", { path: "src/a.ts" }, context);
  assert.equal(whole.isError, undefined, whole.text);
  assert.equal(Object.prototype.hasOwnProperty.call(whole.structured, "nextFromLine"), false);
  const partial = await call("snapshot_read", { path: "src/a.ts", lines: 1 }, context);
  assert.equal(partial.structured.nextFromLine, 2);
});

test("snapshot_plan accepts numeric byte and token budgets", async (t) => {
  const root = makeRepo(t);
  const context = contextFor(root);
  for (const args of [{ maxPartBytes: 120000 }, { maxPartTokens: 32000 }]) {
    const result = await call("snapshot_plan", args, context);
    assert.doesNotMatch(result.text, /must be a string/);
    assert.equal(result.isError, undefined, result.text);
  }
});

test("a token-budget snapshot validates current without replaying the flag", async (t) => {
  const root = makeRepo(t, {
    "src/long.ts": "export const long = 1;\n".repeat(200),
  });
  const context = contextFor(root);
  const generated = await call("snapshot_generate", { maxPartTokens: "8k" }, context);
  assert.equal(generated.isError, undefined, generated.text);
  const validated = await call("snapshot_validate", {}, context);
  assert.equal(validated.structured.current, true, validated.text);
});

test("known but absent resources answer -32002, not -32602", async (t) => {
  const root = makeRepo(t);
  const server = createMcpServer({
    info: { name: "fixture", title: "fixture", version: "0.0.0", websiteUrl: "https://example.test" },
    instructions: "",
    tools: [],
    resources: buildResourceProvider(),
    prompts: [],
    context: contextFor(root),
  });
  await server.handle({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2025-06-18", capabilities: {} },
  });
  for (const uri of ["snapshot://manifest", "snapshot://parts/1"]) {
    const response = await server.handle({
      jsonrpc: "2.0",
      id: 2,
      method: "resources/read",
      params: { uri },
    });
    assert.equal(response.error.code, -32002, uri);
    assert.notEqual(response.error.code, -32602, uri);
  }
});

test("snapshot_review caps a single huge line and bounds linesPerFile", async (t) => {
  const root = makeRepo(t);
  fs.writeFileSync(
    path.join(root, "src", "huge.ts"),
    'export const huge = "' + "x".repeat(150 * 1024) + '";\n'
  );
  const context = contextFor(root);
  await call("snapshot_generate", {}, context);
  const reviewed = await call(
    "snapshot_review",
    { paths: ["src/huge.ts"], linesPerFile: 999999 },
    context
  );
  assert.equal(reviewed.isError, undefined, reviewed.text);
  assert.ok(Buffer.byteLength(reviewed.text, "utf8") < 80 * 1024, "response is bounded");
  assert.match(reviewed.text, /response capped/i);
});

test("serve exposes the shared MCP session and SSE endpoints", async (t) => {
  const root = makeRepo(t);
  const server = await startWebServer({ cwd: root, port: 0, log: () => {} });
  t.after(() => server.close());
  const auth = { authorization: "Bearer " + server.token, "content-type": "application/json" };
  const initialized = await fetch(server.url + "mcp", {
    method: "POST",
    headers: auth,
    body: JSON.stringify(rpc(1, "initialize", { protocolVersion: "2025-06-18", capabilities: {} })),
  });
  assert.equal(initialized.status, 200, await initialized.clone().text());
  const sessionId = initialized.headers.get("mcp-session-id");
  assert.ok(sessionId, "serve returns the MCP session id");
  const listed = await fetch(server.url + "mcp", {
    method: "POST",
    headers: { ...auth, "mcp-session-id": sessionId },
    body: JSON.stringify(rpc(2, "tools/list")),
  });
  assert.equal(listed.status, 200, await listed.clone().text());
  assert.ok((await listed.json()).result.tools.length >= 20);

  const controller = new AbortController();
  t.after(() => controller.abort());
  const stream = await fetch(server.url + "sse?token=" + server.token, {
    headers: { accept: "text/event-stream" },
    signal: controller.signal,
  });
  assert.equal(stream.status, 200);
  assert.match(String(stream.headers.get("content-type")), /text\/event-stream/);
});

test("the audited expensive tools are labelled expensive", () => {
  const tools = toolMap();
  assert.equal(tools.get("snapshot_explain").cost, "expensive");
  assert.equal(tools.get("snapshot_validate").cost, "expensive");
});

test("snapshot_generate reports a cancelled early request as cancelled", async (t) => {
  const root = makeRepo(t);
  const context = {
    ...contextFor(root),
    onCancel: (cancel) => cancel(),
  };
  const result = await call("snapshot_plan", {}, context);
  assert.equal(result.isError, true);
  assert.match(result.text, /cancelled/i);
});

test("the CLI accepts mcp --no-config without a config file", (t) => {
  const root = makeRepo(t);
  const run = spawnSync(process.execPath, [BIN, "mcp", "--no-config", "--cwd", root], {
    cwd: root,
    input: "",
    encoding: "utf8",
    timeout: 15000,
    windowsHide: true,
  });
  assert.equal(run.status, 0, run.stderr);
});
